import { PgBoss } from "pg-boss";

export const RUN_QUEUE = "task-run";
const RETRY_LIMIT = 2;

export interface RunQueue {
  /** Schedules a run for the task. Duplicate requests while one is already waiting are collapsed. */
  enqueueRun(taskId: string): Promise<void>;
}

export interface RunJobContext {
  signal: AbortSignal;
  /** True when a failure now will not be retried. */
  isFinalAttempt: boolean;
}

export interface TaskQueueOptions {
  connectionString: string;
  /** pg-boss schema; tests use a throwaway one. */
  schema?: string;
  /** Upper bound for one run; jobs get this plus a margin before pg-boss treats them as expired. */
  maxRunSeconds: number;
  retryDelaySeconds?: number;
}

/**
 * pg-boss backed queue. A job only says "advance this task": the orchestrator reads the
 * persisted task state to decide what to do, so duplicate, late, or retried jobs are harmless
 * (the per-task lease turns concurrent ones into no-ops).
 */
export class TaskQueue implements RunQueue {
  private readonly boss: PgBoss;
  private workerId: string | null = null;

  constructor(private readonly opts: TaskQueueOptions) {
    this.boss = new PgBoss({ connectionString: opts.connectionString, ...(opts.schema ? { schema: opts.schema } : {}) });
    // pg-boss emits 'error' for background failures; an unhandled one would crash the process.
    this.boss.on("error", (err) => console.error("[queue] pg-boss error:", err.message));
  }

  async start(): Promise<void> {
    await this.boss.start();
    await this.boss.createQueue(RUN_QUEUE, {
      // At most one *waiting* job per task (via singletonKey); a running one does not block a new request.
      policy: "short",
      retryLimit: RETRY_LIMIT,
      retryDelay: this.opts.retryDelaySeconds ?? 10,
      retryBackoff: true,
      expireInSeconds: this.opts.maxRunSeconds + 600,
    });
  }

  async enqueueRun(taskId: string): Promise<void> {
    // Returns null when an identical job is already waiting, which is exactly what we want.
    await this.boss.send(RUN_QUEUE, { taskId }, { singletonKey: taskId });
  }

  async startWorker(
    handler: (taskId: string, ctx: RunJobContext) => Promise<void>,
    opts: { concurrency: number; onFinalFailure: (taskId: string, err: unknown) => Promise<void> },
  ): Promise<void> {
    this.workerId = await this.boss.work<{ taskId: string }, void, { localConcurrency: number; includeMetadata: true; pollingIntervalSeconds: number }>(
      RUN_QUEUE,
      { localConcurrency: opts.concurrency, includeMetadata: true, pollingIntervalSeconds: 1 },
      async ([job]) => {
        if (!job) return;
        const isFinalAttempt = job.retryCount >= job.retryLimit;
        try {
          await handler(job.data.taskId, { signal: job.signal, isFinalAttempt });
        } catch (err) {
          if (isFinalAttempt) await opts.onFinalFailure(job.data.taskId, err).catch(() => {});
          throw err; // let pg-boss record the failure and schedule any retry
        }
      },
    );
  }

  /** Stops fetching new jobs and waits for running ones to finish (or the timeout). */
  async stop(timeoutMs = 30_000): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: timeoutMs });
  }
}
