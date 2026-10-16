import type { Decision } from "../policy/policy-engine.js";
import { RetryableToolError, type AnyTool } from "./types.js";

export type ToolOutcome =
  | { status: "ok"; output: unknown; attempts: number }
  | { status: "error"; error: string; retryable: boolean; attempts: number }
  | { status: "timeout"; attempts: number }
  | { status: "cancelled"; attempts: number }
  | { status: "invalid_output"; error: string; attempts: number };

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Runs a tool the policy engine has already allowed. Takes only an `allow` decision so the
 * type system prevents executing anything that was denied or still awaits approval.
 */
export async function executeAllowed(
  decision: Extract<Decision, { kind: "allow" }>,
  cancel: AbortSignal,
): Promise<ToolOutcome> {
  const { tool, input, risk } = decision;
  // Never auto-retry consequential actions: a retry could duplicate an irreversible effect.
  const maxAttempts = risk === "consequential" ? 1 : tool.retry.maxAttempts;
  let attempts = 0;

  while (attempts < maxAttempts) {
    if (cancel.aborted) return { status: "cancelled", attempts };
    attempts++;
    const result = await runOnce(tool, input, cancel, decision.approvalId);
    if (result.kind === "ok") return { status: "ok", output: result.output, attempts };
    if (result.kind === "invalid_output") return { status: "invalid_output", error: result.error, attempts };
    if (result.kind === "cancelled") return { status: "cancelled", attempts };
    if (result.kind === "timeout") {
      // A timed-out attempt may still have had effects; do not retry it.
      return { status: "timeout", attempts };
    }
    if (!result.retryable || attempts >= maxAttempts) {
      return { status: "error", error: result.error, retryable: result.retryable, attempts };
    }
    await sleep(tool.retry.backoffMs * 2 ** (attempts - 1), cancel);
  }
  return { status: "error", error: "no attempts made", retryable: false, attempts };
}

type Once =
  | { kind: "ok"; output: unknown }
  | { kind: "invalid_output"; error: string }
  | { kind: "error"; error: string; retryable: boolean }
  | { kind: "timeout" }
  | { kind: "cancelled" };

async function runOnce(tool: AnyTool, input: unknown, cancel: AbortSignal, approvalId: string | undefined): Promise<Once> {
  const controller = new AbortController();
  const onCancel = () => controller.abort();
  cancel.addEventListener("abort", onCancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => ((timedOut = true), controller.abort()), tool.timeoutMs);
  try {
    // Race the handler against abort so a handler that ignores the signal cannot hang the run.
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener("abort", () => reject(new AbortError()), { once: true }),
    );
    const output = await Promise.race([tool.handler(input, { signal: controller.signal, approvalId }), aborted]);
    const parsed = tool.outputSchema.safeParse(output);
    if (!parsed.success) return { kind: "invalid_output", error: parsed.error.message };
    return { kind: "ok", output: parsed.data };
  } catch (err) {
    if (err instanceof AbortError) return timedOut ? { kind: "timeout" } : { kind: "cancelled" };
    return {
      kind: "error",
      error: err instanceof Error ? err.message : String(err),
      retryable: err instanceof RetryableToolError,
    };
  } finally {
    clearTimeout(timer);
    cancel.removeEventListener("abort", onCancel);
  }
}

class AbortError extends Error {}
