import { describe, expect, it } from "vitest";
import { limitsForTask, resolveLimits, type LimitPolicy } from "./limits.js";

const policy: LimitPolicy = {
  defaults: { maxToolCalls: 30, maxRuntimeMs: 600_000, maxSpendUsd: 0.5, maxSteps: 40, maxRecoveryAttempts: 1 },
  maximums: { maxToolCalls: 60, maxRuntimeMs: 1_800_000, maxSpendUsd: 2, maxSteps: 70, maxRecoveryAttempts: 2 },
};

describe("resolveLimits", () => {
  it("uses defaults when nothing is requested", () => {
    expect(resolveLimits(undefined, policy)).toEqual(policy.defaults);
  });
  it("lets requests tighten limits", () => {
    expect(resolveLimits({ maxToolCalls: 5, maxRuntimeMinutes: 1, maxSpendUsd: 0.1 }, policy)).toMatchObject({
      maxToolCalls: 5,
      maxRuntimeMs: 60_000,
      maxSpendUsd: 0.1,
    });
  });
  it("never exceeds the server maximum", () => {
    expect(resolveLimits({ maxToolCalls: 10_000, maxRuntimeMinutes: 9999, maxSpendUsd: 1000, maxRecoveryAttempts: 50 }, policy)).toEqual({
      ...policy.maximums,
      maxSteps: policy.defaults.maxSteps,
    });
  });
});

describe("limitsForTask", () => {
  it("re-clamps stored limits to the current maximums", () => {
    const stored = { maxToolCalls: 60, maxRuntimeMs: 1_800_000, maxSpendUsd: 2, maxSteps: 70, maxRecoveryAttempts: 2 };
    const tighter = { ...policy, maximums: { ...policy.maximums, maxSpendUsd: 0.25 } };
    expect(limitsForTask({ limits: stored }, tighter).maxSpendUsd).toBe(0.25);
  });
  it("falls back to defaults, never to unlimited, on malformed data", () => {
    expect(limitsForTask({ limits: { maxToolCalls: "lots" } }, policy)).toEqual(policy.defaults);
    expect(limitsForTask({}, policy)).toEqual(policy.defaults);
  });
});
