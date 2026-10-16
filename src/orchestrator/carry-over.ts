import type { TaskEvent } from "../persistence/task-store.js";

export interface CarryOver {
  /** Compact, model-facing record of the earlier attempt. Contains model- and page-derived text: untrusted. */
  summary: string;
  /** The last page the earlier attempt was on, so a continuation can start there. */
  lastUrl: string | undefined;
}

const MAX_ACTIONS = 15;
const MAX_TOTAL = 4000;

const clip = (v: unknown, n: number) => {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/**
 * Summarizes how an earlier attempt went, so a continuation does not redo finished work and
 * knows why it stopped. It carries no page content, only what was done and where it ended.
 */
export function buildCarryOver(events: readonly TaskEvent[]): CarryOver {
  const actions: string[] = [];
  let lastUrl: string | undefined;
  let report = "";
  let ended = "";
  let unmet: string[] = [];
  let interrupted = false;

  for (const e of events) {
    const p = e.payload;
    if (e.type === "tool.completed") {
      const out = (p.outcome ?? {}) as { status?: string; error?: string; output?: { url?: unknown } };
      const url = typeof out.output?.url === "string" ? out.output.url : undefined;
      if (out.status === "ok" && url && /^https?:\/\//.test(url)) lastUrl = url;
      actions.push(`${String(p.tool)} ${clip(p.input, 160)} -> ${out.status ?? "?"}${url ? ` (page: ${clip(url, 120)})` : ""}${out.error ? ` error: ${clip(out.error, 120)}` : ""}`);
    } else if (e.type === "tool.denied") {
      actions.push(`${String(p.tool)} ${clip(p.input, 120)} -> denied: ${clip(p.reason, 120)}`);
    } else if (e.type === "approval.decided" && p.decision === "rejected") {
      actions.push(`${String(p.tool)} ${clip(p.input, 120)} -> the user REJECTED this action`);
    } else if (e.type === "model.finished") {
      report = clip(p.summary, 600);
    } else if (e.type === "task.state_changed" && (p.to === "failed" || p.to === "cancelled")) {
      ended = `${String(p.to)}${p.reason ? ` (reason: ${clip(p.reason, 80)})` : ""}${p.outcome === "partial" ? ", partly done" : ""}`;
      unmet = Array.isArray(p.failedCriteria) ? (p.failedCriteria as unknown[]).map((c) => clip(c, 160)) : [];
      interrupted = p.reason === "interrupted_consequential_action";
    }
  }

  const lines = [
    `The previous attempt ended: ${ended || "unknown"}.`,
    ...(interrupted
      ? ["WARNING: it stopped in the middle of an action that cannot safely be repeated, so its result is unknown. Check the page state first and do not repeat that action without confirming it has not already happened."]
      : []),
    actions.length ? `Actions it took (most recent last):` : "It took no actions.",
    ...actions.slice(-MAX_ACTIONS).map((a, i) => `${i + 1}. ${a}`),
    ...(lastUrl ? [`It ended on page: ${lastUrl}. Browser login state from that attempt is gone.`] : []),
    ...(report ? [`Its last report: ${report}`] : []),
    ...(unmet.length ? [`Completion criteria not met: ${unmet.join("; ")}`] : []),
  ];
  let summary = lines.join("\n");
  if (summary.length > MAX_TOTAL) summary = `${summary.slice(0, MAX_TOTAL - 1)}…`;
  return { summary, lastUrl };
}
