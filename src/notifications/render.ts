import { catalogs, reasonText, roleLabel, tEn, type MessageKey, type Translator } from "../i18n/messages.js";

export interface TaskFacts {
  id: string;
  goal: string;
}

export interface ApprovalFacts {
  id: string;
  tool: string;
  input: unknown;
  context: unknown;
  consequentialKind: string | null;
}

export interface Rendered {
  subject: string;
  text: string;
}

export const oneLine = (s: string, max: number) => {
  const flat = s.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const clip = (v: unknown, max: number) => {
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

function footer(taskId: string, publicUrl: string | undefined, t: Translator) {
  return [t("email.taskId", { id: taskId }), ...(publicUrl ? [t("email.details", { url: `${publicUrl.replace(/\/$/, "")}/tasks/${taskId}` })] : [])].join("\n");
}

export function renderCompleted(task: TaskFacts, publicUrl?: string, t: Translator = tEn): Rendered {
  return {
    subject: t("email.completed.subject", { goal: oneLine(task.goal, 60) }),
    text: [t("email.completed.intro"), "", t("email.goal", { goal: oneLine(task.goal, 500) }), t("email.completed.result"), "", footer(task.id, publicUrl, t)].join("\n"),
  };
}

/** The task ran but had nothing to check its result against: never worded as a success. */
export function renderUnverified(task: TaskFacts, publicUrl?: string, t: Translator = tEn, agentSummary?: string): Rendered {
  // The agent's own account is shown so the owner can judge the result, labelled as unchecked and clipped (model-written).
  const said = agentSummary?.trim() ? ["", t("email.unverified.agentSaid"), clip(agentSummary.replace(/\s+/g, " ").trim(), 600)] : [];
  return {
    subject: t("email.unverified.subject", { goal: oneLine(task.goal, 60) }),
    text: [t("email.unverified.intro"), "", t("email.goal", { goal: oneLine(task.goal, 500) }), t("email.unverified.result"), ...said, "", t("email.unverified.hint"), "", footer(task.id, publicUrl, t)].join("\n"),
  };
}

export function renderFailed(task: TaskFacts, transition: Record<string, unknown> | null, publicUrl?: string, t: Translator = tEn): Rendered {
  const reason = String(transition?.reason ?? "unknown");
  const partial = transition?.outcome === "partial";
  const unmet = Array.isArray(transition?.failedCriteria) ? (transition!.failedCriteria as unknown[]).map((c) => `  - ${oneLine(String(c), 200)}`) : [];
  return {
    subject: t(partial ? "email.failed.subjectPartial" : "email.failed.subjectFailed", { goal: oneLine(task.goal, 60) }),
    text: [
      t(partial ? "email.failed.introPartial" : "email.failed.introFailed"),
      "",
      t("email.goal", { goal: oneLine(task.goal, 500) }),
      t(partial ? "email.failed.resultPartial" : "email.failed.resultFailed"),
      t("email.failed.why", { why: reasonText(t, reason) }),
      ...(unmet.length ? [t("email.failed.notMetHeader"), ...unmet] : []),
      "",
      footer(task.id, publicUrl, t),
    ].join("\n"),
  };
}

export function renderApproval(task: TaskFacts, approval: ApprovalFacts, publicUrl?: string, t: Translator = tEn): Rendered {
  const ctx = (approval.context ?? {}) as { page?: { url?: unknown }; target?: { name?: unknown; role?: unknown; formAction?: unknown } | null };
  const page = ctx.page?.url ? String(ctx.page.url) : undefined;
  const target = ctx.target?.name ? t("call.target", { role: roleLabel(t, String(ctx.target.role ?? "element")), name: String(ctx.target.name) }) : undefined;
  return {
    subject: t("email.approval.subject", { what: oneLine(target ?? approval.tool, 60) }),
    text: [
      t("email.approval.intro"),
      "",
      t("email.goal", { goal: oneLine(task.goal, 500) }),
      t("email.approval.action", { action: `${approval.tool} ${clip(approval.input, 300)}` }),
      ...(target ? [t("email.approval.target", { target: oneLine(target, 200) })] : []),
      ...(ctx.target?.formAction ? [t("email.approval.submitsTo", { url: oneLine(String(ctx.target.formAction), 200) })] : []),
      ...(page ? [t("email.approval.onPage", { url: oneLine(page, 300) })] : []),
      ...(approval.consequentialKind ? [t("email.approval.kind", { kind: kindLabel(t, approval.consequentialKind) })] : []),
      t("email.approval.id", { id: approval.id }),
      "",
      t("email.approval.howTo"),
      "",
      footer(task.id, publicUrl, t),
    ].join("\n"),
  };
}

export function renderHelp(task: TaskFacts, reason: string, publicUrl?: string, t: Translator = tEn): Rendered {
  return {
    subject: t("email.help.subject", { goal: oneLine(task.goal, 60) }),
    text: [
      t("email.help.intro"),
      "",
      t("email.goal", { goal: oneLine(task.goal, 500) }),
      t("email.help.reason", { reason: oneLine(reason || "-", 300) }),
      "",
      t("email.help.howTo"),
      "",
      footer(task.id, publicUrl, t),
    ].join("\n"),
  };
}

/** Readable name for a consequential-action kind; unknown kinds fall back to a spaced-out code. */
export function kindLabel(t: Translator, kind: string): string {
  const key = `kind.${kind}`;
  return key in catalogs.en ? t(key as MessageKey) : kind.replaceAll("_", " ");
}
