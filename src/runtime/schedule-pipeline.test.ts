import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresArtifactStore } from "../artifacts/artifact-store.js";
import { ApprovalStore } from "../persistence/approval-store.js";
import { ScheduleStore } from "../persistence/schedule-store.js";
import { TaskStore } from "../persistence/task-store.js";
import { MockBrowser } from "../testing/mock-browser.js";
import { MockModel, call, done, finish } from "../testing/mock-model.js";
import { createTestDb } from "../testing/test-db.js";
import { BrowserSessions } from "./browser-sessions.js";
import type { LimitPolicy } from "./limits.js";
import { TaskQueue } from "./queue.js";
import { Scheduler } from "./scheduler.js";
import { TaskRunner } from "./task-runner.js";
import { TaskService } from "./task-service.js";

const HOME = "https://example.com/";
const policy: LimitPolicy = {
  defaults: { maxToolCalls: 30, maxRuntimeMs: 600_000, maxSpendUsd: 0.5, maxSteps: 40, maxRecoveryAttempts: 1 },
  maximums: { maxToolCalls: 60, maxRuntimeMs: 1_800_000, maxSpendUsd: 2, maxSteps: 70, maxRecoveryAttempts: 2 },
};

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => void (db = await createTestDb()));
afterAll(async () => db.cleanup());

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn().catch(() => {});
});

const waitFor = async <T>(fn: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("a schedule that comes due runs a task all the way, unattended", () => {
  it("creates the task by itself, a worker completes and verifies it, and the next time is set", async () => {
    const pool = db.connect();
    const store = new TaskStore(pool);
    const approvals = new ApprovalStore(pool);
    const artifacts = new PostgresArtifactStore(pool);
    const model = new MockModel((req) => (done(req, "browser.goto") ? finish() : call("browser.goto", { url: HOME })));
    const sessions = new BrowserSessions(async () => new MockBrowser({ [HOME]: { content: `- heading "Example Domain"` } }), 60_000);
    const runner = new TaskRunner({ store, approvals, model, sessions, limits: policy, artifacts });
    const queue = new TaskQueue({ connectionString: db.url, schema: `${db.bossSchema}_sched`, maxRunSeconds: 600, retryDelaySeconds: 1 });
    await queue.start();
    await queue.startWorker(async (id, ctx) => void (await runner.run(id, ctx.signal)), { concurrency: 2, onFinalFailure: (id, err) => runner.failTask(id, "worker_error", String(err)) });
    const service = new TaskService({ store, approvals, queue, limits: policy, artifacts, abortRun: (id) => runner.abort(id) });
    const schedules = new ScheduleStore(pool);
    const scheduler = new Scheduler({ store: schedules, tasks: service, isActive: async () => true, canStart: async () => true, existingLogins: async () => new Set() });
    cleanup.push(async () => scheduler.stop(), async () => queue.stop(3000), async () => sessions.closeAll());

    const s = await schedules.create("alice", {
      name: "Morning check",
      goal: "Open example.com and confirm it says Example Domain",
      completionCriteria: [{ kind: "text_present", value: "Example Domain" }],
      schedule: { type: "daily", time: "08:00" },
      timezone: "UTC",
    });
    expect(await store.listTasks("alice", { limit: 10 })).toHaveLength(0); // nothing runs before it is due

    // The moment arrives (we move it into the past instead of waiting a day) and the loop notices on its own.
    await pool.query("UPDATE schedules SET next_run_at = now() - interval '5 seconds' WHERE id = $1", [s.id]);
    scheduler.start(100);

    const task = await waitFor(async () => (await store.listTasks("alice", { limit: 10 })).find((t) => t.status === "completed"));
    expect(task.constraints.scheduleId).toBe(s.id);
    const events = await store.listEvents(task.id);
    expect(events.find((e) => e.type === "verification.completed")!.payload).toMatchObject({ verdict: "verified" });
    expect(events.map((e) => e.type)).toContain("task.scheduled");

    const [run] = await schedules.runs(s.id);
    expect(run).toMatchObject({ outcome: "started", taskId: task.id, taskStatus: "completed" });
    const after = (await schedules.list("alice"))[0]!;
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now()); // set for the next time
    await new Promise((r) => setTimeout(r, 600)); // and the loop does not start it again
    expect(await store.listTasks("alice", { limit: 10 })).toHaveLength(1);
  });
});
