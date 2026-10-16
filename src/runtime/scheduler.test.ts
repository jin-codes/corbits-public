import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ScheduleLimitError, ScheduleNotFoundError, ScheduleStore, MAX_SCHEDULES_PER_OWNER, type NewSchedule } from "../persistence/schedule-store.js";
import { TaskStore } from "../persistence/task-store.js";
import { createTestDb } from "../testing/test-db.js";
import { QuotaExceededError } from "./quota.js";
import { LATE_GRACE_MS, MAX_CONSECUTIVE_FAILURES, Scheduler, WAITING_EXPIRY_MS, type SchedulerDeps } from "./scheduler.js";
import type { CreateTaskRequest } from "./task-service.js";

let db: Awaited<ReturnType<typeof createTestDb>>;
let cleaner: ReturnType<(typeof db)["connect"]>;
beforeAll(async () => {
  db = await createTestDb();
  cleaner = db.connect();
});
afterAll(async () => db.cleanup());
// Tests share one database and the same people: every test starts with no schedules.
beforeEach(async () => void (await cleaner.query("DELETE FROM schedules")));

let clock = new Date("2026-10-10T00:00:00Z");
const now = () => new Date(clock);
const advance = (ms: number) => void (clock = new Date(clock.getTime() + ms));
beforeEach(() => void (clock = new Date("2026-10-10T00:00:00Z")));

const daily8: NewSchedule = { name: "Morning check", goal: "Open the dashboard and read the new message count", schedule: { type: "daily", time: "08:00" }, timezone: "UTC" };

function rig(over: Partial<SchedulerDeps> = {}) {
  const pool = db.connect();
  const store = new ScheduleStore(pool, now);
  const tasks = new TaskStore(pool);
  const created: Array<{ owner: string; input: CreateTaskRequest; schedule: { id: string; name: string } }> = [];
  const cancelled: string[] = [];
  const deps: SchedulerDeps = {
    store,
    tasks: {
      createTask: async (owner, input, opts) => {
        created.push({ owner, input, schedule: opts.schedule });
        const t = await tasks.createTask({ owner, goal: input.goal, completionCriteria: [] });
        return { id: t.id } as never;
      },
      cancel: async (_owner, id) => void cancelled.push(id),
    },
    isActive: async () => true,
    canStart: async () => true,
    existingLogins: async (_o, names) => new Set(names),
    now,
    ...over,
  };
  return { store, tasks, scheduler: new Scheduler(deps), created, cancelled };
}
/** Moves the clock to just after the next due time and runs the scheduler. */
const dueTick = async (r: ReturnType<typeof rig>, by = 1_000) => {
  const [s] = await r.store.list("alice");
  clock = new Date(s!.nextRunAt!.getTime() + by);
  return r.scheduler.tick();
};

describe("schedules", () => {
  it("work out their first time from now, and are private to their owner", async () => {
    const { store } = rig();
    const s = await store.create("alice", daily8);
    expect(s.nextRunAt!.toISOString()).toBe("2026-10-10T08:00:00.000Z");
    expect(await store.list("bob")).toEqual([]);
    await expect(store.get("bob", s.id)).rejects.toBeInstanceOf(ScheduleNotFoundError);
    await expect(store.delete("bob", s.id)).rejects.toBeInstanceOf(ScheduleNotFoundError);
    await expect(store.update("bob", s.id, { enabled: false })).rejects.toBeInstanceOf(ScheduleNotFoundError);
  });

  it("refuse nonsense and cap how many one person can have", async () => {
    const { store } = rig();
    await expect(store.create("alice", { ...daily8, timezone: "Mars/Base" })).rejects.toThrow();
    await expect(store.create("alice", { ...daily8, schedule: { type: "interval", everyMinutes: 5 } })).rejects.toThrow();
    await expect(store.create("alice", { ...daily8, goal: "  " })).rejects.toThrow();
    for (let i = 0; i < MAX_SCHEDULES_PER_OWNER; i++) await store.create("alice", { ...daily8, name: `s${i}` });
    await expect(store.create("alice", daily8)).rejects.toBeInstanceOf(ScheduleLimitError);
  });

  it("are claimed once per moment, even by two servers at the same instant", async () => {
    const a = rig();
    const b = rig();
    await a.store.create("alice", daily8);
    clock = new Date("2026-10-10T08:00:30Z");
    const claims = await Promise.all([a.store.claimDue(), b.store.claimDue()]);
    expect(claims.flat()).toHaveLength(1); // not two
    expect(await a.store.claimDue()).toEqual([]); // and not again
    const [s] = await a.store.list("alice");
    expect(s!.nextRunAt!.toISOString()).toBe("2026-10-11T08:00:00.000Z"); // moved on to tomorrow
  });

  it("do not run while paused, and resuming looks ahead instead of making up missed runs", async () => {
    const r = rig();
    const s = await r.store.create("alice", daily8);
    await r.store.update("alice", s.id, { enabled: false });
    clock = new Date("2026-10-12T09:00:00Z"); // two days pass while it is paused
    expect(await r.scheduler.tick()).toBe(0);
    const resumed = await r.store.update("alice", s.id, { enabled: true });
    expect(resumed.nextRunAt!.toISOString()).toBe("2026-10-13T08:00:00.000Z");
    expect(r.created).toHaveLength(0);
  });

  it("keep only the latest runs in their history", async () => {
    const { store } = rig();
    const s = await store.create("alice", daily8);
    for (let i = 0; i < 60; i++) await store.recordRun(s.id, { dueAt: new Date(2026, 9, 1 + (i % 28)), outcome: "skipped_late" });
    expect(await store.runs(s.id, 100)).toHaveLength(50);
  });
});

describe("the scheduler", () => {
  it("starts an ordinary task when a schedule comes due, with what the schedule says, and records it", async () => {
    const r = rig();
    const s = await r.store.create("alice", { ...daily8, limits: { maxSpendUsd: 0.2 }, completionCriteria: [{ kind: "text_present", value: "Welcome" }], logins: ["mail"] });
    expect(await r.scheduler.tick()).toBe(0); // not due yet
    expect(await dueTick(r)).toBe(1);
    expect(r.created).toHaveLength(1);
    expect(r.created[0]).toMatchObject({
      owner: "alice",
      schedule: { id: s.id, name: "Morning check" },
      input: { goal: daily8.goal, limits: { maxSpendUsd: 0.2 }, completionCriteria: [{ kind: "text_present", value: "Welcome" }], logins: ["mail"] },
    });
    const [run] = await r.store.runs(s.id);
    expect(run).toMatchObject({ outcome: "started", taskStatus: "queued" });
    expect(run!.taskId).toBeTruthy();
    expect(await r.scheduler.tick()).toBe(0); // nothing more until tomorrow's moment
  });

  it("skips a moment that is long past (the server was off) instead of making it up", async () => {
    const r = rig();
    const s = await r.store.create("alice", daily8);
    clock = new Date(s.nextRunAt!.getTime() + LATE_GRACE_MS + 60_000);
    await r.scheduler.tick();
    expect(r.created).toHaveLength(0);
    expect((await r.store.runs(s.id))[0]).toMatchObject({ outcome: "skipped_late" });
    expect((await r.store.list("alice"))[0]!.nextRunAt!.getTime()).toBeGreaterThan(clock.getTime()); // and looks ahead
  });

  it("does not pile up: it skips while the previous run is still going, and goes again once it ends", async () => {
    const r = rig({}); // a fast rhythm so the next moment comes soon
    const s = await r.store.create("alice", { ...daily8, schedule: { type: "interval", everyMinutes: 30 } });
    await dueTick(r);
    expect(r.created).toHaveLength(1);
    await dueTick(r);
    expect(r.created).toHaveLength(1); // the first is still queued
    expect((await r.store.runs(s.id))[0]).toMatchObject({ outcome: "skipped_overlap" });
    const first = (await r.store.runs(s.id)).find((x) => x.outcome === "started")!;
    await r.tasks.transition(first.taskId!, "planning");
    await r.tasks.transition(first.taskId!, "failed");
    await r.tasks.createTask({ owner: "x", goal: "unrelated", completionCriteria: [] });
    await dueTick(r);
    expect(r.created).toHaveLength(2);
  });

  it("cancels a run that has waited too long for a person, so it cannot block the schedule forever", async () => {
    const r = rig();
    const s = await r.store.create("alice", { ...daily8, schedule: { type: "interval", everyMinutes: 60 } });
    await dueTick(r);
    const started = (await r.store.runs(s.id))[0]!;
    await r.tasks.transition(started.taskId!, "planning");
    await r.tasks.transition(started.taskId!, "running");
    await r.tasks.transition(started.taskId!, "awaiting_approval");
    // Task times come from the database's clock; make the task look as if it began waiting at the fake "now".
    await cleaner.query("UPDATE tasks SET updated_at = $1 WHERE id = $2", [clock, started.taskId]);
    clock = new Date(clock.getTime() + WAITING_EXPIRY_MS + 3_600_000);
    await r.store.claimDue(); // (the due moment passed while waiting)
    await r.scheduler.runNow("alice", s.id);
    expect(r.cancelled).toEqual([started.taskId]);
    expect(r.created).toHaveLength(2);
  });

  it("starts nothing, and says why, when the person is over a quota, disabled, or has no model to use", async () => {
    const quota = rig({ tasks: { createTask: async () => { throw new QuotaExceededError("too_many_active", "You already have 2 tasks in progress"); }, cancel: async () => {} } });
    const s1 = await quota.store.create("alice", daily8);
    await dueTick(quota);
    expect((await quota.store.runs(s1.id))[0]).toMatchObject({ outcome: "skipped_quota", detail: "You already have 2 tasks in progress" });

    const off = rig({ isActive: async () => false });
    const s2 = await off.store.create("alice", daily8);
    await dueTick(off);
    expect(off.created).toHaveLength(0);
    expect((await off.store.runs(s2.id))[0]!.outcome).toBe("skipped_blocked");

    const noModel = rig({ canStart: async () => false });
    const s3 = await noModel.store.create("alice", daily8);
    await dueTick(noModel);
    expect(noModel.created).toHaveLength(0);
    expect((await noModel.store.runs(s3.id))[0]).toMatchObject({ outcome: "skipped_blocked" });
    expect((await noModel.store.runs(s3.id))[0]!.detail).toContain("API key");
  });

  it("drops a saved login that was deleted instead of failing, and says so", async () => {
    const r = rig({ existingLogins: async () => new Set(["mail"]) });
    const s = await r.store.create("alice", { ...daily8, logins: ["mail", "gone"] });
    await dueTick(r);
    expect(r.created[0]!.input.logins).toEqual(["mail"]);
    expect((await r.store.runs(s.id))[0]!.detail).toContain("gone");
  });

  it("pauses itself after repeated failures instead of spending on something that does not work", async () => {
    const r = rig();
    const s = await r.store.create("alice", { ...daily8, schedule: { type: "interval", everyMinutes: 60 } });
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      await dueTick(r);
      const run = (await r.store.runs(s.id)).find((x) => x.outcome === "started" && x.taskStatus === "queued")!;
      await r.tasks.transition(run.taskId!, "planning");
      await r.tasks.transition(run.taskId!, "failed");
    }
    expect(r.created).toHaveLength(MAX_CONSECUTIVE_FAILURES);
    await dueTick(r); // the next moment: the streak is five failures
    expect(r.created).toHaveLength(MAX_CONSECUTIVE_FAILURES); // nothing new
    const after = (await r.store.list("alice"))[0]!;
    expect(after).toMatchObject({ enabled: false, pausedReason: "too_many_failures", nextRunAt: null });
    expect((await r.store.runs(s.id))[0]!.outcome).toBe("paused");
    // Turning it back on clears the pause.
    const back = await r.store.update("alice", s.id, { enabled: true });
    expect(back).toMatchObject({ enabled: true, pausedReason: null });
  });

  it("a success in between resets the count", async () => {
    const r = rig();
    const s = await r.store.create("alice", { ...daily8, schedule: { type: "interval", everyMinutes: 60 } });
    const finish = async (to: "failed" | "completed") => {
      await dueTick(r);
      const run = (await r.store.runs(s.id)).find((x) => x.outcome === "started" && x.taskStatus === "queued")!;
      await r.tasks.transition(run.taskId!, "planning");
      if (to === "failed") await r.tasks.transition(run.taskId!, "failed");
      else {
        await r.tasks.transition(run.taskId!, "running");
        await r.tasks.transition(run.taskId!, "verifying");
        await r.tasks.transition(run.taskId!, "completed");
      }
    };
    for (let i = 0; i < 4; i++) await finish("failed");
    await finish("completed");
    for (let i = 0; i < 4; i++) await finish("failed");
    expect((await r.store.list("alice"))[0]!.enabled).toBe(true); // 4 failures since the success, not 8
  });

  it("runs now on request, without moving the schedule, and still refuses to overlap", async () => {
    const r = rig();
    const s = await r.store.create("alice", daily8);
    const before = s.nextRunAt!.toISOString();
    const first = await r.scheduler.runNow("alice", s.id);
    expect(first.outcome).toBe("started");
    expect((await r.store.list("alice"))[0]!.nextRunAt!.toISOString()).toBe(before);
    expect((await r.scheduler.runNow("alice", s.id)).outcome).toBe("skipped_overlap");
    expect((await r.store.runs(s.id))[0]!.detail).toContain("manual");
    await expect(r.scheduler.runNow("bob", s.id)).rejects.toBeInstanceOf(ScheduleNotFoundError);
  });
});
