import { existsSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LoginStateError, cookieAppliesTo, filterStorageState, loginOrigin, mergeStorageStates, secretValues, type StorageState } from "./login-state.js";
import { PlaywrightBrowser } from "./playwright-browser.js";

const cookie = (domain: string, name = "sid", value = "v".repeat(20)) => ({ name, value, domain, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" as const });

describe("keeping only one site's login", () => {
  it("matches cookie domains the way browsers do", () => {
    expect(cookieAppliesTo("example.com", "example.com")).toBe(true);
    expect(cookieAppliesTo(".example.com", "app.example.com")).toBe(true);
    expect(cookieAppliesTo("app.example.com", "example.com")).toBe(false); // a subdomain's cookie is not the parent's
    expect(cookieAppliesTo("example.com", "evilexample.com")).toBe(false); // a suffix is not a parent domain
    expect(cookieAppliesTo("EXAMPLE.com", "example.COM")).toBe(true);
  });

  it("saves only the open page's site: its cookies and its own local storage", () => {
    const raw: StorageState = {
      cookies: [cookie(".example.com", "a"), cookie("app.example.com", "b"), cookie("bank.test", "c"), cookie("mail.example.org", "d")],
      origins: [
        { origin: "https://app.example.com", localStorage: [{ name: "token", value: "t".repeat(20) }] },
        { origin: "https://bank.test", localStorage: [{ name: "token", value: "x".repeat(20) }] },
      ],
    };
    const { origin, state } = filterStorageState(raw, "https://app.example.com/inbox?x=1");
    expect(origin).toBe("https://app.example.com");
    expect(state.cookies.map((c) => c.name).sort()).toEqual(["a", "b"]); // not the bank's, not another domain's
    expect(state.origins).toEqual([{ origin: "https://app.example.com", localStorage: [{ name: "token", value: "t".repeat(20) }] }]);
  });

  it("refuses to save from a page that is not an https site (or this machine), or from no page", () => {
    expect(loginOrigin("https://example.com/x")).toBe("https://example.com");
    expect(loginOrigin("http://127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080");
    for (const bad of ["http://example.com/", "about:blank", "data:text/html,hi", "ftp://example.com", "not a url", ""]) {
      expect(() => loginOrigin(bad)).toThrow(LoginStateError);
    }
  });

  it("merges states and lists the values that must be scrubbed (long ones only)", () => {
    const a: StorageState = { cookies: [cookie("a.test", "x", "short")], origins: [] };
    const b: StorageState = { cookies: [cookie("b.test", "y", "L".repeat(30))], origins: [{ origin: "https://b.test", localStorage: [{ name: "k", value: "M".repeat(15) }] }] };
    const merged = mergeStorageStates([a, b]);
    expect(merged.cookies).toHaveLength(2);
    expect(secretValues(merged).sort()).toEqual(["L".repeat(30), "M".repeat(15)]);
  });
});

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe.skipIf(!hasChromium)("a login captured in one browser signs in another (real Chromium)", () => {
  const SESSION = "S3SS10N-" + "q".repeat(24);
  let site: http.Server;
  let origin: string; // http://127.0.0.1:PORT
  const browsers: PlaywrightBrowser[] = [];

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      const signedIn = (req.headers.cookie ?? "").includes(`sid=${SESSION}`);
      if (req.method === "POST" && req.url === "/login") {
        res.writeHead(303, { "set-cookie": `sid=${SESSION}; Path=/; HttpOnly`, location: "/dashboard" }).end();
        return;
      }
      if (req.url === "/login") return void res.writeHead(200, { "content-type": "text/html" }).end(`<h1>Sign in</h1><form method="post" action="/login"><button>Sign in</button></form>`);
      if (req.url === "/dashboard") return void res.writeHead(200, { "content-type": "text/html" }).end(signedIn ? "<h1>Welcome back, Ada</h1>" : "<h1>Please sign in</h1>");
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await Promise.all(browsers.map((b) => b.close()));
    site.close();
  });
  const open = async (storageState?: StorageState) => {
    const b = await PlaywrightBrowser.launch({ allowPrivateNetwork: true, ...(storageState ? { storageState } : {}) });
    browsers.push(b);
    return b;
  };
  const refOf = (yaml: string, role: string, name: string) => new RegExp(`- ${role} "${name}"[^\\n]*\\[ref=([a-z0-9]+)\\]`).exec(yaml)![1]!;

  it("captures just the signed-in site, and a new browser started with it is signed in; one without it is not", async () => {
    const a = await open();
    await a.goto(`${origin}/login`);
    await a.click(refOf((await a.snapshot()).ariaSnapshot, "button", "Sign in"));
    expect((await a.readState()).ariaSnapshot).toContain("Welcome back, Ada");

    // The same browser also holds another site's login (planted directly: nothing else is needed to test filtering).
    const context = (a as unknown as { context: import("playwright").BrowserContext }).context;
    await context.addCookies([{ name: "bank", value: "BANK-SECRET-VALUE-123456", domain: "bank.test", path: "/" }]);
    expect((await context.cookies()).map((c) => c.name).sort()).toEqual(["bank", "sid"]); // both really are in there

    const { origin: savedOrigin, state } = await a.captureLoginState();
    expect(savedOrigin).toBe(origin);
    expect(state.cookies.map((c) => c.name)).toEqual(["sid"]); // not "bank"
    expect(JSON.stringify(state)).not.toContain("BANK-SECRET-VALUE");

    const signedIn = await open(state);
    await signedIn.goto(`${origin}/dashboard`);
    expect((await signedIn.readState()).ariaSnapshot).toContain("Welcome back, Ada");

    const anonymous = await open();
    await anonymous.goto(`${origin}/dashboard`);
    expect((await anonymous.readState()).ariaSnapshot).toContain("Please sign in");

    // A browser started from the saved login holds nothing of the other site.
    const ctx2 = (signedIn as unknown as { context: import("playwright").BrowserContext }).context;
    expect((await ctx2.cookies()).map((c) => c.name)).toEqual(["sid"]);
  });

  it("refuses to capture from a blank page", async () => {
    const b = await open();
    await expect(b.captureLoginState()).rejects.toBeInstanceOf(LoginStateError);
  });
});
