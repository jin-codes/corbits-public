import type { TaskEvent } from "../persistence/task-store.js";
import { reasonText, roleLabel, tEn, type Translator } from "../i18n/messages.js";

export type Tone = "neutral" | "good" | "warn" | "bad";

export interface TimelineItem {
  seq: number;
  at: string;
  tone: Tone;
  title: string;
  /** Short supporting facts, shown under the title. Plain text only. */
  lines: string[];
  /** Page content captured by a tool call. Untrusted; render as text. */
  snapshot?: string;
  /** Screenshots and captured text belonging to this entry. Fetch the bytes via /artifacts/:id. */
  artifacts?: Array<{ id: string; kind: string; label: string }>;
}

export interface Outcome {
  tone: Tone;
  headline: string;
  detail: string;
  unmet: string[];
  /** The agent's own final message (e.g. the answer to a question). Written by the model, not verified. */
  report?: string;
}

export interface TimelineResult {
  items: TimelineItem[];
  summary: { costUsd: number; modelCalls: number; toolCalls: number };
  outcome: Outcome | null;
}

const clip = (v: unknown, max: number): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : v == null ? fallback : String(v));
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

function describeTarget(target: unknown, t: Translator): string | null {
  const o = obj(target);
  if (typeof o.name === "string" && o.name) return t("call.target", { role: roleLabel(t, str(o.role, "element")), name: clip(o.name, 80) });
  return null;
}

export function describeCall(tool: string, input: unknown, target: unknown, t: Translator = tEn): string {
  const i = obj(input);
  const who = () => describeTarget(target, t) ?? t("call.elementRef", { ref: str(i.ref) });
  switch (tool) {
    case "browser.goto":
      return t("call.open", { url: clip(i.url, 200) });
    case "browser.click":
      return t("call.click", { target: who() });
    case "browser.type":
      return t("call.type", { text: clip(i.text, 60), target: who() });
    case "browser.paste_document":
      return t("call.pasteDocument", { part: str(i.part), target: who() });
    case "browser.type_secret":
      return t("call.typeSecret", { secret: clip(i.secretName, 64), target: who() });
    case "browser.ask_password":
      return t("call.askPassword", { target: who() });
    case "browser.find":
      return t("call.find", { query: clip(i.query, 60) });
    case "browser.scroll":
      return t("call.scroll", { direction: str(i.direction) });
    case "browser.select":
      return t("call.select", { option: clip(i.option, 60), target: who() });
    case "browser.snapshot":
      return t("call.read");
    default:
      return tool;
  }
}

/**
 * Turns the raw event log into something a person can read. This is the single place that
 * decides how history is worded, so every client (dashboard, future apps) shows the same story.
 * Everything that came from a web page or a model is passed through as plain text.
 */
export function buildTimeline(events: readonly TaskEvent[], existingArtifacts?: ReadonlySet<string>, t: Translator = tEn): TimelineResult {
  const items: TimelineItem[] = [];
  // Evidence is attached to history entries by key; deleted artifacts are left out.
  const byKey = new Map<string, Array<{ id: string; kind: string; label: string }>>();
  for (const e of events) {
    if (e.type !== "artifact.created") continue;
    const id = str(e.payload.artifactId);
    if (existingArtifacts && !existingArtifacts.has(id)) continue;
    const key = str(e.payload.attachKey);
    const list = byKey.get(key) ?? [];
    if (!list.some((a) => a.id === id && a.kind === str(e.payload.kind))) list.push({ id, kind: str(e.payload.kind), label: str(e.payload.label) });
    byKey.set(key, list);
  }
  const started = new Map<string, TaskEvent>();
  const completed = new Set<string>();
  for (const e of events) {
    if (e.type === "tool.started") started.set(str(e.payload.callId), e);
    if (e.type === "tool.completed") completed.add(str(e.payload.callId));
  }

  let costUsd = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  let outcome: Outcome | null = null;
  let report = "";

  for (const e of events) {
    const p = e.payload;
    const at = e.createdAt.toISOString();
    const add = (tone: Tone, title: string, lines: string[] = [], snapshot?: string, attachKey?: string) => {
      const evidence = attachKey ? byKey.get(attachKey) : undefined;
      items.push({ seq: e.seq, at, tone, title, lines, ...(snapshot ? { snapshot } : {}), ...(evidence?.length ? { artifacts: evidence } : {}) });
    };

    switch (e.type) {
      case "task.created":
        add("neutral", t("timeline.submitted"));
        break;

      case "task.continued":
        add("neutral", t("timeline.continued"));
        break;

      case "model.usage":
        costUsd += Number(p.costUsd ?? 0);
        modelCalls++;
        break;

      case "plan.created": {
        const steps = Array.isArray(p.steps) ? (p.steps as unknown[]).map((s, i) => `${i + 1}. ${clip(s, 200)}`) : [];
        const criteria = Array.isArray(p.criteria) ? (p.criteria as unknown[]).map((c) => describeCriterion(c, t)) : [];
        add("neutral", t("timeline.planReady"), [...steps, ...criteria]);
        break;
      }

      case "tool.started":
        toolCalls++;
        if (!completed.has(str(p.callId))) {
          add("neutral", t("timeline.inProgress", { what: describeCall(str(p.tool), p.input, p.target, t) }));
        }
        break;

      case "tool.completed": {
        const start = started.get(str(p.callId));
        const target = start?.payload.target;
        const title = describeCall(str(p.tool), p.input, target, t);
        const out = obj(p.outcome);
        const status = str(out.status);
        const o = obj(out.output);
        if (status === "ok") {
          add("neutral", title, typeof o.url === "string" ? [t("timeline.nowAt", { url: clip(o.url, 200) })] : [], typeof o.ariaSnapshot === "string" ? clip(o.ariaSnapshot, 4000) : undefined, `tool:${str(p.callId)}`);
        } else if (status === "cancelled") {
          add("warn", t("timeline.interrupted", { what: title }), [], undefined, `tool:${str(p.callId)}`);
        } else {
          add("bad", t(status === "timeout" ? "timeline.timedOut" : "timeline.failed", { what: title }), status === "timeout" ? [] : [clip(out.error ?? status, 300)], undefined, `tool:${str(p.callId)}`);
        }
        break;
      }

      case "tool.abandoned":
        add("warn", t("timeline.abandoned", { what: describeCall(str(p.tool), {}, null, t) }));
        break;

      case "tool.denied":
        add("warn", t("timeline.blocked", { what: describeCall(str(p.tool), p.input, null, t) }), [clip(p.reason, 300)]);
        break;

      case "approval.requested": {
        const ctx = obj(p.context);
        const lines = [t("timeline.waitingDecision")];
        const page = obj(ctx.page).url;
        if (typeof page === "string") lines.push(t("timeline.onPage", { url: clip(page, 200) }));
        add("warn", t("timeline.approvalNeeded", { what: describeCall(str(p.tool), p.input, ctx.target, t) }), lines, undefined, `approval:${str(p.approvalId)}`);
        break;
      }

      case "approval.auto_approved":
        add("warn", t("timeline.autoApproved", { control: clip(str(p.control), 60) }), [
          t("timeline.autoApprovedBy", { origin: clip(str(p.origin), 120) }),
          describeCall(str(p.tool), p.input, undefined, t),
        ]);
        break;

      case "approval.decided":
        add(p.decision === "approved" ? "good" : "neutral", p.decision === "approved" ? t("timeline.approved") : t("timeline.rejected"), [
          describeCall(str(p.tool), p.input, p.target, t),
        ]);
        break;

      case "model.finished":
        report = str(p.summary);
        add("neutral", t("timeline.agentDone"), p.summary ? [clip(p.summary, 400)] : []);
        break;

      case "verification.completed": {
        const results = Array.isArray(p.results) ? (p.results as unknown[]) : [];
        const lines = results.map((r) => `${obj(r).passed ? "✓" : "✗"} ${clip(obj(r).detail, 200)}`);
        const ev = obj(p.evidence);
        if (typeof ev.url === "string") lines.push(t("timeline.checkedPage", { url: clip(ev.url, 200) }));
        const verdict = str(p.verdict);
        if (p.metBeforeWork === true) lines.push(t("timeline.metBeforeWork"));
        add(
          verdict === "verified" ? "good" : verdict === "failed" ? "bad" : "warn",
          verdict === "verified" ? t("timeline.verified") : verdict === "failed" ? t("timeline.verificationFailed") : verdict === "unverified" ? t("timeline.notVerified") : t("timeline.verificationInconclusive"),
          lines,
          typeof ev.snapshotExcerpt === "string" ? clip(ev.snapshotExcerpt, 2000) : undefined,
          `verification:${str(p.attempt)}`,
        );
        break;
      }

      case "recovery.started":
        add("warn", t("timeline.tryingAgain", { n: str(p.attempt) }), Array.isArray(p.failedCriteria) ? (p.failedCriteria as unknown[]).map((c) => t("timeline.notMet", { text: clip(c, 200) })) : []);
        break;

      case "session.restored":
        add("neutral", t("timeline.browserRestarted"), [clip(p.url, 200)]);
        break;
      case "session.restore_failed":
        add("warn", t("timeline.restoreFailed"), [clip(p.error, 200)]);
        break;

      case "task.scheduled":
        add("neutral", t("timeline.scheduled", { name: clip(p.name, 80) }));
        break;
      case "logins.applied": {
        const sites = Array.isArray(p.logins) ? (p.logins as unknown[]).map((l) => `${str(obj(l).name)} (${clip(obj(l).origin, 120)})`) : [];
        add("neutral", t("timeline.loginsApplied"), sites);
        break;
      }
      case "login.saved":
        add("good", t("timeline.loginSaved", { name: clip(p.name, 60) }), [clip(p.origin, 160)]);
        break;

      case "help.requested":
        add("warn", t("timeline.helpRequested"), p.reason ? [clip(p.reason, 300)] : []);
        break;
      case "help.declined":
        add("neutral", t("timeline.helpDeclined"));
        break;

      case "human.control_ended": {
        const inputs = obj(p.inputs);
        const details: string[] = [];
        if (typeof p.durationMs === "number" && p.inputs) {
          details.push(t("timeline.humanControlSummary", { seconds: Math.round(p.durationMs / 1000), clicks: str(inputs.clicks, "0"), texts: str(inputs.texts, "0"), keys: str(inputs.keys, "0"), scrolls: str(inputs.scrolls, "0") }));
        }
        if (typeof p.note === "string" && p.note) details.push(t("timeline.humanControlNote", { text: clip(p.note, 300) }));
        add("neutral", t("timeline.humanControlEnded"), details);
        break;
      }

      case "owner.acknowledged":
        add("neutral", t("timeline.acknowledged"));
        break;

      case "model.error":
        add("bad", t("timeline.modelProblem"), [`${str(p.phase)}: ${str(p.kind)}`]);
        break;

      case "task.state_changed": {
        const to = str(p.to);
        if (to === "completed") {
          outcome = { tone: "good", headline: t("outcome.completedHeadline"), detail: t("outcome.completedDetail"), unmet: [] };
          add("good", t("timeline.completed"));
        } else if (to === "unverified") {
          outcome = { tone: "warn", headline: t("outcome.unverifiedHeadline"), detail: t("outcome.unverifiedDetail"), unmet: [] };
          add("warn", t("timeline.endedUnverified"), [outcome.detail]);
        } else if (to === "failed") {
          const reason = str(p.reason, "unknown");
          const partial = p.outcome === "partial";
          const unmet = Array.isArray(p.failedCriteria) ? (p.failedCriteria as unknown[]).map((c) => clip(c, 200)) : [];
          outcome = {
            tone: partial ? "warn" : "bad",
            headline: partial ? t("outcome.incompleteHeadline") : t("outcome.failedHeadline"),
            detail: reasonText(t, reason),
            unmet,
          };
          add(partial ? "warn" : "bad", partial ? t("timeline.endedIncomplete") : t("timeline.endedFailure"), [outcome.detail, ...unmet.map((u) => t("timeline.notMet", { text: u }))], undefined, `failure:${reason}`);
        } else if (to === "cancelled") {
          outcome = { tone: "neutral", headline: t("outcome.cancelledHeadline"), detail: t("outcome.cancelledDetail"), unmet: [] };
          add("neutral", t("timeline.cancelled"));
        } else if (to === "human_control") {
          // An agent request already has its own item ("asked for your help").
          if (p.reason !== "agent_requested_help") add("neutral", t("timeline.humanControlStarted"));
        } else if (to === "awaiting_approval") {
          // The "Approval needed" item already says this.
        } else if (to === "running" && p.reason === "approvals_decided") {
          // Covered by the decision item.
        }
        break;
      }
    }
  }
  if (outcome && report) (outcome as Outcome).report = clip(report, 2000);
  return { items, summary: { costUsd, modelCalls, toolCalls }, outcome };
}

function describeCriterion(c: unknown, t: Translator): string {
  const o = obj(c);
  if (o.kind === "url_contains") return t("timeline.doneWhenUrl", { value: clip(o.value, 120) });
  if (o.kind === "answer_grounded") return t("timeline.doneWhenGrounded");
  if (o.kind === "text_present") return t("timeline.doneWhenText", { value: clip(o.value, 120) });
  return clip(c, 120);
}
