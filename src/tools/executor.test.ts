import { classifyClick } from "./browser-tools.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Decision } from "../policy/policy-engine.js";
import { executeAllowed } from "./executor.js";
import { RetryableToolError, defineTool, type AnyTool } from "./types.js";

type Allow = Extract<Decision, { kind: "allow" }>;
const allow = (tool: AnyTool, input: unknown = {}, risk: "low" | "consequential" = "low"): Allow => ({ kind: "allow", tool, input, risk });
const mk = (handler: () => Promise<unknown>, over: Partial<Parameters<typeof defineTool>[0]> = {}) =>
  defineTool({
    name: "t.x",
    description: "",
    inputSchema: z.object({}),
    outputSchema: z.object({ n: z.number() }),
    handler: handler as never,
    permissions: [],
    risk: "low",
    timeoutMs: 200,
    retry: { maxAttempts: 3, backoffMs: 1 },
    ...over,
  } as never);
const live = () => new AbortController().signal;

describe("executeAllowed", () => {
  it("returns validated output", async () => {
    expect(await executeAllowed(allow(mk(async () => ({ n: 1 }))), live())).toEqual({ status: "ok", output: { n: 1 }, attempts: 1 });
  });

  it("rejects output that violates the output schema", async () => {
    const r = await executeAllowed(allow(mk(async () => ({ n: "x" }))), live());
    expect(r.status).toBe("invalid_output");
  });

  it("retries only retryable errors, up to the limit", async () => {
    let calls = 0;
    const flaky = mk(async () => {
      if (++calls < 3) throw new RetryableToolError("busy");
      return { n: calls };
    });
    expect(await executeAllowed(allow(flaky), live())).toMatchObject({ status: "ok", attempts: 3 });

    calls = 0;
    const always = mk(async () => { calls++; throw new RetryableToolError("busy"); });
    expect(await executeAllowed(allow(always), live())).toMatchObject({ status: "error", attempts: 3, retryable: true });
    expect(calls).toBe(3);
  });

  it("does not retry non-retryable errors", async () => {
    let calls = 0;
    const t = mk(async () => { calls++; throw new Error("boom"); });
    expect(await executeAllowed(allow(t), live())).toMatchObject({ status: "error", attempts: 1, retryable: false });
    expect(calls).toBe(1);
  });

  it("never retries consequential actions", async () => {
    let calls = 0;
    const t = mk(async () => { calls++; throw new RetryableToolError("busy"); }, { risk: "consequential", consequentialKind: "send_message" });
    await executeAllowed(allow(t, {}, "consequential"), live());
    expect(calls).toBe(1);
  });

  it("times out handlers, even ones that ignore the abort signal, without retrying", async () => {
    let calls = 0;
    const t = mk(() => { calls++; return new Promise(() => {}); }, { timeoutMs: 20 });
    expect(await executeAllowed(allow(t), live())).toEqual({ status: "timeout", attempts: 1 });
    expect(calls).toBe(1);
  });

  it("cancels in flight and before starting", async () => {
    const c = new AbortController();
    const t = mk(() => new Promise(() => {}), { timeoutMs: 5000 });
    const p = executeAllowed(allow(t), c.signal);
    setTimeout(() => c.abort(), 10);
    expect(await p).toMatchObject({ status: "cancelled" });
    expect(await executeAllowed(allow(t), c.signal)).toEqual({ status: "cancelled", attempts: 0 });
  });
});

describe("classifyClick for form submissions", () => {
  const submit = { ref: "e1", role: "button", name: "Search", tag: "button", inputType: "submit", insideForm: true, formMethod: "get", formAction: "http://a/s", href: null, download: false };
  it("is low only for a plain same-site GET lookup", () => {
    expect(classifyClick({ ...submit, formSameOriginGet: true })).toBe("low");
    expect(classifyClick({ ...submit, formSameOriginGet: false })).toBe("consequential");
    expect(classifyClick({ ...submit })).toBe("consequential"); // field missing: not assumed safe
    expect(classifyClick({ ...submit, formSameOriginGet: true, name: "Delete" })).toBe("consequential");
    expect(classifyClick({ ...submit, formSameOriginGet: true, name: "Subscribe" })).toBe("consequential");
  });
});
