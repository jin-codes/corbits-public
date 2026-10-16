import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../persistence/task-store.js";
import { buildCarryOver } from "./carry-over.js";

let seq = 0;
const ev = (type: string, payload: Record<string, unknown> = {}): TaskEvent => ({ id: String(++seq), taskId: "t", seq, type, payload, createdAt: new Date() });

describe("buildCarryOver", () => {
  it("records what was done, where it ended, and why it stopped", () => {
    seq = 0;
    const c = buildCarryOver([
      ev("tool.completed", { tool: "browser.goto", input: { url: "https://a.example/login" }, outcome: { status: "ok", output: { url: "https://a.example/login" } } }),
      ev("tool.completed", { tool: "browser.type", input: { ref: "e3", text: "me@example.com" }, outcome: { status: "ok", output: { url: "https://a.example/login" } } }),
      ev("approval.decided", { decision: "rejected", tool: "browser.click", input: { ref: "e9" } }),
      ev("model.finished", { summary: "I could not log in without a password." }),
      ev("task.state_changed", { to: "failed", reason: "verification_failed", outcome: "partial", failedCriteria: ['text_present "Welcome": not found'] }),
    ]);
    expect(c.lastUrl).toBe("https://a.example/login");
    expect(c.summary).toContain("ended: failed (reason: verification_failed), partly done");
    expect(c.summary).toContain("browser.goto");
    expect(c.summary).toContain("the user REJECTED this action");
    expect(c.summary).toContain("I could not log in without a password.");
    expect(c.summary).toContain("Welcome");
    expect(c.summary).toContain("login state from that attempt is gone");
  });

  it("warns loudly when the earlier attempt stopped mid-way through a one-way action", () => {
    seq = 0;
    const c = buildCarryOver([ev("task.state_changed", { to: "failed", reason: "interrupted_consequential_action" })]);
    expect(c.summary).toContain("WARNING");
    expect(c.summary).toContain("do not repeat");
  });

  it("keeps only recent actions and stays bounded", () => {
    seq = 0;
    const events = Array.from({ length: 80 }, (_, i) => ev("tool.completed", { tool: "browser.click", input: { ref: `e${i}`, pad: "x".repeat(400) }, outcome: { status: "ok", output: { url: `https://a.example/${i}` } } }));
    const c = buildCarryOver(events);
    expect(c.summary.length).toBeLessThanOrEqual(4000);
    expect(c.summary).toContain("e79");
    expect(c.summary).not.toContain('"ref":"e0"');
    expect(c.lastUrl).toBe("https://a.example/79");
  });

  it("copes with an empty history", () => {
    expect(buildCarryOver([])).toEqual({ summary: expect.stringContaining("took no actions"), lastUrl: undefined });
  });
});
