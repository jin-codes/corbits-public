import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { EgressProxy } from "./egress-proxy.js";
import { isPrivateAddress, isPrivateHostname } from "./network.js";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Route } from "playwright";
import {
  NavigationBlockedError,
  StaleRefError,
  type BrowserAdapter,
  type ElementInfo,
  type PageSnapshot,
} from "./browser-adapter.js";
import type { HumanControllable, HumanInput, LiveFrame } from "./human-input.js";
import { filterStorageState, type StorageState } from "./login-state.js";

export interface RemoteBrowserOptions extends Omit<PlaywrightBrowserOptions, "blockHostPorts"> {
  /** ws:// endpoint of the sandboxed browser container, including its secret path. */
  wsEndpoint: string;
}

export interface ChromeAttachOptions extends Omit<PlaywrightBrowserOptions, "blockHostPorts"> {
  /** http://127.0.0.1:PORT of a Chrome started with --remote-debugging-port and its own --user-data-dir. */
  cdpUrl: string;
}

export interface PlaywrightBrowserOptions {
  /** If set, top-level navigations are limited to these origins (e.g. "https://example.com"). */
  allowedOrigins?: readonly string[];
  /** Allow loopback and private-network targets. Off by default (SSRF protection); tests turn it on. */
  allowPrivateNetwork?: boolean;
  /** Extra "host:port" targets the egress proxy must refuse (mainly for tests). */
  blockHostPorts?: readonly string[];
  navigationTimeoutMs?: number;
  actionTimeoutMs?: number;
  /** Start already signed in: cookies and local storage to load into the new browser context. */
  storageState?: StorageState;
}

interface RefEntry {
  role: string;
  name: string;
}

// `- button "Name" [attr] [ref=e4]:`  (name optional; refs look like e4 or f1e2)
const REF_LINE = /^\s*- ([\w-]+)(?: "((?:[^"\\]|\\.)*)")?[^\n]*?\[ref=([a-z0-9]+)\]/;
const unescape = (s: string | undefined) => (s ? s.replace(/\\(.)/g, "$1") : "");

export function parseRefs(yaml: string): Map<string, RefEntry> {
  const refs = new Map<string, RefEntry>();
  for (const line of yaml.split("\n")) {
    const m = REF_LINE.exec(line);
    if (m) refs.set(m[3]!, { role: m[1]!, name: unescape(m[2]) });
  }
  return refs;
}

export { isPrivateAddress };

/**
 * Runs in every frame of our page before the site's own scripts. Draws a faint, click-through
 * border (and a small label) in a closed shadow root so the owner can see the agent is driving
 * this tab. It has no text node and no accessible content, so it never reaches the model's
 * snapshot, `find`, or the verifier's page text. Top frame only.
 */
const AGENT_OVERLAY_SCRIPT = `(() => {
  if (window.top !== window) return;
  const w = window;
  if (w.__corbitsOverlay) return;
  let host = null;
  const build = () => {
    host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = '<style>' +
      '.b{position:fixed;inset:0;pointer-events:none;box-shadow:inset 0 0 0 3px rgba(99,102,241,.35),inset 0 0 28px rgba(99,102,241,.16);animation:p 2.4s ease-in-out infinite}' +
      '.b::after{content:"Corbits is working";position:fixed;top:8px;right:12px;font:500 11px/1 system-ui,sans-serif;color:rgba(67,56,202,.85);background:rgba(238,242,255,.8);padding:5px 8px;border-radius:999px}' +
      '@keyframes p{50%{opacity:.55}}' +
      '@media (prefers-reduced-motion:reduce){.b{animation:none}}' +
      '</style><div class="b"></div>';
    return host;
  };
  const apply = (on) => {
    w.__corbitsOverlayOn = on;
    const root = document.documentElement;
    if (!root) return;
    if (on) { if (!host) build(); if (!host.isConnected) root.appendChild(host); }
    else if (host && host.isConnected) host.remove();
  };
  w.__corbitsOverlay = apply;
  const wanted = typeof w.__corbitsAgentDriving === "function" ? w.__corbitsAgentDriving() : Promise.resolve(true);
  Promise.resolve(wanted).then((on) => { apply(on !== false); document.addEventListener("DOMContentLoaded", () => apply(w.__corbitsOverlayOn !== false)); }).catch(() => apply(true));
})();`;

/**
 * Playwright-backed BrowserAdapter. Pages are exposed to the model only as accessibility
 * snapshots with refs; the model can never run script in the page. The adapter blocks
 * non-http(s) navigations, optionally restricts origins, and blocks private-network targets.
 * Hostname checks cannot stop DNS rebinding; real network isolation belongs to the container.
 */
export class PlaywrightBrowser implements BrowserAdapter, HumanControllable {
  private refs = new Map<string, RefEntry>();
  /** Bumped on every frame navigation; refs from an earlier epoch are never trusted. */
  private navEpoch = 0;
  private snapshotEpoch = -1;
  private readonly dnsCache = new Map<string, boolean>();
  readonly blocked: string[] = [];
  readonly popupsClosed: string[] = [];
  readonly dialogsDismissed: string[] = [];
  /** Whether the agent (not a person) is driving; the on-page border follows it. */
  private agentDriving = true;

  private constructor(
    /** Present only when this process launched the browser itself (local mode). */
    private readonly proxy: EgressProxy | null,
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly opts: Required<Omit<PlaywrightBrowserOptions, "allowedOrigins" | "blockHostPorts" | "storageState">> & { allowedOrigins: readonly string[] | undefined },
    /**
     * True when the context belongs to someone else's Chrome (attach mode). Then the guard covers
     * only our own tab, only popups our tab opened are closed, and close() leaves the browser alone.
     */
    private readonly shared = false,
  ) {}

  static async launch(options: PlaywrightBrowserOptions = {}): Promise<PlaywrightBrowser> {
    const proxy = await EgressProxy.start({
      allowPrivateNetwork: options.allowPrivateNetwork ?? false,
      ...(options.blockHostPorts ? { blockHostPorts: options.blockHostPorts } : {}),
    });
    // Force all traffic (including loopback and every redirect hop) through the egress proxy.
    const browser = await chromium.launch({
      headless: true,
      args: [`--proxy-server=${proxy.url}`, "--proxy-bypass-list=<-loopback>"],
    });
    try {
      const context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
        viewport: { width: 1280, height: 800 },
        permissions: [],
        ...(options.storageState ? { storageState: options.storageState } : {}),
      });
      const page = await context.newPage();
      const opts = {
        allowedOrigins: options.allowedOrigins,
        allowPrivateNetwork: options.allowPrivateNetwork ?? false,
        navigationTimeoutMs: options.navigationTimeoutMs ?? 30_000,
        actionTimeoutMs: options.actionTimeoutMs ?? 5_000,
      };
      const adapter = new PlaywrightBrowser(proxy, browser, context, page, opts);
      await adapter.install();
      return adapter;
    } catch (err) {
      await browser.close();
      await proxy.close();
      throw err;
    }
  }

  /**
   * Attaches to the sandboxed browser container instead of launching Chromium on this machine.
   * Network egress is enforced by the gateway container, not here; the checks in this class
   * (origin allowlist, scheme rules, ref handling) still apply on top.
   */
  static async connect(options: RemoteBrowserOptions): Promise<PlaywrightBrowser> {
    const browser = await chromium.connect(options.wsEndpoint, { timeout: 15_000 });
    try {
      const context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
        viewport: { width: 1280, height: 800 },
        permissions: [],
        ...(options.storageState ? { storageState: options.storageState } : {}),
      });
      const page = await context.newPage();
      const opts = {
        allowedOrigins: options.allowedOrigins,
        allowPrivateNetwork: options.allowPrivateNetwork ?? false,
        navigationTimeoutMs: options.navigationTimeoutMs ?? 30_000,
        actionTimeoutMs: options.actionTimeoutMs ?? 5_000,
      };
      const adapter = new PlaywrightBrowser(null, browser, context, page, opts);
      await adapter.install();
      return adapter;
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
  }

  /**
   * Attaches to the user's own Chrome (started with --remote-debugging-port and a dedicated
   * --user-data-dir) and works in a NEW tab, so it inherits that profile's logins. There is no
   * container and no egress proxy here: the origin allowlist, scheme rules and approvals still
   * apply, but redirects and subresources are not policed by the network. Local use only.
   */
  static async attach(options: ChromeAttachOptions): Promise<PlaywrightBrowser> {
    const browser = await chromium.connectOverCDP(options.cdpUrl, { timeout: 10_000 });
    try {
      const context = browser.contexts()[0];
      if (!context) throw new Error("Chrome exposed no browser context to attach to");
      const page = await context.newPage();
      const opts = {
        allowedOrigins: options.allowedOrigins,
        allowPrivateNetwork: options.allowPrivateNetwork ?? false,
        navigationTimeoutMs: options.navigationTimeoutMs ?? 30_000,
        actionTimeoutMs: options.actionTimeoutMs ?? 5_000,
      };
      const adapter = new PlaywrightBrowser(null, browser, context, page, opts, true);
      await adapter.install();
      return adapter;
    } catch (err) {
      await browser.close().catch(() => {}); // only disconnects: the user's Chrome keeps running
      throw err;
    }
  }

  /** Requests the egress proxy refused (private targets, explicit blocks). */
  get proxyBlocked(): readonly string[] {
    return this.proxy?.blocked ?? [];
  }

  /** Shows or hides the "agent is working" border on the open page and on pages opened later. */
  async setAgentDriving(on: boolean): Promise<void> {
    this.agentDriving = on;
    await this.page.evaluate((v) => (window as unknown as { __corbitsOverlay?: (on: boolean) => void }).__corbitsOverlay?.(v), on).catch(() => {});
  }

  private async install() {
    // Purely visual and best effort: a failure here must never stop a task.
    try {
      await this.page.exposeFunction("__corbitsAgentDriving", () => this.agentDriving);
      await this.page.addInitScript(AGENT_OVERLAY_SCRIPT);
    } catch {
      /* no overlay */
    }
    // In someone else's Chrome the guard must not touch their other tabs, so it is scoped to ours.
    await (this.shared ? this.page : this.context).route("**/*", (route) => void this.guard(route));
    // Single-tab model: popups are closed rather than followed.
    this.context.on("page", (p) => {
      if (p === this.page) return;
      if (!this.shared) {
        this.popupsClosed.push(p.url());
        void p.close();
        return;
      }
      // Tabs the user opens themselves are none of our business; only close what our tab opened.
      void p.opener().then((opener) => {
        if (opener === this.page) {
          this.popupsClosed.push(p.url());
          void p.close();
        }
      }).catch(() => {});
    });
    this.page.on("framenavigated", () => {
      this.navEpoch++;
    });
    this.page.on("dialog", (d) => {
      this.dialogsDismissed.push(d.message());
      void d.dismiss();
    });
  }

  // ---- network guard ---------------------------------------------------------------------

  private async guard(route: Route) {
    const req = route.request();
    const url = req.url();
    const reason = await this.blockReason(url, req.isNavigationRequest());
    if (reason) {
      this.blocked.push(`${reason}: ${url}`);
      await route.abort("blockedbyclient");
    } else {
      await route.continue();
    }
  }

  /** Returns why a request must be blocked, or null if it may proceed. */
  private async blockReason(rawUrl: string, isNavigation: boolean): Promise<string | null> {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      return "invalid url";
    }
    if (u.protocol === "about:" && rawUrl === "about:blank") return null;
    if (u.protocol === "data:" || u.protocol === "blob:") return isNavigation ? "navigation to data/blob url" : null;
    if (u.protocol !== "http:" && u.protocol !== "https:") return `scheme ${u.protocol}`;
    if (isNavigation && this.opts.allowedOrigins && !this.opts.allowedOrigins.includes(u.origin)) return "origin not allowed";
    if (!this.opts.allowPrivateNetwork && (await this.isPrivateHost(u.hostname))) return "private network";
    return null;
  }

  private async isPrivateHost(hostname: string): Promise<boolean> {
    const h = hostname.toLowerCase();
    if (isPrivateHostname(h)) return true;
    if (isIP(h.replace(/^\[|\]$/g, ""))) return isPrivateAddress(h);
    const cached = this.dnsCache.get(h);
    if (cached !== undefined) return cached;
    let priv = true; // unresolvable: fail closed
    try {
      const addrs = await lookup(h, { all: true });
      priv = addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address));
    } catch {
      priv = true;
    }
    this.dnsCache.set(h, priv);
    return priv;
  }

  // ---- BrowserAdapter ---------------------------------------------------------------------

  currentUrl(): string {
    return this.page.url();
  }

  async goto(url: string): Promise<void> {
    const reason = await this.blockReason(url, true);
    if (reason) throw new NavigationBlockedError(`Navigation blocked (${reason})`);
    this.refs = new Map();
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: this.opts.navigationTimeoutMs });
    await this.settle();
    await this.enforceOrigin();
  }

  async click(ref: string): Promise<void> {
    const loc = await this.resolve(ref);
    this.refs = new Map(); // the page is about to change; all old refs are invalid
    await loc.click({ timeout: this.opts.actionTimeoutMs });
    await this.settle();
    await this.enforceOrigin();
  }

  async type(ref: string, text: string): Promise<void> {
    const loc = await this.resolve(ref);
    await loc.fill(text, { timeout: this.opts.actionTimeoutMs });
    await this.settle();
  }

  /**
   * Replaces the content of an editor with a document by dispatching a paste event that carries it as
   * text/html and text/plain. The script is fixed; the document is passed as data, never evaluated.
   */
  async pasteRich(ref: string, html: string, text: string): Promise<void> {
    const loc = await this.resolve(ref);
    await loc.focus({ timeout: this.opts.actionTimeoutMs });
    await loc.press("ControlOrMeta+a", { timeout: this.opts.actionTimeoutMs });
    await loc.evaluate(
      (el, doc) => {
        const data = new DataTransfer();
        data.setData("text/html", doc.html);
        data.setData("text/plain", doc.text);
        el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      },
      { html, text },
    );
    await this.settle();
  }

  async scroll(direction: "down" | "up"): Promise<{ moved: boolean }> {
    const height = this.page.viewportSize()?.height ?? 720;
    // Pages such as Naver blogs scroll inside an iframe, so add up the scroll offset of every frame
    // (fixed scripts of ours, nothing from the model); a frame that cannot be read counts as zero.
    const position = async () => {
      let total = 0;
      for (const frame of this.page.frames()) {
        total += await frame.evaluate(() => Math.round(document.scrollingElement?.scrollTop ?? window.scrollY)).catch(() => 0);
      }
      return total;
    };
    const before = await position();
    await this.page.mouse.move(100, 100);
    await this.page.mouse.wheel(0, (direction === "down" ? 1 : -1) * Math.round(height * 0.9));
    // Content that loads on scroll: wait for the network to settle, but only briefly.
    await this.page.waitForLoadState("networkidle", { timeout: 1_500 }).catch(() => {});
    await this.page.waitForTimeout(250);
    return { moved: (await position()) !== before };
  }

  async select(ref: string, option: string): Promise<void> {
    const loc = await this.resolve(ref);
    this.refs = new Map(); // choosing an option can change the page
    await loc.selectOption({ label: option }, { timeout: this.opts.actionTimeoutMs });
    await this.settle();
    await this.enforceOrigin();
  }

  async snapshot(): Promise<PageSnapshot> {
    const yaml = await this.page.ariaSnapshot({ mode: "ai" });
    this.refs = parseRefs(yaml);
    this.snapshotEpoch = this.navEpoch;
    return { url: this.page.url(), ariaSnapshot: yaml };
  }

  async readState(): Promise<PageSnapshot> {
    // Any ariaSnapshot call (even default mode) invalidates outstanding refs, so verification
    // reads rendered text with a fixed script instead. Main frame only.
    // Frames too: some sites (Naver blogs) keep the whole article in an iframe.
    const parts: string[] = [];
    for (const frame of this.page.frames()) {
      const text = await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (text) parts.push(text);
    }
    return { url: this.page.url(), ariaSnapshot: parts.join("\n") };
  }

  async screenshot(): Promise<{ data: Buffer; mime: "image/jpeg" }> {
    // Viewport only (bounded size), JPEG to keep a long task's evidence small. Screenshots do not
    // touch the accessibility tree, so the model's refs stay valid.
    const data = await this.page.screenshot({ type: "jpeg", quality: 70, animations: "disabled", caret: "hide", timeout: 10_000 });
    return { data, mime: "image/jpeg" };
  }

  async captureLoginState(): Promise<{ origin: string; state: StorageState }> {
    // storageState() lists every site's cookies in this context; keep only the open page's own site.
    const raw = await this.context.storageState();
    return filterStorageState(raw as StorageState, this.page.url());
  }

  async liveFrame(): Promise<LiveFrame> {
    // Like screenshot(), this never touches the accessibility tree, so the agent's refs stay valid.
    // CSS-pixel scale keeps frames small and coordinates 1:1 even on a high-density display.
    const data = await this.page.screenshot({ type: "jpeg", quality: 55, animations: "disabled", caret: "initial", scale: "css", timeout: 10_000 });
    // A tab in someone else's Chrome has no fixed emulated viewport, so ask the page.
    const size = this.page.viewportSize() ?? (await this.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })));
    return { data, mime: "image/jpeg", width: size.width, height: size.height };
  }

  async applyInput(input: HumanInput): Promise<void> {
    if (this.agentDriving) await this.setAgentDriving(false);
    switch (input.type) {
      case "click":
        await this.page.mouse.click(input.x, input.y, { clickCount: input.double ? 2 : 1 });
        return;
      case "text":
        await this.page.keyboard.type(input.text);
        return;
      case "key":
        await this.page.keyboard.press(input.key);
        return;
      case "scroll":
        await this.page.mouse.move(input.x, input.y);
        await this.page.mouse.wheel(input.dx, input.dy);
        return;
    }
  }

  async inspect(ref: string): Promise<ElementInfo> {
    const loc = await this.resolve(ref);
    const entry = this.refs.get(ref)!;
    const dom = await loc.evaluate(
      (el) => {
        const e = el as HTMLElement & { type?: string; form?: HTMLFormElement | null };
        const form = e.closest("form") as HTMLFormElement | null;
        const a = e.closest("a") as HTMLAnchorElement | null;
        return {
          tag: e.tagName.toLowerCase(),
          inputType: typeof e.type === "string" ? e.type : null,
          insideForm: form !== null,
          formMethod: form ? form.method : null,
          formAction: form ? form.action : null,
          formSameOriginGet: (() => {
            if (!form) return false;
            try {
              return (
                form.method.toLowerCase() === "get" &&
                new URL(form.action, location.href).origin === location.origin &&
                form.querySelector('input[type="password"], input[type="file"]') === null
              );
            } catch {
              return false; // anything we cannot read is treated as not safe
            }
          })(),
          href: a ? a.href : null,
          download: a ? a.hasAttribute("download") : false,
        };
      },
      undefined,
      { timeout: this.opts.actionTimeoutMs },
    );
    return { ref, role: entry.role, name: entry.name, ...dom };
  }

  async close(): Promise<void> {
    if (this.shared) {
      // Close only our tab, then disconnect. The user's Chrome and their tabs stay as they were.
      await this.page.close().catch(() => {});
      await this.browser.close().catch(() => {});
      return;
    }
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
    await this.proxy?.close().catch(() => {});
  }

  // ---- internals --------------------------------------------------------------------------

  /**
   * Resolves a ref from the latest snapshot. Playwright gives an element a new ref whenever its
   * accessible name changes and never shifts existing refs when siblings are inserted, so an
   * outdated ref either still points at the same element or no longer resolves. The one hole is
   * navigation: numbering restarts on a new document, so refs from before any navigation
   * (including script-triggered ones) are rejected outright.
   */
  private async resolve(ref: string): Promise<Locator> {
    if (!this.refs.has(ref)) {
      throw new StaleRefError(`Unknown ref "${ref}". Take a new snapshot and use a ref from it.`);
    }
    if (this.snapshotEpoch !== this.navEpoch) {
      throw new StaleRefError("The page navigated since the last snapshot. Take a new snapshot.");
    }
    const loc = this.page.locator(`aria-ref=${ref}`);
    if ((await loc.count()) === 0) {
      throw new StaleRefError(`Ref "${ref}" no longer exists on the page. Take a new snapshot.`);
    }
    return loc;
  }

  /**
   * Redirects and link clicks can land on an origin outside the allowlist without passing the
   * request guard. If that happens, leave the page and fail the action.
   */
  private async enforceOrigin() {
    const allowed = this.opts.allowedOrigins;
    if (!allowed) return;
    const url = this.page.url();
    if (url === "about:blank") return;
    let origin = "";
    try {
      origin = new URL(url).origin;
    } catch {
      /* treated as disallowed below */
    }
    if (!allowed.includes(origin)) {
      this.blocked.push(`landed on disallowed origin: ${url}`);
      this.refs = new Map();
      await this.page.goto("about:blank").catch(() => {});
      throw new NavigationBlockedError(`Navigation ended on a disallowed origin (${origin || "unknown"})`);
    }
  }

  private async settle() {
    await this.page.waitForLoadState("load", { timeout: 5_000 }).catch(() => {});
  }
}
