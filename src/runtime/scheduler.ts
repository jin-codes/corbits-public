import { InvalidRequestError, type CreateTaskRequest, type TaskView } from "./task-service.js";
import { QuotaExceededError } from "./quota.js";
import type { RunOutcome, Schedule, ScheduleRun, ScheduleStore } from "../persistence/schedule-store.js";

/** A run later than this is not made up: it is skipped and noted (the server was probably off). */
export const LATE_GRACE_MS = 60 * 60_000;
/** After this many failed runs in a row the schedule pauses itself instead of spending on something that does not work. */
export const MAX_CONSECUTIVE_FAILURES = 5;
/** A scheduled run still waiting for a person after this long is cancelled, so it cannot block every later run. */
export const WAITING_EXPIRY_MS = 12 * 3_600_000;

const ACTIVE = new Set(["queued", "planning", "running", "awaiting_approval", "human_control", "verifying"]);
const WAITING = new Set(["awaiting_approval", "human_control"]);

export interface SchedulerDeps {
  store: ScheduleStore;
  tasks: {
    createTask(owner: string, input: CreateTaskRequest, opts: { schedule: { id: string; name: string } }): Promise<TaskView>;
    cancel(owner: string, taskId: string): Promise<unknown>;
  };
  /** False for someone who has been disabled: their schedules stop. */
  isActive: (owner: string) => Promise<boolean>;
  /** False when no model is available to them (for example, a person with no API key on a server that cannot lend its login). */
  canStart: (owner: string) => Promise<boolean>;
  /** Which of these saved-login names still exist for the owner. */
  existingLogins: (owner: string, names: readonly string[]) => Promise<ReadonlySet<string>>;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface RunResult {
  outcome: RunOutcome;
  taskId?: string;
  detail?: string;
}

/**
 * Starts the tasks that schedules ask for. A schedule is only a reason to create an ordinary task, so everything
 * else (limits, approvals, quotas, saved logins, notifications) works exactly as for a task started by hand, and a
 * scheduled task that needs a decision waits for one like any other. Each moment is claimed before it is acted on,
 * so it is handled at most once. When something prevents a run, nothing is started and the reason is recorded.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly d: SchedulerDeps) {}

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    const loop = () => {
      this.tick().catch((err) => this.d.log?.(`[scheduler] tick failed: ${err instanceof Error ? err.message : String(err)}`));
    };
    this.timer = setInterval(loop, intervalMs);
    this.timer.unref();
    loop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Handles everything that is due now. Safe to call from several places: ticks do not overlap in one process. */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const due = await this.d.store.claimDue();
      for (const { schedule, dueAt } of due) {
        const result = await this.handle(schedule, dueAt, false);
        await this.d.store.recordRun(schedule.id, { dueAt, ...result });
      }
      return due.length;
    } finally {
      this.ticking = false;
    }
  }

  /** "Run now": same checks, ignoring the clock, and the schedule's own times are unchanged. */
  async runNow(owner: string, scheduleId: string): Promise<RunResult> {
    const schedule = await this.d.store.get(owner, scheduleId);
    const result = await this.handle(schedule, (this.d.now ?? (() => new Date()))(), true);
    await this.d.store.recordRun(schedule.id, { dueAt: (this.d.now ?? (() => new Date()))(), outcome: result.outcome, ...(result.taskId ? { taskId: result.taskId } : {}), detail: `manual${result.detail ? `: ${result.detail}` : ""}` });
    return result;
  }

  private async handle(s: Schedule, dueAt: Date, manual: boolean): Promise<RunResult> {
    const now = (this.d.now ?? (() => new Date()))();
    try {
      if (!manual && now.getTime() - dueAt.getTime() > LATE_GRACE_MS) {
        return { outcome: "skipped_late", detail: `due ${dueAt.toISOString()}; the server was not running` };
      }
      if (!(await this.d.isActive(s.owner))) return { outcome: "skipped_blocked", detail: "this person's access is disabled" };

      const recent = await this.d.store.runs(s.id, MAX_CONSECUTIVE_FAILURES + 1);
      if (!manual && this.failedInARow(recent) >= MAX_CONSECUTIVE_FAILURES) {
        await this.d.store.pause(s.id, "too_many_failures");
        return { outcome: "paused", detail: `${MAX_CONSECUTIVE_FAILURES} runs in a row failed; paused until you turn it back on` };
      }

      const previous = recent.find((r) => r.outcome === "started" && r.taskId);
      if (previous?.taskId && previous.taskStatus && ACTIVE.has(previous.taskStatus)) {
        const waitedMs = now.getTime() - (previous.taskUpdatedAt?.getTime() ?? now.getTime());
        if (WAITING.has(previous.taskStatus) && waitedMs > WAITING_EXPIRY_MS) {
          await this.d.tasks.cancel(s.owner, previous.taskId).catch(() => {});
          this.d.log?.(`[scheduler] cancelled run ${previous.taskId} of "${s.name}": waited over ${WAITING_EXPIRY_MS / 3_600_000}h for a person`);
        } else {
          return { outcome: "skipped_overlap", detail: `the previous run (${previous.taskStatus}) has not finished` };
        }
      }

      if (!(await this.d.canStart(s.owner))) return { outcome: "skipped_blocked", detail: "no model is available for this person (an API key is needed)" };

      // Use the saved logins that still exist; a deleted one is dropped, and noted.
      const have = s.logins.length ? await this.d.existingLogins(s.owner, s.logins) : new Set<string>();
      const logins = s.logins.filter((n) => have.has(n));
      const dropped = s.logins.filter((n) => !have.has(n));

      const task = await this.d.tasks.createTask(
        s.owner,
        {
          goal: s.goal,
          ...(s.completionCriteria.length ? { completionCriteria: s.completionCriteria as CreateTaskRequest["completionCriteria"] } : {}),
          ...(s.limits ? { limits: s.limits as CreateTaskRequest["limits"] } : {}),
          ...(logins.length ? { logins } : {}),
        },
        { schedule: { id: s.id, name: s.name } },
      );
      return { outcome: "started", taskId: task.id, ...(dropped.length ? { detail: `saved login not found, started without: ${dropped.join(", ")}` } : {}) };
    } catch (err) {
      if (err instanceof QuotaExceededError) return { outcome: "skipped_quota", detail: err.message };
      const message = err instanceof Error ? err.message : String(err);
      this.d.log?.(`[scheduler] "${s.name}" could not start: ${message}`);
      return { outcome: "error", detail: err instanceof InvalidRequestError ? message : message.slice(0, 200) };
    }
  }

  /** How many of the latest started runs, counting back without a break, ended in failure. */
  private failedInARow(newestFirst: readonly ScheduleRun[]): number {
    let n = 0;
    for (const r of newestFirst) {
      if (r.outcome !== "started") continue; // skipped runs say nothing about whether the task works
      if (r.taskStatus === "failed") n++;
      else if (r.taskStatus && !ACTIVE.has(r.taskStatus)) break; // a completed or cancelled run ends the streak
      else if (ACTIVE.has(r.taskStatus ?? "")) continue; // still running: unknown yet
    }
    return n;
  }
}
