import type { TaskEvent } from "../persistence/task-store.js";
import type { Observation, ToolResultSummary } from "../model/types.js";
import type { Usage } from "../policy/policy-engine.js";

const ACTIVE = new Set(["planning", "running", "verifying"]);

/** Usage is derived from persisted events, so it survives restarts and cannot drift from history. */
export function deriveUsage(events: readonly TaskEvent[], nowMs: number): Usage {
  let toolCalls = 0;
  let spendUsd = 0;
  let elapsedMs = 0;
  let activeSince: number | null = null;
  for (const e of events) {
    if (e.type === "tool.started") toolCalls++;
    else if (e.type === "model.usage") spendUsd += Number(e.payload.costUsd ?? 0);
    else if (e.type === "task.state_changed") {
      const to = String(e.payload.to);
      const at = e.createdAt.getTime();
      if (activeSince !== null && !ACTIVE.has(to)) {
        elapsedMs += at - activeSince;
        activeSince = null;
      } else if (activeSince === null && ACTIVE.has(to)) {
        activeSince = at;
      }
    }
  }
  if (activeSince !== null) elapsedMs += Math.max(0, nowMs - activeSince);
  return { toolCalls, elapsedMs, spendUsd };
}

/** A tool.started with no tool.completed/abandoned: the worker died mid-call, outcome unknown. */
export function findDanglingCalls(events: readonly TaskEvent[]): Array<{ callId: string; tool: string; risk: string }> {
  const open = new Map<string, { callId: string; tool: string; risk: string }>();
  for (const e of events) {
    const callId = String(e.payload.callId ?? "");
    if (e.type === "tool.started") {
      open.set(callId, { callId, tool: String(e.payload.tool), risk: String(e.payload.risk) });
    } else if (e.type === "tool.completed" || e.type === "tool.abandoned") {
      open.delete(callId);
    }
  }
  return [...open.values()];
}

export function buildObservations(events: readonly TaskEvent[]): Observation[] {
  const out: Observation[] = [];
  for (const e of events) {
    const p = e.payload;
    switch (e.type) {
      case "tool.completed":
        out.push({ kind: "tool_result", tool: String(p.tool), input: p.input, outcome: p.outcome as ToolResultSummary });
        break;
      case "tool.denied":
        out.push({ kind: "tool_denied", tool: String(p.tool), input: p.input, reason: String(p.reason) });
        break;
      case "approval.decided":
        if (p.decision === "rejected") out.push({ kind: "approval_rejected", tool: String(p.tool), input: p.input });
        break;
      case "help.declined":
        out.push({ kind: "tool_denied", tool: "request_help", input: {}, reason: "You have already asked for help several times on this task. Do not ask again: try another approach, or finish and explain what is blocking you." });
        break;
      case "human.control_ended":
        // The page may now be somewhere else entirely, and the agent's refs are stale. The note is the owner's own words.
        out.push({
          kind: "tool_result",
          tool: "human.control",
          input: {},
          outcome: {
            status: "ok",
            output: {
              message: "A person controlled the browser and has handed it back. The page may have changed: take a new snapshot before acting.",
              ...(typeof p.note === "string" && p.note ? { note_from_user: p.note } : {}),
            },
          },
        });
        break;
      case "recovery.started":
        out.push({ kind: "verification_failed", failedCriteria: (p.failedCriteria as string[]) ?? [] });
        break;
    }
  }
  return out;
}

const MAX_OUTPUT_CHARS = 8000;

/** Bounds stored tool output so one huge page cannot bloat history or the model context. */
export function clipOutput(value: unknown): unknown {
  const json = JSON.stringify(value) ?? "null";
  return json.length <= MAX_OUTPUT_CHARS ? value : `${json.slice(0, MAX_OUTPUT_CHARS)}…[clipped]`;
}
