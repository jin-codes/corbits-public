import { z } from "zod";
import type { ModelToolSpec } from "../tools/registry.js";
import type { TaskContext } from "./context.js";
import { CriterionSchema, type Criterion } from "../verification/criteria.js";

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type ModelUsage = z.infer<typeof UsageSchema>;

export const PlanResultSchema = z.object({
  steps: z.array(z.string().min(1).max(500)).max(50),
  /** Used only when the task itself carries no completion criteria. */
  criteria: z.array(CriterionSchema).max(20),
  usage: UsageSchema,
});
export type PlanResult = z.infer<typeof PlanResultSchema>;

export const StepResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool_call"),
    tool: z.string().min(1).max(100),
    /** Untrusted; validated against the tool's schema by the policy engine. */
    input: z.unknown(),
    usage: UsageSchema,
    /** Which component made this decision when it was not the main model (e.g. "jev"). Recorded for comparison. */
    via: z.string().max(40).optional(),
  }),
  z.object({ type: z.literal("finish"), summary: z.string().max(5000), usage: UsageSchema }),
  /** The agent cannot continue without a person (CAPTCHA, verification code). Pauses the task for its owner. */
  z.object({ type: z.literal("help"), reason: z.string().max(500), usage: UsageSchema }),
]);
export type StepResult = z.infer<typeof StepResultSchema>;

export type ToolResultSummary =
  | { status: "ok"; output: unknown }
  | { status: "error"; error: string }
  | { status: "timeout" | "cancelled" }
  | { status: "invalid_output"; error: string };

/** What happened so far, rebuilt from persisted events. Tool output is untrusted data. */
export type Observation =
  | { kind: "tool_result"; tool: string; input: unknown; outcome: ToolResultSummary }
  | { kind: "tool_denied"; tool: string; input: unknown; reason: string }
  | { kind: "approval_rejected"; tool: string; input: unknown }
  | { kind: "verification_failed"; failedCriteria: string[] };

export interface PlanRequest extends TaskContext {
  goal: string;
  /** Completion criteria the task already carries. A model that has nothing to add may skip the planning call. */
  givenCriteria?: Criterion[] | undefined;
  constraints: Record<string, unknown>;
  tools: ModelToolSpec[];
}

export interface StepRequest extends TaskContext {
  goal: string;
  plan: string[];
  criteria: Criterion[];
  tools: ModelToolSpec[];
  observations: Observation[];
}

export type ModelErrorKind = "unavailable" | "timeout" | "invalid_response" | "refused";

export class ModelError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

/** Provider-specific code lives behind this interface and normalizes into the types above. */
export interface ModelAdapter {
  /** Which provider and model produced a decision, recorded with every usage entry, e.g. "claude-code:claude-sonnet-5-5". */
  readonly label?: string;
  plan(req: PlanRequest, signal: AbortSignal): Promise<PlanResult>;
  step(req: StepRequest, signal: AbortSignal): Promise<StepResult>;
}
