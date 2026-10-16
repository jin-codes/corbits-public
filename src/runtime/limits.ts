import { z } from "zod";

export interface TaskLimits {
  maxToolCalls: number;
  maxRuntimeMs: number;
  maxSpendUsd: number;
  maxSteps: number;
  maxRecoveryAttempts: number;
}

/** What a task creator may ask for. Anything omitted falls back to the server default. */
export const RequestedLimitsSchema = z
  .object({
    maxToolCalls: z.number().int().positive(),
    maxRuntimeMinutes: z.number().positive(),
    maxSpendUsd: z.number().positive(),
    maxSteps: z.number().int().positive(),
    maxRecoveryAttempts: z.number().int().min(0),
  })
  .partial()
  .strict();
export type RequestedLimits = z.infer<typeof RequestedLimitsSchema>;

/** Stored form: the resolved limits, so history shows what actually applied. */
export const StoredLimitsSchema = z.object({
  maxToolCalls: z.number().int().positive(),
  maxRuntimeMs: z.number().positive(),
  maxSpendUsd: z.number().positive(),
  maxSteps: z.number().int().positive(),
  maxRecoveryAttempts: z.number().int().min(0),
});

export interface LimitPolicy {
  defaults: TaskLimits;
  maximums: TaskLimits;
}

/** Requests can only tighten limits up to the server maximum, never exceed it. */
export function resolveLimits(requested: RequestedLimits | undefined, policy: LimitPolicy): TaskLimits {
  const r = requested ?? {};
  const pick = (value: number | undefined, def: number, max: number) => Math.min(value ?? def, max);
  const { defaults: d, maximums: m } = policy;
  return {
    maxToolCalls: pick(r.maxToolCalls, d.maxToolCalls, m.maxToolCalls),
    maxRuntimeMs: pick(r.maxRuntimeMinutes === undefined ? undefined : r.maxRuntimeMinutes * 60_000, d.maxRuntimeMs, m.maxRuntimeMs),
    maxSpendUsd: pick(r.maxSpendUsd, d.maxSpendUsd, m.maxSpendUsd),
    maxSteps: pick(r.maxSteps, d.maxSteps, m.maxSteps),
    maxRecoveryAttempts: pick(r.maxRecoveryAttempts, d.maxRecoveryAttempts, m.maxRecoveryAttempts),
  };
}

/**
 * Limits to enforce for a stored task. Re-clamped against the current server maximums, so
 * lowering a maximum also constrains tasks that are already queued. Malformed data falls back
 * to the defaults rather than to "unlimited".
 */
export function limitsForTask(constraints: Record<string, unknown>, policy: LimitPolicy): TaskLimits {
  const parsed = StoredLimitsSchema.safeParse(constraints.limits);
  const base = parsed.success ? parsed.data : policy.defaults;
  const m = policy.maximums;
  return {
    maxToolCalls: Math.min(base.maxToolCalls, m.maxToolCalls),
    maxRuntimeMs: Math.min(base.maxRuntimeMs, m.maxRuntimeMs),
    maxSpendUsd: Math.min(base.maxSpendUsd, m.maxSpendUsd),
    maxSteps: Math.min(base.maxSteps, m.maxSteps),
    maxRecoveryAttempts: Math.min(base.maxRecoveryAttempts, m.maxRecoveryAttempts),
  };
}
