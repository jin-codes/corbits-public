import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { assertTransition, isTaskState, type TaskState } from "../domain/task-state.js";
import { defaultRedactor, type Redactor } from "../security/redact.js";

export interface Task {
  id: string;
  owner: string;
  goal: string;
  status: TaskState;
  constraints: Record<string, unknown>;
  completionCriteria: unknown[];
  /** The failed or cancelled task this one continues, if any. */
  parentTaskId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/** Runs inside the transaction that inserts an event (used for the notification outbox). */
export type EventHook = (client: PoolClient, event: TaskEvent) => Promise<void>;

export class TaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

/** The task was not in the state the caller expected (duplicate delivery or concurrent change). */
export class StaleStateError extends Error {
  constructor(
    readonly taskId: string,
    readonly expected: TaskState,
    readonly actual: TaskState,
  ) {
    super(`Task ${taskId} is ${actual}, expected ${expected}`);
    this.name = "StaleStateError";
  }
}

const CreateTaskInput = z.object({
  owner: z.string().min(1),
  goal: z.string().min(1).max(10_000),
  constraints: z.record(z.string(), z.unknown()).default({}),
  completionCriteria: z.array(z.unknown()).default([]),
  parentTaskId: z.uuid().optional(),
});
export type CreateTaskInput = z.input<typeof CreateTaskInput>;

interface TaskRow {
  id: string;
  owner: string;
  goal: string;
  status: string;
  constraints: Record<string, unknown>;
  completion_criteria: unknown[];
  parent_task_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function toTask(row: TaskRow): Task {
  // The DB CHECK constraint guarantees this, but never trust a cast silently.
  if (!isTaskState(row.status)) throw new Error(`Corrupt task status in DB: ${row.status}`);
  return {
    id: row.id,
    owner: row.owner,
    goal: row.goal,
    status: row.status,
    constraints: row.constraints,
    completionCriteria: row.completion_criteria,
    parentTaskId: row.parent_task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TaskStore {
  constructor(
    private readonly pool: Pool,
    /** Every event payload passes through this before it is persisted. */
    private readonly redactor: Redactor = defaultRedactor,
    private readonly onEvent?: EventHook,
  ) {}

  async createTask(input: CreateTaskInput): Promise<Task> {
    const v = CreateTaskInput.parse(input);
    const id = randomUUID();
    return this.inTx(async (c) => {
      const { rows } = await c.query<TaskRow>(
        `INSERT INTO tasks (id, owner, goal, status, constraints, completion_criteria, parent_task_id)
         VALUES ($1, $2, $3, 'queued', $4, $5, $6) RETURNING *`,
        [id, v.owner, v.goal, JSON.stringify(v.constraints), JSON.stringify(v.completionCriteria), v.parentTaskId ?? null],
      );
      await this.insertEvent(c, id, "task.created", { status: "queued" });
      return toTask(rows[0]!);
    });
  }

  async getTask(id: string): Promise<Task> {
    const { rows } = await this.pool.query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [id]);
    if (!rows[0]) throw new TaskNotFoundError(id);
    return toTask(rows[0]);
  }

  /**
   * Atomically moves a task to a new state and records the transition event.
   * Locks the row, validates the transition, and (if `expectedFrom` is given) rejects
   * duplicate or stale deliveries with StaleStateError instead of re-applying them.
   */
  async transition(
    id: string,
    to: TaskState,
    opts: { expectedFrom?: TaskState; payload?: Record<string, unknown> } = {},
  ): Promise<Task> {
    return this.inTx(async (c) => {
      const { rows } = await c.query<TaskRow>("SELECT * FROM tasks WHERE id = $1 FOR UPDATE", [id]);
      if (!rows[0]) throw new TaskNotFoundError(id);
      const current = toTask(rows[0]);
      if (opts.expectedFrom && opts.expectedFrom !== current.status) {
        throw new StaleStateError(id, opts.expectedFrom, current.status);
      }
      assertTransition(current.status, to);
      const updated = await c.query<TaskRow>(
        "UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1 RETURNING *",
        [id, to],
      );
      await this.insertEvent(c, id, "task.state_changed", { ...opts.payload, from: current.status, to });
      return toTask(updated.rows[0]!);
    });
  }

  async setCompletionCriteria(id: string, criteria: unknown[]): Promise<void> {
    const { rowCount } = await this.pool.query(
      "UPDATE tasks SET completion_criteria = $2, updated_at = now() WHERE id = $1",
      [id, JSON.stringify(criteria)],
    );
    if (rowCount === 0) throw new TaskNotFoundError(id);
  }

  /**
   * Runs `fn` only if no other worker holds this task's lease (a Postgres session advisory lock).
   * Prevents two workers from driving the same task after duplicate delivery. The lock is
   * released automatically if the holding connection dies, so a crashed worker cannot wedge a task.
   */
  async withLease<T>(id: string, fn: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
    const c = await this.pool.connect();
    try {
      const { rows } = await c.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok",
        [`task:${id}`],
      );
      if (!rows[0]?.ok) return { acquired: false };
      try {
        return { acquired: true, value: await fn() };
      } finally {
        await c.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`task:${id}`]);
      }
    } finally {
      c.release();
    }
  }

  /** Appends a non-transition event (tool call, approval, verification, ...). */
  async appendEvent(id: string, type: string, payload: Record<string, unknown> = {}): Promise<TaskEvent> {
    return this.inTx(async (c) => {
      const { rows } = await c.query("SELECT 1 FROM tasks WHERE id = $1 FOR UPDATE", [id]);
      if (!rows[0]) throw new TaskNotFoundError(id);
      return this.insertEvent(c, id, type, payload);
    });
  }

  async listEvents(id: string, opts: { afterSeq?: number; limit?: number; types?: readonly string[] } = {}): Promise<TaskEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT id, task_id, seq, type, payload, created_at FROM task_events
       WHERE task_id = $1 AND seq > $2 AND ($4::text[] IS NULL OR type = ANY($4)) ORDER BY seq LIMIT $3`,
      [id, opts.afterSeq ?? 0, opts.limit ?? 100_000, opts.types ? [...opts.types] : null],
    );
    return rows.map(toEvent);
  }

  /** Newest tasks first. `before` is a createdAt cursor for paging. */
  async listTasks(owner: string, opts: { limit?: number; before?: Date } = {}): Promise<Task[]> {
    const { rows } = await this.pool.query<TaskRow>(
      `SELECT * FROM tasks WHERE owner = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [owner, opts.before ?? null, opts.limit ?? 50],
    );
    return rows.map(toTask);
  }

  /** Tasks that were started by continuing this one, oldest first. */
  async listContinuations(id: string): Promise<Array<{ id: string; status: TaskState; createdAt: Date }>> {
    const { rows } = await this.pool.query<{ id: string; status: string; created_at: Date }>(
      "SELECT id, status, created_at FROM tasks WHERE parent_task_id = $1 ORDER BY created_at",
      [id],
    );
    return rows.map((r) => {
      if (!isTaskState(r.status)) throw new Error(`Corrupt task status in DB: ${r.status}`);
      return { id: r.id, status: r.status, createdAt: r.created_at };
    });
  }

  /** The payload of the most recent state change, e.g. why a task failed. */
  async lastTransition(id: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.pool.query(
      "SELECT payload FROM task_events WHERE task_id = $1 AND type = 'task.state_changed' ORDER BY seq DESC LIMIT 1",
      [id],
    );
    return rows[0]?.payload ?? null;
  }

  // Caller must hold the task row lock so seq assignment is race-free.
  private async insertEvent(
    c: PoolClient,
    taskId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<TaskEvent> {
    const { rows } = await c.query(
      `INSERT INTO task_events (task_id, seq, type, payload)
       VALUES ($1, COALESCE((SELECT MAX(seq) FROM task_events WHERE task_id = $1), 0) + 1, $2, $3)
       RETURNING id, task_id, seq, type, payload, created_at`,
      [taskId, type, JSON.stringify(this.redactor.redact(payload))],
    );
    const event = toEvent(rows[0]);
    await this.onEvent?.(c, event);
    return event;
  }

  private async inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  }
}

function toEvent(r: {
  id: string;
  task_id: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}): TaskEvent {
  return { id: String(r.id), taskId: r.task_id, seq: r.seq, type: r.type, payload: r.payload, createdAt: r.created_at };
}
