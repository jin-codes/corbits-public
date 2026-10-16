import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { EventHook } from "../persistence/task-store.js";

/**
 * Turns persisted events into outbox rows, inside the event's own transaction. Only these
 * things ever notify: a verified completion, an end whose result could not be verified, a failure/incomplete
 * end, an approval request, and the agent asking its owner for help.
 * Cancellations are user-initiated and do not notify. The unique dedupe key makes repeats no-ops.
 */
export const notificationOutbox: EventHook = async (client, event) => {
  let kind: "task_completed" | "task_failed" | "task_unverified" | "approval_requested" | "help_requested" | null = null;
  let refId: string | null = null;
  let dedupe = "";

  if (event.type === "task.state_changed") {
    if (event.payload.to === "completed") (kind = "task_completed"), (dedupe = `${event.taskId}:completed`);
    else if (event.payload.to === "unverified") (kind = "task_unverified"), (dedupe = `${event.taskId}:unverified`);
    else if (event.payload.to === "failed") (kind = "task_failed"), (dedupe = `${event.taskId}:failed`);
  } else if (event.type === "approval.requested" && typeof event.payload.approvalId === "string") {
    kind = "approval_requested";
    refId = event.payload.approvalId;
    dedupe = `${event.taskId}:approval:${refId}`;
  } else if (event.type === "help.requested") {
    kind = "help_requested";
    dedupe = `${event.taskId}:help:${event.seq}`; // one per request: a task may ask more than once
  }
  if (!kind) return;

  await client.query(
    `INSERT INTO notifications (id, task_id, owner, kind, ref_id, dedupe_key)
     SELECT $1, t.id, t.owner, $3, $4, $5 FROM tasks t WHERE t.id = $2
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [randomUUID(), event.taskId, kind, refId, dedupe],
  );
};

export const NOTICE_SUBJECT_MAX = 120;
export const NOTICE_BODY_MAX = 2000;
export const NOTICES_PER_DAY = 20;

export interface NoticeInput {
  subject: string;
  body: string;
  /** Caller-chosen idempotency key: the same key is mailed once, however often it is sent. */
  dedupeKey: string;
}

export type NoticeResult = "queued" | "duplicate" | "limit";

/**
 * Queues a plain message to `owner`. Mailed only to that owner's own address (the dispatcher looks the
 * address up from the owner), at most NOTICES_PER_DAY a day so a looping caller cannot flood the inbox.
 */
export async function enqueueNotice(pool: Pool, owner: string, n: NoticeInput): Promise<NoticeResult> {
  const key = `notice:${owner}:${n.dedupeKey}`;
  const { rows } = await pool.query<{ recent: string }>(
    "SELECT count(*) AS recent FROM notifications WHERE kind = 'notice' AND owner = $1 AND created_at > now() - interval '1 day'",
    [owner],
  );
  const dup = await pool.query("SELECT 1 FROM notifications WHERE dedupe_key = $1", [key]);
  if (dup.rowCount) return "duplicate";
  if (Number(rows[0]?.recent ?? 0) >= NOTICES_PER_DAY) return "limit";
  const res = await pool.query(
    `INSERT INTO notifications (id, task_id, owner, kind, dedupe_key, subject, body)
     VALUES ($1, NULL, $2, 'notice', $3, $4, $5) ON CONFLICT (dedupe_key) DO NOTHING`,
    [randomUUID(), owner, key, n.subject, n.body],
  );
  return res.rowCount ? "queued" : "duplicate";
}
