import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../persistence/task-store.js";
import { buildTimeline, describeCall } from "./timeline.js";

let seq = 0;
const ev = (type: string, payload: Record<string, unknown> = {}): TaskEvent => ({
  id: String(++seq),
  taskId: "t",
  seq,
  type,
  payload,
  createdAt: new Date(1_700_000_000_000 + seq * 1000),
});
const state = (to: string, extra: Record<string, unknown> = {}) => ev("task.state_changed", { to, ...extra });

describe("describeCall", () => {
  it("describes known tools in plain language and falls back to the tool name", () => {
    expect(describeCall("browser.goto", { url: "https://a.example" }, null)).toBe("Open https://a.example");
    expect(describeCall("browser.click", { ref: "e7" }, { role: "button", name: "Subscribe" })).toBe("Click button “Subscribe”");
    expect(describeCall("browser.click", { ref: "e7" }, null)).toBe("Click element e7");
    expect(describeCall("browser.type", { ref: "e2", text: "hi" }, { role: "textbox", name: "Email" })).toBe("Type “hi” into textbox “Email”");
    expect(describeCall("custom.thing", {}, null)).toBe("custom.thing");
  });
});

describe("buildTimeline", () => {
  it("tells the story of a verified task and totals cost and actions", () => {
    seq = 0;
    const events = [
      ev("task.created"),
      state("planning"),
      ev("model.usage", { costUsd: 0.01 }),
      ev("plan.created", { steps: ["Open it"], criteria: [{ kind: "text_present", value: "Done" }] }),
      state("running"),
      ev("model.usage", { costUsd: 0.02 }),
      ev("tool.started", { callId: "c1", tool: "browser.click", input: { ref: "e1" }, target: { role: "button", name: "Next" } }),
      ev("tool.completed", { callId: "c1", tool: "browser.click", input: { ref: "e1" }, outcome: { status: "ok", output: { url: "https://x.example/done", ariaSnapshot: "- heading Done" } } }),
      ev("model.finished", { summary: "all done" }),
      state("verifying"),
      ev("verification.completed", { verdict: "verified", results: [{ passed: true, detail: 'text_present "Done": found' }], evidence: { url: "https://x.example/done", snapshotExcerpt: "Done" } }),
      state("completed", { outcome: "verified" }),
    ];
    const t = buildTimeline(events);
    expect(t.summary).toEqual({ costUsd: expect.closeTo(0.03), modelCalls: 2, toolCalls: 1 });
    expect(t.outcome).toMatchObject({ tone: "good", headline: "Completed and verified" });
    const titles = t.items.map((i) => i.title);
    expect(titles).toContain("Click button “Next”");
    expect(titles).toContain("The agent says it is done (not yet verified)");
    expect(titles).toContain("Verified against the real page");
    expect(t.items.find((i) => i.title.startsWith("Click"))).toMatchObject({ lines: ["Now at https://x.example/done"], snapshot: "- heading Done" });
    expect(t.items.find((i) => i.title === "Plan ready")!.lines).toContain("Done when the page shows “Done”");
  });

  it("attaches screenshots to the entry they belong to, and drops deleted ones", () => {
    seq = 0;
    const events = [
      ev("tool.started", { callId: "c1", tool: "browser.goto", input: { url: "https://a.example" } }),
      ev("tool.completed", { callId: "c1", tool: "browser.goto", input: { url: "https://a.example" }, outcome: { status: "ok", output: { url: "https://a.example" } } }),
      ev("artifact.created", { artifactId: "art-1", kind: "screenshot", label: "browser.goto", attachKey: "tool:c1" }),
      ev("artifact.created", { artifactId: "art-2", kind: "screenshot", label: "When approval was requested", attachKey: "approval:ap1" }),
      ev("approval.requested", { approvalId: "ap1", tool: "browser.click", input: { ref: "e1" }, context: {} }),
      ev("artifact.created", { artifactId: "art-3", kind: "screenshot", label: "What the verifier saw", attachKey: "verification:1" }),
      ev("artifact.created", { artifactId: "art-4", kind: "page_text", label: "What the verifier saw", attachKey: "verification:1" }),
      ev("verification.completed", { attempt: 1, verdict: "verified", results: [], evidence: {} }),
    ];
    const t = buildTimeline(events);
    expect(t.items.find((i) => i.title === "Open https://a.example")!.artifacts).toEqual([{ id: "art-1", kind: "screenshot", label: "browser.goto" }]);
    expect(t.items.find((i) => i.title.startsWith("Approval needed"))!.artifacts!.map((a) => a.id)).toEqual(["art-2"]);
    expect(t.items.find((i) => i.title.startsWith("Verified"))!.artifacts!.map((a) => a.id)).toEqual(["art-3", "art-4"]);
    // art-1 was deleted
    const after = buildTimeline(events, new Set(["art-2", "art-3", "art-4"]));
    expect(after.items.find((i) => i.title === "Open https://a.example")!.artifacts).toBeUndefined();
  });

  it("carries the agent's final message as an unverified report on the outcome", () => {
    seq = 0;
    const t = buildTimeline([ev("model.finished", { summary: "The Pro plan costs 49 dollars." }), state("completed", { outcome: "verified" })]);
    expect(t.outcome!.report).toBe("The Pro plan costs 49 dollars.");
    expect(buildTimeline([state("completed")]).outcome!.report).toBeUndefined();
  });

  it("never presents partial or failed outcomes as success, and explains why", () => {
    seq = 0;
    const partial = buildTimeline([state("failed", { reason: "verification_failed", outcome: "partial", failedCriteria: ['text_present "Order confirmed": not found'] })]);
    expect(partial.outcome).toMatchObject({ tone: "warn", headline: expect.stringContaining("Incomplete") });
    expect(partial.outcome!.detail).toContain("did not meet the completion criteria");
    expect(partial.outcome!.unmet).toEqual(['text_present "Order confirmed": not found']);

    const failed = buildTimeline([state("failed", { reason: "limit_exceeded" })]);
    expect(failed.outcome).toMatchObject({ tone: "bad", headline: "Failed" });
    expect(buildTimeline([state("failed", { reason: "brand_new_reason" })]).outcome!.detail).toContain("brand_new_reason");
  });

  it("marks interrupted, timed-out and failed tool calls honestly", () => {
    seq = 0;
    const t = buildTimeline([
      ev("tool.started", { callId: "a", tool: "browser.goto", input: { url: "https://a.example" } }),
      ev("tool.completed", { callId: "a", tool: "browser.goto", input: { url: "https://a.example" }, outcome: { status: "timeout" } }),
      ev("tool.started", { callId: "b", tool: "browser.click", input: { ref: "e1" } }),
      ev("tool.completed", { callId: "b", tool: "browser.click", input: { ref: "e1" }, outcome: { status: "error", error: "Unknown ref e1" } }),
      ev("tool.started", { callId: "c", tool: "browser.click", input: { ref: "e2" } }),
    ]);
    expect(t.items[0]).toMatchObject({ tone: "bad", title: expect.stringContaining("timed out") });
    expect(t.items[1]).toMatchObject({ tone: "bad", lines: ["Unknown ref e1"] });
    expect(t.items[2]).toMatchObject({ tone: "neutral", title: expect.stringContaining("in progress") });
  });

  it("shows approvals and decisions, and denials from the policy", () => {
    seq = 0;
    const t = buildTimeline([
      ev("approval.requested", { tool: "browser.click", input: { ref: "e7" }, context: { page: { url: "https://shop.example/x" }, target: { role: "button", name: "Buy" } } }),
      ev("approval.decided", { decision: "rejected", tool: "browser.click", input: { ref: "e7" }, target: { role: "button", name: "Buy" } }),
      ev("tool.denied", { tool: "email.send", input: {}, reason: "This action was rejected by the user" }),
    ]);
    expect(t.items[0]).toMatchObject({ tone: "warn", title: "Approval needed: Click button “Buy”" });
    expect(t.items[0]!.lines).toContain("On page https://shop.example/x");
    expect(t.items[1]!.title).toBe("You rejected the action");
    expect(t.items[1]!.lines).toEqual(["Click button “Buy”"]);
    expect(t.items[2]).toMatchObject({ tone: "warn", title: expect.stringContaining("Blocked") });
  });

  it("passes page-controlled text through as plain strings and clips huge values", () => {
    seq = 0;
    const evil = '<img src=x onerror="alert(1)"> ' + "x".repeat(10_000);
    const t = buildTimeline([
      ev("tool.started", { callId: "a", tool: "browser.click", input: { ref: "e1" }, target: { role: "button", name: evil } }),
      ev("tool.completed", { callId: "a", tool: "browser.click", input: { ref: "e1" }, outcome: { status: "ok", output: { url: "https://x.example", ariaSnapshot: evil } } }),
    ]);
    const item = t.items[0]!;
    expect(item.title.length).toBeLessThan(200);
    expect(item.snapshot!.length).toBeLessThanOrEqual(4000);
    expect(typeof item.title).toBe("string"); // the dashboard renders strings as text nodes
  });

  it("tolerates unknown event types and malformed payloads without throwing", () => {
    seq = 0;
    expect(() =>
      buildTimeline([ev("something.new", { x: 1 }), ev("tool.completed", {}), ev("plan.created", { steps: "nope" }), ev("verification.completed", { results: 5 })]),
    ).not.toThrow();
  });
});
