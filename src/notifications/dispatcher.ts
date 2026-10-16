import type { Pool } from "pg";
import type { ApprovalStore } from "../persistence/approval-store.js";
import type { TaskStore } from "../persistence/task-store.js";
import { tEn, type Translator } from "../i18n/messages.js";
import { defaultRedactor, type Redactor } from "../security/redact.js";
import type { EmailSender } from "./email.js";
import { oneLine, renderApproval, renderCompleted, renderFailed, renderHelp, renderUnverified, type Rendered } from "./render.js";

interface Row {
  id: string;
  task_id: string | null;
  owner: string;
  kind: "task_completed" | "task_failed" | "task_unverified" | "approval_requested" | "help_requested" | "notice";
  subject: string | null;
  body: string | null;
  ref_id: string | null;
  dedupe_key: string;
  attempts: number;
}

export interface DispatcherDeps {
  pool: Pool;
  store: TaskStore;
  approvals: ApprovalStore;
  sender: EmailSender;
  /** owner -> address. Owners without one are skipped (and the skip is recorded). */
  /** Where each owner's mail goes: a fixed map, or a lookup (so people added later are covered). */
  ownerEmails: ReadonlyMap<string, string> | ((owner: string) => Promise<string | undefined>);
  publicUrl?: string;
  /** Language of the emails. Defaults to English. */
  t?: Translator;
  redactor?: Redactor;
  maxAttempts?: number;
  backoffBaseMs?: number;
  /** How long a claimed row is held before another dispatcher may take it over (crash recovery). */
  lockMs?: number;
  batchSize?: number;
}

/**
 * Sends outbox rows by email. Delivery is separate from task execution: nothing here can
 * change a task's state, and a failed or duplicated email can never re-run a task. Messages are
 * built from the persisted task, approval and transition at send time, never from model text.
 * Delivery is at-least-once: a crash between SMTP success and the "sent" update re-sends once,
 * with the same Message-ID.
 */
export class NotificationDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> = Promise.resolve();
  private readonly redactor: Redactor;
  private readonly t: Translator;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly lockMs: number;
  private readonly batchSize: number;

  constructor(private readonly d: DispatcherDeps) {
    this.redactor = d.redactor ?? defaultRedactor;
    this.t = d.t ?? tEn;
    this.maxAttempts = d.maxAttempts ?? 5;
    this.backoffBaseMs = d.backoffBaseMs ?? 30_000;
    this.lockMs = d.lockMs ?? 120_000;
    this.batchSize = d.batchSize ?? 10;
  }

  start(intervalMs = 5_000): void {
    if (this.timer) return;
    const loop = () => {
      this.running = this.tick()
        .then(() => undefined)
        .catch((err) => console.error("[notifications] tick failed:", this.redactor.redactString(String(err?.message ?? err))))
        .finally(() => {
          if (this.timer) this.timer = setTimeout(loop, intervalMs);
        });
    };
    this.timer = setTimeout(loop, 0);
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  /** Processes one batch of due rows. Returns how many were handled. */
  async tick(): Promise<number> {
    const rows = await this.claim();
    for (const row of rows) await this.process(row);
    return rows.length;
  }

  private async claim(): Promise<Row[]> {
    const { rows } = await this.d.pool.query<Row>(
      `UPDATE notifications SET status = 'sending', attempts = attempts + 1,
              locked_until = now() + ($1::int * interval '1 millisecond')
       WHERE id IN (
         SELECT id FROM notifications
         WHERE status IN ('pending','sending') AND next_attempt_at <= now()
           AND (locked_until IS NULL OR locked_until < now())
         ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
       RETURNING id, task_id, owner, kind, subject, body, ref_id, dedupe_key, attempts`,
      [this.lockMs, this.batchSize],
    );
    return rows;
  }

  private async process(row: Row): Promise<void> {
    const to = typeof this.d.ownerEmails === "function" ? await this.d.ownerEmails(row.owner) : this.d.ownerEmails.get(row.owner);
    if (!to) return this.skip(row, "no_email_for_owner");

    let message: Rendered | { skip: string };
    try {
      message = await this.build(row);
    } catch (err) {
      return this.retryOrFail(row, `could not build message: ${errText(err)}`);
    }
    if ("skip" in message) return this.skip(row, message.skip);

    try {
      await this.d.sender.send({
        to,
        subject: this.redactor.redactString(message.subject),
        text: this.redactor.redactString(message.text),
        messageId: `<${row.dedupe_key.replace(/[^A-Za-z0-9.-]/g, ".")}@corbits.local>`,
      });
    } catch (err) {
      return this.retryOrFail(row, errText(err));
    }
    await this.d.pool.query("UPDATE notifications SET status = 'sent', sent_at = now(), locked_until = NULL, last_error = NULL WHERE id = $1", [row.id]);
    await this.attempt(row.id, true, null);
  }

  /** Builds the message from persisted state, or says why nothing should be sent. */
  private async build(row: Row): Promise<Rendered | { skip: string }> {
    if (row.kind === "notice" || row.task_id === null) {
      if (row.kind !== "notice" || !row.subject || !row.body) return { skip: "malformed_notice" };
      return { subject: oneLine(row.subject, 120), text: row.body };
    }
    const task = await this.d.store.getTask(row.task_id);
    const facts = { id: task.id, goal: task.goal };
    switch (row.kind) {
      case "task_completed":
        return task.status === "completed" ? renderCompleted(facts, this.d.publicUrl, this.t) : { skip: `task_is_${task.status}` };
      case "task_unverified":
        if (task.status !== "unverified") return { skip: `task_is_${task.status}` };
        const finished = (await this.d.store.listEvents(task.id, { types: ["model.finished"] })).at(-1);
        return renderUnverified(facts, this.d.publicUrl, this.t, typeof finished?.payload.summary === "string" ? finished.payload.summary : undefined);
      case "task_failed":
        return task.status === "failed"
          ? renderFailed(facts, await this.d.store.lastTransition(task.id), this.d.publicUrl, this.t)
          : { skip: `task_is_${task.status}` };
      case "help_requested": {
        if (task.status !== "human_control") return { skip: `task_is_${task.status}` };
        const events = await this.d.store.listEvents(task.id, { types: ["help.requested", "human.control_ended"] });
        const last = events.at(-1);
        if (!last || last.type !== "help.requested") return { skip: "help_already_handled" };
        return renderHelp(facts, String(last.payload.reason ?? ""), this.d.publicUrl, this.t);
      }
      case "approval_requested": {
        const approval = await this.d.approvals.get(row.ref_id ?? "");
        if (approval.status !== "pending") return { skip: "approval_already_decided" };
        if (task.status !== "awaiting_approval") return { skip: `task_is_${task.status}` };
        return renderApproval(facts, approval, this.d.publicUrl, this.t);
      }
    }
  }

  private async skip(row: Row, reason: string): Promise<void> {
    await this.d.pool.query("UPDATE notifications SET status = 'skipped', skip_reason = $2, locked_until = NULL WHERE id = $1", [row.id, reason]);
  }

  private async retryOrFail(row: Row, error: string): Promise<void> {
    const safe = this.redactor.redactString(error).slice(0, 500);
    await this.attempt(row.id, false, safe);
    if (row.attempts >= this.maxAttempts) {
      await this.d.pool.query("UPDATE notifications SET status = 'failed', last_error = $2, locked_until = NULL WHERE id = $1", [row.id, safe]);
      return;
    }
    const delayMs = this.backoffBaseMs * 2 ** (row.attempts - 1);
    await this.d.pool.query(
      `UPDATE notifications SET status = 'pending', last_error = $2, locked_until = NULL,
              next_attempt_at = now() + ($3::int * interval '1 millisecond') WHERE id = $1`,
      [row.id, safe, delayMs],
    );
  }

  private async attempt(id: string, ok: boolean, error: string | null): Promise<void> {
    await this.d.pool.query("INSERT INTO notification_attempts (notification_id, ok, error) VALUES ($1, $2, $3)", [id, ok, error]);
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
