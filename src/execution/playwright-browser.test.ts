import { existsSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { classifyClick, classifyType } from "../tools/browser-tools.js";
import { NavigationBlockedError, StaleRefError } from "./browser-adapter.js";
import { EgressProxy } from "./egress-proxy.js";
import { PlaywrightBrowser, isPrivateAddress, parseRefs } from "./playwright-browser.js";

describe("parseRefs", () => {
  it("extracts role, name and ref, including frame refs and escaped quotes", () => {
    const refs = parseRefs(
      [
        '- generic [active] [ref=e1]:',
        '  - button "Say \\"hi\\"" [ref=e2]',
        '  - link "Next" [ref=e3] [cursor=pointer]:',
        '    - /url: "#x"',
        '  - iframe [ref=e4]:',
        '    - button "Inner" [ref=f1e2]',
      ].join("\n"),
    );
    expect(refs.get("e2")).toEqual({ role: "button", name: 'Say "hi"' });
    expect(refs.get("e3")).toEqual({ role: "link", name: "Next" });
    expect(refs.get("e1")).toEqual({ role: "generic", name: "" });
    expect(refs.get("f1e2")).toEqual({ role: "button", name: "Inner" });
    expect(refs.size).toBe(5);
  });
});

describe("isPrivateAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.0.1", "172.31.255.255", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"])(
    "%s is private",
    (a) => expect(isPrivateAddress(a)).toBe(true),
  );
  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700::1111"])("%s is public", (a) =>
    expect(isPrivateAddress(a)).toBe(false),
  );
});

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const PAGES: Record<string, string> = {
  "/": `<title>Home</title><h1>Shop</h1>
    <a href="/done">Next page</a>
    <button id="h" onclick="document.title='harmless-clicked'">Harmless</button>
    <button id="rename" onclick="document.getElementById('victim').textContent='Delete account'">Rename</button>
    <button id="victim">Save draft</button>
    <input aria-label="Email"><input type="password" aria-label="Account password">
    <form method="post" action="/submit"><input aria-label="Note"><button>Save</button></form>
    <button onclick="window.open('/done')">Popup</button>
    <button onclick="alert('hello')">Alert</button>`,
  "/forms": `<title>Forms</title><h1>Forms</h1>
    <form method="get" action="/done"><input aria-label="Lookup"><button>Look up</button></form>
    <form action="/done"><input aria-label="Implicit"><button>Go implicit</button></form>
    <form method="get" action="http://example.invalid/collect"><input aria-label="Elsewhere"><button>Go elsewhere</button></form>
    <form method="get" action="/done"><input type="password" aria-label="Secret"><button>Go with password</button></form>
    <form method="post" action="/done"><input aria-label="Posted"><button>Go posting</button></form>
    <form method="get" action="/done"><input aria-label="Remover"><button>Delete everything</button></form>`,
  "/covered": `<title>Covered</title><h1>Covered</h1>
    <button id="target" onclick="document.title='target-clicked'">Confirm order</button>
    <div id="cover" onclick="document.title='cover-clicked'" style="position:fixed;inset:0;background:#fff;opacity:0.9">Cookie banner</div>`,
  "/framed": `<title>Framed</title><body style="margin:0"><iframe style="border:0;width:100%;height:300px" srcdoc="<body style='margin:0'><p>Article text inside a frame</p><div style='height:3000px'></div></body>"></iframe>`,
  "/done": `<title>Done</title><h1>Done</h1>`,
  "/submitted": `<title>Submitted</title><h1>Submitted</h1>`,
  "/redirect": ``,
};

describe.skipIf(!hasChromium)("PlaywrightBrowser (real Chromium, local test server)", () => {
  let server: http.Server;
  let origin: string;
  const submissions: string[] = [];
  let redirectTarget = "http://127.0.0.1:1/";
  const browsers: PlaywrightBrowser[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/submit") {
        submissions.push("submit");
        res.writeHead(303, { location: "/submitted" }).end();
        return;
      }
      if (req.url === "/redirect") {
        res.writeHead(302, { location: redirectTarget }).end();
        return;
      }
      const body = PAGES[req.url ?? "/"];
      if (body === undefined) return void res.writeHead(404).end("nope");
      res.writeHead(200, { "content-type": "text/html" }).end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => void server.close());
  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((b) => b.close()));
  });

  const open = async (opts: Parameters<typeof PlaywrightBrowser.launch>[0] = { allowPrivateNetwork: true }) => {
    const b = await PlaywrightBrowser.launch(opts);
    browsers.push(b);
    return b;
  };
  const refOf = (yaml: string, role: string, name: string) => {
    const m = new RegExp(`- ${role} "${name}"[^\\n]*\\[ref=([a-z0-9]+)\\]`).exec(yaml);
    if (!m) throw new Error(`no ${role} "${name}" in snapshot`);
    return m[1]!;
  };

  it("navigates, snapshots with refs, clicks a link, and reads state", async () => {
    const b = await open();
    await b.goto(`${origin}/`);
    const snap = await b.snapshot();
    expect(snap.ariaSnapshot).toContain('heading "Shop"');
    await b.click(refOf(snap.ariaSnapshot, "link", "Next page"));
    expect((await b.readState()).url).toBe(`${origin}/done`);
    expect((await b.readState()).ariaSnapshot).toContain("Done");
  });

  it("draws a click-through 'agent is working' border that the model never sees, and hides it for a person", async () => {
    const b = await open();
    await b.goto(`${origin}/`);
    const page = (b as unknown as { page: import("playwright").Page }).page;
    const probe = () =>
      page.evaluate(() => {
        const el = Array.from(document.documentElement.children).find((e) => e.getAttribute("aria-hidden") === "true" && (e as HTMLElement).style.zIndex === "2147483647") as HTMLElement | undefined;
        return el ? { pointerEvents: el.style.pointerEvents, text: el.textContent, inText: document.body.innerText.includes("Corbits is working") } : null;
      });
    const on = await probe();
    expect(on).toEqual({ pointerEvents: "none", text: "", inText: false });
    expect((await b.snapshot()).ariaSnapshot).not.toContain("Corbits");
    await b.setAgentDriving(false);
    expect(await probe()).toBeNull();
    await b.goto(`${origin}/done`); // a person is driving: pages opened meanwhile stay clean
    expect(await probe()).toBeNull();
    await b.setAgentDriving(true);
    expect(await probe()).not.toBeNull();
  });

  it("readState does not invalidate the refs the model is holding", async () => {
    const b = await open();
    await b.goto(`${origin}/`);
    const snap = await b.snapshot();
    const ref = refOf(snap.ariaSnapshot, "button", "Harmless");
    await b.readState();
    await expect(b.inspect(ref)).resolves.toMatchObject({ role: "button", name: "Harmless" });
  });

  it("takes a real JPEG screenshot without invalidating the refs the model holds", async () => {
    const b = await open();
    await b.goto(`${origin}/`);
    const { ariaSnapshot: s } = await b.snapshot();
    const shot = await b.screenshot();
    expect(shot.mime).toBe("image/jpeg");
    expect([...shot.data.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(shot.data.length).toBeGreaterThan(1000);
    expect(shot.data.length).toBeLessThan(2 * 1024 * 1024);
    await expect(b.inspect(refOf(s, "button", "Harmless"))).resolves.toMatchObject({ name: "Harmless" });
  });

  it("types into inputs and inspects elements for risk classification", async () => {
    const b = await open();
    await b.goto(`${origin}/`);
    const { ariaSnapshot: s } = await b.snapshot();

    const save = await b.inspect(refOf(s, "button", "Save"));
    expect(save).toMatchObject({ tag: "button", inputType: "submit", insideForm: true, formMethod: "post" });
    expect(save.formAction).toBe(`${origin}/submit`);
    expect(classifyClick({ ...save })).toBe("consequential"); // form submit

    expect(classifyClick({ ...(await b.inspect(refOf(s, "link", "Next page"))) })).toBe("low");
    expect(classifyClick({ ...(await b.inspect(refOf(s, "button", "Harmless"))) })).toBe("low");

    const email = refOf(s, "textbox", "Email");
    expect(classifyType({ ...(await b.inspect(email)) })).toBe("low");
    expect(classifyType({ ...(await b.inspect(refOf(s, "textbox", "Account password"))) })).toBe("consequential");
    await b.type(email, "a@example.com");
    expect(classifyClick(undefined)).toBe("consequential");
    expect(classifyClick({ inspectionFailed: true })).toBe("consequential");
  });

  it("rejects unknown and outdated refs instead of acting on another element", async () => {
    const b = await open();
    await b.goto(`${origin}/`);
    await expect(b.click("e999")).rejects.toBeInstanceOf(StaleRefError);

    const { ariaSnapshot: s } = await b.snapshot();
    const link = refOf(s, "link", "Next page");
    await b.click(link); // navigates; every old ref is now invalid
    await expect(b.click(link)).rejects.toBeInstanceOf(StaleRefError);
    await expect(b.inspect(link)).rejects.toBeInstanceOf(StaleRefError);
  });

  it("refuses a ref whose element changed after the snapshot", async () => {
    const b = await open();
    await b.goto(`${origin}/`);
    const { ariaSnapshot: s } = await b.snapshot();
    const victim = refOf(s, "button", "Save draft");
    await b.click(refOf(s, "button", "Rename")).catch(() => {});
    // click() clears refs, so re-snapshot, mutate via the page itself, and try the stale ref.
    const s2 = (await b.snapshot()).ariaSnapshot;
    expect(s2).toContain("Delete account");
    await expect(b.inspect(victim)).rejects.toBeInstanceOf(StaleRefError);
  });

  it("does not click a target that another element covers, and does not click the cover instead", async () => {
    const b = await open({ allowPrivateNetwork: true, actionTimeoutMs: 1_500 });
    await b.goto(`${origin}/covered`);
    const { ariaSnapshot: s } = await b.snapshot();
    await expect(b.click(refOf(s, "button", "Confirm order"))).rejects.toThrow();
    // Neither the target nor the cover received the click.
    const t = await (b as unknown as { page: { title(): Promise<string> } }).page.title();
    expect(t).toBe("Covered");
  });

  it("reports scrolling that happens inside a frame, and reads a frame's text when verifying", async () => {
    const b = await open();
    await b.goto(`${origin}/framed`);
    await b.snapshot();
    expect((await b.scroll("down")).moved).toBe(true);
    expect((await b.readState()).ariaSnapshot).toContain("Article text inside a frame");
  });

  it("does not submit a form until its button is clicked", async () => {
    const b = await open();
    const before = submissions.length;
    await b.goto(`${origin}/`);
    const { ariaSnapshot: s } = await b.snapshot();
    await b.type(refOf(s, "textbox", "Note"), "hello");
    expect(submissions.length).toBe(before);
  });

  it("closes popups and dismisses dialogs", async () => {
    const b = await open();
    await b.goto(`${origin}/`);
    const { ariaSnapshot: s } = await b.snapshot();
    await b.click(refOf(s, "button", "Popup"));
    await new Promise((r) => setTimeout(r, 300));
    expect(b.popupsClosed.length).toBe(1);
    const s2 = (await b.snapshot()).ariaSnapshot;
    await b.click(refOf(s2, "button", "Alert"));
    expect(b.dialogsDismissed).toEqual(["hello"]);
  });

  it("blocks private networks, non-http schemes and data navigations by default", async () => {
    const b = await open({});
    for (const url of [`${origin}/`, "http://localhost:3000/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "file:///etc/passwd", "data:text/html,<h1>x</h1>"]) {
      await expect(b.goto(url)).rejects.toBeInstanceOf(NavigationBlockedError);
    }
  });

  it("blocks a redirect into a forbidden target at the network layer", async () => {
    // Server B stands in for something like a cloud metadata endpoint.
    let hitsOnB = 0;
    const secret = http.createServer((_req, res) => {
      hitsOnB++;
      res.end("SECRET-METADATA");
    });
    await new Promise<void>((r) => secret.listen(0, "127.0.0.1", r));
    const bPort = (secret.address() as AddressInfo).port;
    redirectTarget = `http://127.0.0.1:${bPort}/secret`;
    try {
      const b = await open({ allowPrivateNetwork: true, blockHostPorts: [`127.0.0.1:${bPort}`] });
      await b.goto(`${origin}/redirect`).catch(() => {});
      expect(hitsOnB).toBe(0);
      expect(b.proxyBlocked.some((x) => x.includes(`:${bPort}`))).toBe(true);
      expect((await b.readState()).ariaSnapshot).not.toContain("SECRET-METADATA");
    } finally {
      secret.close();
    }
  });

  it("refuses private targets at the proxy even when the request guard is bypassed", async () => {
    const proxy = await EgressProxy.start({ allowPrivateNetwork: false });
    try {
      const viaProxy = (target: string) =>
        new Promise<number>((resolve, reject) => {
          const u = new URL(proxy.url);
          const req = http.request({ host: u.hostname, port: u.port, method: "GET", path: target, headers: { host: new URL(target).host } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on("error", reject);
          req.end();
        });
      expect(await viaProxy(`${origin}/`)).toBe(403);
      expect(await viaProxy("http://169.254.169.254/latest/meta-data/")).toBe(403);
      expect(await viaProxy("http://localhost:1/")).toBe(403);
      expect(proxy.blocked.length).toBe(3);
    } finally {
      await proxy.close();
    }
  });

  it("enforces the origin allowlist, including when a redirect lands elsewhere", async () => {
    const other = http.createServer((_req, res) => res.end("<h1>Elsewhere</h1>"));
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    redirectTarget = `http://127.0.0.1:${(other.address() as AddressInfo).port}/`;
    try {
      const b = await open({ allowPrivateNetwork: true, allowedOrigins: [origin] });
      await b.goto(`${origin}/`);
      await expect(b.goto("https://example.org/")).rejects.toBeInstanceOf(NavigationBlockedError);
      await expect(b.goto(`${origin}/redirect`)).rejects.toBeInstanceOf(NavigationBlockedError);
      expect((await b.readState()).url).toBe("about:blank");
    } finally {
      other.close();
    }
  });
  it("treats only a plain same-site GET lookup as safe to submit; every other form stays consequential", async () => {
    const b = await open();
    await b.goto(`${origin}/forms`);
    const { ariaSnapshot: s } = await b.snapshot();
    const risk = async (name: string) => classifyClick({ ...(await b.inspect(refOf(s, "button", name))) });

    expect(await risk("Look up")).toBe("low"); // method="get", same site
    expect(await risk("Go implicit")).toBe("low"); // no method means GET
    expect(await risk("Go elsewhere")).toBe("consequential"); // data leaves the site
    expect(await risk("Go with password")).toBe("consequential"); // a password field is never a lookup
    expect(await risk("Go posting")).toBe("consequential"); // POST
    expect(await risk("Delete everything")).toBe("consequential"); // the name still counts
    expect((await b.inspect(refOf(s, "button", "Look up"))).formSameOriginGet).toBe(true);
    expect((await b.inspect(refOf(s, "button", "Go elsewhere"))).formSameOriginGet).toBe(false);
  });

  it("lets a person drive the page: live frame, click, typing, keys and scrolling, without disturbing the agent's refs", async () => {
    const b = await open();
    await b.goto(`${origin}/`);
    const snap = await b.snapshot();
    const emailRef = refOf(snap.ariaSnapshot, "textbox", "Email");

    const frame = await b.liveFrame();
    expect(frame.mime).toBe("image/jpeg");
    expect(frame.data.subarray(0, 3).toString("hex")).toBe("ffd8ff"); // JPEG signature
    expect(frame.width).toBeGreaterThan(0);
    expect(frame.height).toBeGreaterThan(0);
    // Taking a picture must not invalidate refs the agent already holds.
    await expect(b.inspect(emailRef)).resolves.toMatchObject({ role: "textbox", name: "Email" });

    // The person works from the picture, so the adapter only ever receives screen coordinates.
    // (The test peeks at the page object to find where things are and to read results back.)
    const page = (b as unknown as { page: import("playwright").Page }).page;
    const centre = async (selector: string) => {
      const box = (await page.locator(selector).boundingBox())!;
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const email = await centre("input[aria-label=Email]");
    await b.applyInput({ type: "click", x: email.x, y: email.y });
    await b.applyInput({ type: "text", text: "typed by a person" });
    expect(await page.inputValue("input[aria-label=Email]")).toBe("typed by a person");
    await b.applyInput({ type: "key", key: "Backspace" });
    expect(await page.inputValue("input[aria-label=Email]")).toBe("typed by a perso");

    const rename = await centre("#rename");
    await b.applyInput({ type: "click", x: rename.x, y: rename.y });
    expect((await b.readState()).ariaSnapshot).toContain("Delete account");

    await page.evaluate(() => (document.body.style.minHeight = "3000px"));
    await b.applyInput({ type: "scroll", x: 100, y: 100, dx: 0, dy: 300 });
    await page.waitForFunction(() => window.scrollY > 0, undefined, { timeout: 3000 }); // wheel scrolling is applied asynchronously
  });

  describe("attached to someone else's Chrome (CDP)", () => {
    let chrome: import("playwright").Browser;
    let cdpUrl: string;
    beforeAll(async () => {
      const port = await new Promise<number>((resolve) => {
        const probe = http.createServer().listen(0, "127.0.0.1", () => {
          const p = (probe.address() as AddressInfo).port;
          probe.close(() => resolve(p));
        });
      });
      chrome = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
      cdpUrl = `http://127.0.0.1:${port}`;
    });
    afterAll(async () => void (await chrome.close()));

    const attach = async (allowedOrigins?: string[]) => {
      const b = await PlaywrightBrowser.attach({ cdpUrl, allowPrivateNetwork: true, ...(allowedOrigins ? { allowedOrigins } : {}) });
      browsers.push(b);
      return b;
    };
    const userContext = async () => {
      const probe = await chromium.connectOverCDP(cdpUrl);
      return { probe, ctx: probe.contexts()[0]! };
    };

    it("works in its own new tab and leaves the user's tabs and the browser alone when it closes", async () => {
      const { probe, ctx } = await userContext();
      const mine = await ctx.newPage(); // a tab the "user" already has open
      await mine.goto(`${origin}/done`);
      const before = ctx.pages().length;

      const b = await attach();
      expect(ctx.pages().length).toBe(before + 1);
      await b.goto(`${origin}/`);
      expect((await b.readState()).ariaSnapshot).toContain("Shop");
      expect(mine.url()).toBe(`${origin}/done`); // the user's tab did not move

      await b.close();
      browsers.splice(browsers.indexOf(b), 1);
      expect(ctx.pages().length).toBe(before); // only the agent's tab went away
      expect(mine.isClosed()).toBe(false);
      await expect(mine.evaluate(() => document.title)).resolves.toBe("Done");
      await probe.close();
    });

    it("applies the origin rules to its own tab only, not to the user's other tabs", async () => {
      const { probe, ctx } = await userContext();
      const other = http.createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<title>Other</title><h1>Other site</h1>"));
      await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
      const otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
      try {
        const b = await attach([origin]);
        await b.goto(`${origin}/`);
        await expect(b.goto(`${otherOrigin}/`)).rejects.toBeInstanceOf(NavigationBlockedError);

        // The same site is fine for the user in their own tab: our allowlist must not reach it.
        const mine = await ctx.newPage();
        await mine.goto(`${otherOrigin}/`);
        expect(await mine.title()).toBe("Other");
        await mine.close();
      } finally {
        other.close();
        await probe.close();
      }
    });

    it("closes popups its own tab opened but not tabs the user opens", async () => {
      const { probe, ctx } = await userContext();
      const b = await attach();
      await b.goto(`${origin}/`);
      const snap = await b.snapshot();
      await b.click(refOf(snap.ariaSnapshot, "button", "Popup"));
      await new Promise((r) => setTimeout(r, 500));
      expect(b.popupsClosed.length).toBe(1);

      const theirs = await ctx.newPage();
      await theirs.goto(`${origin}/done`);
      await new Promise((r) => setTimeout(r, 500));
      expect(theirs.isClosed()).toBe(false);
      await theirs.close();
      await probe.close();
    });

    it("gives a live frame in CSS pixels with the real page size", async () => {
      const b = await attach();
      await b.goto(`${origin}/`);
      const f = await b.liveFrame();
      expect(f.width).toBeGreaterThan(100);
      expect(f.height).toBeGreaterThan(100);
      expect(f.data.subarray(0, 3).toString("hex")).toBe("ffd8ff");
    });
  });

});
