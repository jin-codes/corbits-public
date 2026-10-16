import type { z } from "zod";

/** "consequential" actions always need explicit approval (see CLAUDE.md section 8). */
export type RiskLevel = "low" | "consequential";

export type ConsequentialKind =
  | "send_message"
  | "publish"
  | "delete_or_modify_data"
  | "purchase"
  | "change_permissions"
  | "use_credentials";

export interface RetryPolicy {
  /** Total attempts including the first. Forced to 1 for consequential actions. */
  maxAttempts: number;
  backoffMs: number;
}

export interface ToolContext {
  signal: AbortSignal;
  /** The human approval this execution was allowed under, if it needed one. */
  approvalId?: string | undefined;
}

/** Thrown by handlers to signal a failure that is safe to retry. Anything else is not retried. */
export class RetryableToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableToolError";
  }
}

export interface ToolDefinition<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: I;
  outputSchema: O;
  handler: (input: z.output<I>, ctx: ToolContext) => Promise<z.output<O>>;
  /** Permissions the run must hold to call this tool, e.g. "browser.navigate". */
  permissions: readonly string[];
  /** Static risk floor. Dynamic classification can only raise it. */
  risk: RiskLevel;
  consequentialKind?: ConsequentialKind;
  /**
   * Optionally raise risk based on the concrete input (e.g. clicking a "Place order" button).
   * Throwing is treated as consequential: uncertain classification defaults to the safer behavior.
   */
  classifyRisk?: (input: z.output<I>, inspection?: Record<string, unknown>) => RiskLevel;
  /**
   * Deterministic preconditions checked after `inspect` and before any approval is requested.
   * Return a reason to refuse the call outright (e.g. a credential used on the wrong site).
   * Throwing counts as a refusal.
   */
  precheck?: (input: z.output<I>, inspection?: Record<string, unknown>) => string | null;
  /**
   * Read-only lookup of the concrete target of a call (e.g. which element a ref points at).
   * Runs only on schema-valid input, before the policy decision. The result feeds risk
   * classification and is bound into the approval fingerprint, so an approval cannot be
   * reused if the same handle later points at something else.
   */
  inspect?: (input: z.output<I>) => Promise<Record<string, unknown>>;
  /**
   * Tool-independent identity of what this call does in the world (e.g. "email:send:a@b.c").
   * A rejection of an effect blocks every tool that produces the same effect.
   */
  effect?: (input: z.output<I>) => string;
  timeoutMs: number;
  retry: RetryPolicy;
  /** How a successful call is verified, when applicable. Free text for now; consumed by verification. */
  verification?: string;
}

export type AnyTool = ToolDefinition<z.ZodType, z.ZodType>;

export function defineTool<I extends z.ZodType, O extends z.ZodType>(def: ToolDefinition<I, O>): AnyTool {
  if (def.timeoutMs <= 0) throw new Error(`Tool ${def.name}: timeoutMs must be positive`);
  if (def.retry.maxAttempts < 1) throw new Error(`Tool ${def.name}: retry.maxAttempts must be >= 1`);
  if (def.risk === "consequential" && !def.consequentialKind) {
    throw new Error(`Tool ${def.name}: consequential tools must declare consequentialKind`);
  }
  return def as unknown as AnyTool;
}
