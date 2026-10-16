import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { CriteriaSchema } from "../verification/criteria.js";
import { RequestedLimitsSchema } from "../runtime/limits.js";
import { ScheduleSpecSchema, isValidTimeZone, nextOccurrence, type ScheduleSpec } from "../runtime/schedule-time.js";

export const MAX_SCHEDULES_PER_OWNER = 20;
const RUN_HISTORY = 50;

export const NewScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    goal: z.string().trim().min(1).max(10_000),
    completionCriteria: CriteriaSchema.optional(),
    limits: RequestedLimitsSchema.optional(),
    logins: z.array(z.string().min(1).max(64)).max(5).optional(),
    schedule: ScheduleSpecSchema,
    timezone: z.string().min(1).max(64).refine(isValidTimeZone, "unknown time zone"),
  })
  .strict();
export type NewSchedule = z.infer<typeof NewScheduleSchema>;

export const SchedulePatchSchema = z.object({ enabled: z.boolean().optional(), name: z.string().trim().min(1).max(80).optional() }).strict();
export type SchedulePatch = z.infer<typeof SchedulePatchSchema>;

export type RunOutcome = "started" | "skipped_overlap" | "skipped_late" | "skipped_quota" | "skipped_blocked" | "paused" | "error";

export interface Schedule {
  id: string;
  owner: string;
  name: string;
  goal: string;
  completionCriteria: unknown[];
  limits: unknown;
  logins: string[];
  spec: ScheduleSpec;
  timezone: string;
  enabled: boolean;
  nextRunAt: Date | null;
  anchorAt: Date;
  pausedReason: string | null;
  createdAt: Date;
}

export interface ScheduleRun {
  id: number;
  dueAt: Date;
  ranAt: Date;
  outcome: RunOutcome;
  taskId: string | null;
  detail: string | null;
  /** The run's task status now, and when it last changed, when the run started one. */
  taskStatus: string | null;
  taskUpdatedAt: Date | null;
}

interface Row {
  id: string;
  owner: string;
  name: string;
  goal: string;
  completion_criteria: unknown[];
  limits: unknown;
  logins: string[];
  spec: unknown;
  timezone: string;
  enabled: boolean;
  next_run_at: Date | null;
  anchor_at: Date;
  paused_reason: string | null;
  created_at: Date;
}
const COLUMNS = "id, owner, name, goal, completion_criteria, limits, logins, spec, timezone, enabled, next_run_at, anchor_at, paused_reason, created_at";
const toSchedule = (r: Row): Schedule => ({
  id: r.id,
  owner: r.owner,
  name: r.name,
  goal: r.goal,
  completionCriteria: r.completion_criteria,
  limits: r.limits,
  logins: r.logins,
  spec: ScheduleSpecSchema.parse(r.spec),
  timezone: r.timezone,
  enabled: r.enabled,
  nextRunAt: r.next_run_at,
  anchorAt: r.anchor_at,
  pausedReason: r.paused_reason,
  createdAt: r.created_at,
});

export class ScheduleLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleLimitError";
  }
}
export class ScheduleNotFoundError extends Error {
  constructor() {
    super("Schedule not found");
    this.name = "ScheduleNotFoundError";
  }
}

export class ScheduleStore {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(owner: string, input: NewSchedule): Promise<Schedule> {
    const v = NewScheduleSchema.parse(input);
    const { rows: count } = await this.pool.query<{ n: string }>("SELECT count(*) AS n FROM schedules WHERE owner = $1", [owner]);
    if (Number(count[0]!.n) >= MAX_SCHEDULES_PER_OWNER) throw new ScheduleLimitError(`You can have at most ${MAX_SCHEDULES_PER_OWNER} schedules`);
    const now = this.now();
    const next = nextOccurrence(v.schedule, now, v.timezone, now);
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO schedules (id, owner, name, goal, completion_criteria, limits, logins, spec, timezone, next_run_at, anchor_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${COLUMNS}`,
      [randomUUID(), owner, v.name, v.goal, JSON.stringify(v.completionCriteria ?? []), v.limits ? JSON.stringify(v.limits) : null, v.logins ?? [], JSON.stringify(v.schedule), v.timezone, next, now],
    );
    return toSchedule(rows[0]!);
  }

  async list(owner: string): Promise<Schedule[]> {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM schedules WHERE owner = $1 ORDER BY created_at`, [owner]);
    return rows.map(toSchedule);
  }

  async get(owner: string, id: string): Promise<Schedule> {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM schedules WHERE owner = $1 AND id = $2`, [owner, id]);
    if (!rows[0]) throw new ScheduleNotFoundError();
    return toSchedule(rows[0]);
  }

  /** Pausing keeps the schedule; resuming starts looking for the next time from now (missed runs are not made up). */
  async update(owner: string, id: string, patch: SchedulePatch): Promise<Schedule> {
    const p = SchedulePatchSchema.parse(patch);
    const current = await this.get(owner, id);
    const enabled = p.enabled ?? current.enabled;
    const next = enabled ? (p.enabled === true && !current.enabled ? nextOccurrence(current.spec, this.now(), current.timezone, current.anchorAt) : current.nextRunAt) : null;
    const { rows } = await this.pool.query<Row>(
      `UPDATE schedules SET name = $3, enabled = $4, next_run_at = $5, paused_reason = CASE WHEN $4 THEN NULL ELSE paused_reason END, updated_at = now()
        WHERE owner = $1 AND id = $2 RETURNING ${COLUMNS}`,
      [owner, id, p.name ?? current.name, enabled, next],
    );
    return toSchedule(rows[0]!);
  }

  async delete(owner: string, id: string): Promise<void> {
    const { rowCount } = await this.pool.query("DELETE FROM schedules WHERE owner = $1 AND id = $2", [owner, id]);
    if (!rowCount) throw new ScheduleNotFoundError();
  }

  /** Stops a schedule on the system's own initiative (for example after repeated failures), and says why. */
  async pause(id: string, reason: string): Promise<void> {
    await this.pool.query("UPDATE schedules SET enabled = false, next_run_at = NULL, paused_reason = $2, updated_at = now() WHERE id = $1", [id, reason]);
  }

  /**
   * Takes the schedules that are due and moves each to its next time in the same transaction. Claiming first means a
   * moment is handled at most once, even with two servers or a crash halfway through: a lost run is better than a
   * doubled one. `dueAt` is the moment that was claimed.
   */
  async claimDue(limit = 20): Promise<Array<{ schedule: Schedule; dueAt: Date }>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const now = this.now();
      const { rows } = await client.query<Row>(
        `SELECT ${COLUMNS} FROM schedules WHERE enabled AND next_run_at <= $1 ORDER BY next_run_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      const claimed: Array<{ schedule: Schedule; dueAt: Date }> = [];
      for (const r of rows) {
        const s = toSchedule(r);
        const next = nextOccurrence(s.spec, now, s.timezone, s.anchorAt);
        await client.query("UPDATE schedules SET next_run_at = $2 WHERE id = $1", [s.id, next]);
        claimed.push({ schedule: { ...s, nextRunAt: next }, dueAt: r.next_run_at! });
      }
      await client.query("COMMIT");
      return claimed;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async recordRun(scheduleId: string, run: { dueAt: Date; outcome: RunOutcome; taskId?: string; detail?: string }): Promise<void> {
    await this.pool.query("INSERT INTO schedule_runs (schedule_id, due_at, outcome, task_id, detail) VALUES ($1,$2,$3,$4,$5)", [scheduleId, run.dueAt, run.outcome, run.taskId ?? null, run.detail?.slice(0, 500) ?? null]);
    await this.pool.query(
      "DELETE FROM schedule_runs WHERE schedule_id = $1 AND id NOT IN (SELECT id FROM schedule_runs WHERE schedule_id = $1 ORDER BY id DESC LIMIT $2)",
      [scheduleId, RUN_HISTORY],
    );
  }

  /** Newest first. */
  async runs(scheduleId: string, limit = 20): Promise<ScheduleRun[]> {
    const { rows } = await this.pool.query<{ id: string; due_at: Date; ran_at: Date; outcome: RunOutcome; task_id: string | null; detail: string | null; status: string | null; updated_at: Date | null }>(
      `SELECT r.id, r.due_at, r.ran_at, r.outcome, r.task_id, r.detail, t.status, t.updated_at
         FROM schedule_runs r LEFT JOIN tasks t ON t.id = r.task_id
        WHERE r.schedule_id = $1 ORDER BY r.id DESC LIMIT $2`,
      [scheduleId, limit],
    );
    return rows.map((r) => ({ id: Number(r.id), dueAt: r.due_at, ranAt: r.ran_at, outcome: r.outcome, taskId: r.task_id, detail: r.detail, taskStatus: r.status, taskUpdatedAt: r.updated_at }));
  }
}
