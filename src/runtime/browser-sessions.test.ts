import { describe, expect, it } from "vitest";
import { MockBrowser } from "../testing/mock-browser.js";
import { BrowserSessions } from "./browser-sessions.js";

const make = (idleMs = 10_000) => {
  const launched: MockBrowser[] = [];
  const closed: MockBrowser[] = [];
  const sessions = new BrowserSessions(async () => {
    const b = new MockBrowser({});
    b.close = async () => void closed.push(b);
    launched.push(b);
    return b;
  }, idleMs);
  return { sessions, launched, closed };
};

describe("BrowserSessions", () => {
  it("reuses a task's browser and flags fresh launches", async () => {
    const { sessions, launched } = make();
    const a = await sessions.acquire("t1");
    const b = await sessions.acquire("t1");
    expect(a.fresh).toBe(true);
    expect(b.fresh).toBe(false);
    expect(b.browser).toBe(a.browser);
    expect(launched).toHaveLength(1);
    expect((await sessions.acquire("t2")).browser).not.toBe(a.browser);
  });

  it("launches only one browser when two callers ask for the same task at once", async () => {
    const launched: MockBrowser[] = [];
    const sessions = new BrowserSessions(async () => {
      await new Promise((r) => setTimeout(r, 30)); // a slow start, so the second caller arrives mid-launch
      const b = new MockBrowser({});
      launched.push(b);
      return b;
    }, 10_000);
    const [a, b] = await Promise.all([sessions.acquire("t1"), sessions.acquire("t1")]);
    expect(launched).toHaveLength(1);
    expect(a.browser).toBe(b.browser);
    expect([a.fresh, b.fresh].sort()).toEqual([false, true]); // exactly one caller owns the fresh launch
    expect(sessions.peek("t1")).toBe(a.browser);
  });

  it("does not remember a failed launch", async () => {
    let fail = true;
    const sessions = new BrowserSessions(async () => {
      if (fail) throw new Error("no chromium");
      return new MockBrowser({});
    }, 10_000);
    await expect(sessions.acquire("t1")).rejects.toThrow("no chromium");
    expect(sessions.has("t1")).toBe(false);
    fail = false;
    expect((await sessions.acquire("t1")).fresh).toBe(true);
  });

  it("closes idle sessions after the TTL, but not if re-acquired in time", async () => {
    const { sessions, closed } = make(40);
    await sessions.acquire("t1");
    sessions.keep("t1");
    await new Promise((r) => setTimeout(r, 120));
    expect(closed).toHaveLength(1);
    expect(sessions.has("t1")).toBe(false);

    await sessions.acquire("t2");
    sessions.keep("t2");
    await sessions.acquire("t2"); // picked up again: timer cancelled
    await new Promise((r) => setTimeout(r, 120));
    expect(sessions.has("t2")).toBe(true);
    await sessions.closeAll();
    expect(sessions.has("t2")).toBe(false);
  });

  it("a closed session is replaced by a fresh browser", async () => {
    const { sessions, launched } = make();
    await sessions.acquire("t1");
    await sessions.close("t1");
    expect((await sessions.acquire("t1")).fresh).toBe(true);
    expect(launched).toHaveLength(2);
  });
});
