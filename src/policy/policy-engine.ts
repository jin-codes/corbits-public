import type { AnyTool } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { actionFingerprint, effectFingerprint, fingerprintContext } from "./fingerprint.js";

export interface Limits {
  maxToolCalls: number;
  maxRuntimeMs: number;
  maxSpendUsd: number;
}

export interface Usage {
  toolCalls: number;
  elapsedMs: number;
  spendUsd: number;
}

export interface ApprovalRecord {
  id: string;
  /** actionFingerprint of the exact action that was shown to the user. */
  actionFingerprint: string;
  /** effectFingerprint of the action's real-world effect. */
  effectFingerprint: string;
  decision: "approved" | "rejected";
  /** An approval authorizes a single execution. */
  consumed: boolean;
}

export interface PolicyContext {
  grantedPermissions: ReadonlySet<string>;
  limits: Limits;
  usage: Usage;
  approvals: readonly ApprovalRecord[];
  /** Where the action was proposed (e.g. page origin). A change here invalidates approvals. */
  actionContext: unknown;
}

export interface ToolCall {
  tool: string;
  /** Untrusted model output. Validated here, never assumed. */
  input: unknown;
  /** Result of the tool's read-only `inspect`, if it has one. */
  inspection?: Record<string, unknown> | undefined;
}

export type DenyCode =
  | "unknown_tool"
  | "invalid_input"
  | "missing_permission"
  | "limit_exceeded"
  | "precondition_failed"
  | "rejected_by_user";

export type Decision =
  | { kind: "allow"; tool: AnyTool; input: unknown; risk: "low" | "consequential"; approvalId?: string }
  | {
      kind: "require_approval";
      tool: AnyTool;
      input: unknown;
      actionFingerprint: string;
      effectFingerprint: string;
      consequentialKind: string | undefined;
    }
  | { kind: "deny"; code: DenyCode; reason: string };

const deny = (code: DenyCode, reason: string): Decision => ({ kind: "deny", code, reason });

export class PolicyEngine {
  constructor(private readonly registry: ToolRegistry) {}

  /** Pure and deterministic: no model involvement, no I/O. */
  evaluate(call: ToolCall, ctx: PolicyContext): Decision {
    const tool = this.registry.get(call.tool);
    if (!tool) return deny("unknown_tool", `Tool not registered: ${call.tool}`);

    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) return deny("invalid_input", `Invalid input for ${tool.name}: ${parsed.error.message}`);
    const input = parsed.data;

    const missing = tool.permissions.filter((p) => !ctx.grantedPermissions.has(p));
    if (missing.length > 0) return deny("missing_permission", `Missing permissions: ${missing.join(", ")}`);

    const limit = this.checkLimits(ctx);
    if (limit) return deny("limit_exceeded", limit);

    // Tool-specific hard rules run before anything can be approved: a person is never asked to
    // approve something the system already knows is not allowed.
    let refusal: string | null = null;
    try {
      refusal = tool.precheck ? tool.precheck(input, call.inspection) : null;
    } catch {
      refusal = "The call could not be checked, so it was refused";
    }
    if (refusal) return deny("precondition_failed", refusal);

    const risk = this.classify(tool, input, call.inspection);
    const action = actionFingerprint(tool.name, input, fingerprintContext(ctx.actionContext, call.inspection));
    const effect = effectFingerprint(tool.effect ? safeEffect(tool, input) : `tool:${tool.name}:${action}`);

    // A rejection blocks the effect itself, so no other tool or parameter spelling can reach it.
    const rejected = ctx.approvals.find((a) => a.decision === "rejected" && (a.effectFingerprint === effect || a.actionFingerprint === action));
    if (rejected) return deny("rejected_by_user", "This action was rejected by the user");

    if (risk === "low") return { kind: "allow", tool, input, risk };

    const approved = ctx.approvals.find((a) => a.decision === "approved" && !a.consumed && a.actionFingerprint === action);
    if (approved) return { kind: "allow", tool, input, risk, approvalId: approved.id };

    return {
      kind: "require_approval",
      tool,
      input,
      actionFingerprint: action,
      effectFingerprint: effect,
      consequentialKind: tool.consequentialKind,
    };
  }

  private checkLimits(ctx: PolicyContext): string | undefined {
    const { limits, usage } = ctx;
    if (usage.toolCalls >= limits.maxToolCalls) return `Tool call limit reached (${limits.maxToolCalls})`;
    if (usage.elapsedMs >= limits.maxRuntimeMs) return `Runtime limit reached (${limits.maxRuntimeMs}ms)`;
    if (usage.spendUsd >= limits.maxSpendUsd) return `Spending limit reached ($${limits.maxSpendUsd})`;
    return undefined;
  }

  /** Static risk is a floor; dynamic classification can only raise it. Failure means consequential. */
  private classify(tool: AnyTool, input: unknown, inspection: Record<string, unknown> | undefined): "low" | "consequential" {
    if (tool.risk === "consequential") return "consequential";
    if (!tool.classifyRisk) return "low";
    try {
      return tool.classifyRisk(input, inspection);
    } catch {
      return "consequential";
    }
  }
}

function safeEffect(tool: AnyTool, input: unknown): string {
  try {
    return tool.effect!(input);
  } catch {
    // Unknown effect: fall back to a tool-specific identity rather than skipping the check.
    return `tool:${tool.name}`;
  }
}
