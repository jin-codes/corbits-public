import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NavigationBlockedError } from "./browser-adapter.js";
import { PlaywrightBrowser } from "./playwright-browser.js";

// Real containers: browser (internal network only) + gateway (the only exit).
const PROJECT = "corbits-test";
const PORT = 19333;
const SECRET = randomBytes(24).toString("hex");
const WS = `ws://127.0.0.1:${PORT}/${SECRET}`;
const env = { ...process.env, CORBITS_BROWSER_WS_SECRET: SECRET, CORBITS_BROWSER_PORT: String(PORT) };

const compose = (...args: string[]) =>
  execFileSync("docker", ["compose", "-p", PROJECT, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const inBrowser = (script: string) => compose("exec", "-T", "browser", "sh", "-c", script);

beforeAll(async () => {
  compose("up", "-d", "--build", "browser", "gateway");
  for (let i = 0; i < 60; i++) {
    try {
      const b = await chromium.connect(WS, { timeout: 3000 });
      await b.close();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("sandbox did not become ready");
});

afterAll(() => {
  try {
    compose("down", "-v", "--remove-orphans");
  } catch {
    /* best effort */
  }
});

describe("sandbox container hardening", () => {
  it("runs unprivileged: non-root, no capabilities, no-new-privileges, seccomp filter, read-only root", () => {
    const out = inBrowser('echo uid=$(id -u); grep -E "CapEff|NoNewPrivs|Seccomp:" /proc/self/status; touch /x 2>&1 || true');
    expect(out).not.toContain("uid=0");
    expect(out).toMatch(/CapEff:\s+0+\b/);
    expect(out).toMatch(/NoNewPrivs:\s+1/);
    expect(out).toMatch(/Seccomp:\s+2/);
    expect(out).toContain("Read-only file system");
  });

  it("has no host mounts and no Docker socket", () => {
    const out = inBrowser("mount; ls /var/run/docker.sock 2>&1 || true");
    expect(out).not.toMatch(/\/Users|host_mnt|virtiofs|fakeowner/);
    expect(out).toContain("No such file");
  });

  it("has no direct route to the internet (the only exit is the gateway)", () => {
    expect(() =>
      inBrowser(`node -e "fetch('https://example.com',{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(0),()=>process.exit(1))"`),
    ).toThrow();
  });

  it("rejects connections to a wrong control path", async () => {
    await expect(chromium.connect(`ws://127.0.0.1:${PORT}/not-the-secret`, { timeout: 5000 })).rejects.toThrow();
  });
});

describe("egress through the gateway", () => {
  it("reaches the public internet via the proxy", async () => {
    const b = await PlaywrightBrowser.connect({ wsEndpoint: WS });
    try {
      await b.goto("https://example.com/");
      const state = await b.readState();
      expect(state.url).toBe("https://example.com/");
      expect(state.ariaSnapshot.length).toBeGreaterThan(20);
    } finally {
      await b.close();
    }
  });

  it("captures a real JPEG screenshot through the sandbox connection", async () => {
    const b = await PlaywrightBrowser.connect({ wsEndpoint: WS });
    try {
      await b.goto("https://example.com/");
      const shot = await b.screenshot();
      expect([...shot.data.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      expect(shot.data.length).toBeGreaterThan(1000);
    } finally {
      await b.close();
    }
  });

  it("refuses private and internal targets even when the adapter's own guard is bypassed", async () => {
    // A raw Playwright client skips every check in PlaywrightBrowser: only the gateway stands in the way.
    const browser = await chromium.connect(WS, { timeout: 10_000 });
    try {
      const page = await (await browser.newContext()).newPage();
      for (const url of ["http://169.254.169.254/latest/meta-data/", "http://gateway:3128/", "http://browser:3000/", "http://host.docker.internal/", "http://10.0.0.1/", "https://169.254.169.254/", "https://[::1]/"]) {
        // Plain http is answered by the proxy with a 403 page; https (CONNECT) fails to tunnel.
        // Either way nothing is fetched from the target.
        const outcome = await page.goto(url, { timeout: 15_000 }).then(
          async (res) => ({ blocked: res?.status() === 403 && (await res.text()).includes("blocked by egress policy") }),
          () => ({ blocked: true }),
        );
        expect(outcome.blocked, url).toBe(true);
      }
    } finally {
      await browser.close();
    }
    const log = compose("logs", "--no-log-prefix", "gateway");
    expect(log).toContain("[egress] refused");
    expect(log).toMatch(/169\.254\.169\.254/);
    expect(log).not.toContain(SECRET);
  });

  it("the adapter also blocks private targets before the request leaves", async () => {
    const b = await PlaywrightBrowser.connect({ wsEndpoint: WS });
    try {
      await expect(b.goto("http://169.254.169.254/")).rejects.toBeInstanceOf(NavigationBlockedError);
    } finally {
      await b.close();
    }
  });

  it("closing one task's session leaves the shared browser available for the next", async () => {
    const first = await PlaywrightBrowser.connect({ wsEndpoint: WS });
    await first.close();
    const second = await PlaywrightBrowser.connect({ wsEndpoint: WS });
    try {
      await second.goto("https://example.com/");
      expect((await second.readState()).url).toBe("https://example.com/");
    } finally {
      await second.close();
    }
  });
});
