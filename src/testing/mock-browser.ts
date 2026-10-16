import type { HumanControllable, HumanInput, LiveFrame } from "../execution/human-input.js";
import type { StorageState } from "../execution/login-state.js";
import { StaleRefError, type BrowserAdapter, type ElementInfo, type PageSnapshot } from "../execution/browser-adapter.js";

export interface MockElement {
  role: "button" | "link" | "textbox";
  name: string;
  tag?: string;
  inputType?: string | null;
  insideForm?: boolean;
  goto?: string;
  effect?: string;
  /** Text added to the page after clicking. */
  sets?: string;
  /** A submit button of a GET form to the same site (a search box). */
  readOnlyForm?: boolean;
}

interface Page {
  content: string;
  /** Refs are assigned in order: e1, e2, ... */
  elements?: MockElement[];
}

/** Deterministic in-memory browser. `effects` records real-world side effects for assertions. */
export class MockBrowser implements BrowserAdapter, HumanControllable {
  readonly humanInputs: HumanInput[] = [];
  async liveFrame(): Promise<LiveFrame> {
    return { data: Buffer.from("mock-frame"), mime: "image/jpeg", width: 1280, height: 800 };
  }
  /** What captureLoginState returns; tests set it to stand in for a signed-in browser. */
  loginState: { origin: string; state: StorageState } | undefined;
  async captureLoginState(): Promise<{ origin: string; state: StorageState }> {
    if (!this.loginState) throw new Error("no login in this mock browser");
    return this.loginState;
  }
  async applyInput(input: HumanInput): Promise<void> {
    this.humanInputs.push(input);
  }

  url = "about:blank";
  readonly effects: string[] = [];
  readonly clicks: string[] = [];
  readonly typed: Array<{ ref: string; text: string }> = [];
  readonly scrolls: Array<"down" | "up"> = [];
  readonly selected: Array<{ ref: string; option: string }> = [];
  private extra = "";
  constructor(private readonly pages: Record<string, Page>) {}

  currentUrl() {
    return this.url;
  }

  async goto(url: string) {
    if (!this.pages[url]) throw new Error(`net::ERR_NAME_NOT_RESOLVED ${url}`);
    this.url = url;
    this.extra = "";
  }

  private element(ref: string): MockElement {
    const m = /^e(\d+)$/.exec(ref);
    const el = m ? this.pages[this.url]?.elements?.[Number(m[1]) - 1] : undefined;
    if (!el) throw new StaleRefError(`Unknown ref ${ref}`);
    return el;
  }

  async click(ref: string) {
    const el = this.element(ref);
    this.clicks.push(el.name);
    if (el.effect) this.effects.push(el.effect);
    if (el.sets) this.extra += `\n- text "${el.sets}"`;
    if (el.goto) await this.goto(el.goto);
  }

  async type(ref: string, text: string) {
    this.element(ref);
    this.typed.push({ ref, text });
  }

  readonly pasted: Array<{ ref: string; html: string; text: string }> = [];
  async pasteRich(ref: string, html: string, text: string) {
    this.element(ref);
    this.pasted.push({ ref, html, text });
  }

  /** Set to false to simulate a page already scrolled to its end. */
  canScroll = true;
  async scroll(direction: "down" | "up") {
    this.scrolls.push(direction);
    return { moved: this.canScroll };
  }

  async select(ref: string, option: string) {
    this.element(ref);
    this.selected.push({ ref, option });
  }

  async inspect(ref: string): Promise<ElementInfo> {
    const el = this.element(ref);
    return {
      ref,
      role: el.role,
      name: el.name,
      tag: el.tag ?? (el.role === "textbox" ? "input" : el.role === "link" ? "a" : "button"),
      inputType: el.inputType ?? null,
      insideForm: el.insideForm ?? false,
      formMethod: null,
      formAction: null,
      formSameOriginGet: el.readOnlyForm ?? false,
      href: null,
      download: false,
    };
  }

  async snapshot(): Promise<PageSnapshot> {
    const page = this.pages[this.url];
    const els = (page?.elements ?? []).map((e, i) => `\n- ${e.role} "${e.name}" [ref=e${i + 1}]`).join("");
    return { url: this.url, ariaSnapshot: (page?.content ?? "") + els + this.extra };
  }

  async readState(): Promise<PageSnapshot> {
    const page = this.pages[this.url];
    const els = (page?.elements ?? []).map((e) => `\n- ${e.role} "${e.name}"`).join("");
    return { url: this.url, ariaSnapshot: (page?.content ?? "") + els + this.extra };
  }

  /** Not a real image: deterministic bytes that change whenever the page does. */
  async screenshot(): Promise<{ data: Buffer; mime: "image/jpeg" }> {
    return { data: Buffer.from(`mock-screenshot|${this.url}|${this.extra}|clicks=${this.clicks.length}`), mime: "image/jpeg" };
  }

  async close() {}
}
