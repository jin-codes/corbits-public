import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresArtifactStore } from "../artifacts/artifact-store.js";
import { ApprovalStore } from "../persistence/approval-store.js";
import { ScheduleStore } from "../persistence/schedule-store.js";
import { TaskStore } from "../persistence/task-store.js";
import { hashToken } from "../runtime/config.js";
import type { LimitPolicy } from "../runtime/limits.js";
import { Scheduler } from "../runtime/scheduler.js";
import { TaskService } from "../runtime/task-service.js";
import { createTestDb } from "../testing/test-db.js";
import { LoginStateStore } from "../vault/login-state-store.js";
import { buildApi } from "./server.js";

const ALICE = "alice-token-".padEnd(40, "a");
const BOB = "bob-token-".padEnd(40, "b");
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const policy: LimitPolicy = {
  defaults: { maxToolCalls: 30, maxRuntimeMs: 600_000, maxSpendUsd: 0.5, maxSteps: 40, maxRecoveryAttempts: 1 },
  maximums: { maxToolCalls: 60, maxRuntimeMs: 1_800_000, maxSpendUsd: 2, maxSteps: 70, maxRecoveryAttempts: 2 },
};
const body = { name: "Morning check", goal: "Read the dashboard", schedule: { type: "daily", time: "08:00" }, timezone: "Asia/Seoul" };

let db: Awaited<ReturnType<typeof createTestDb>>;
let cleaner: ReturnType<(typeof db)["connect"]>;
beforeAll(async () => {
  db = await createTestDb();
  cleaner = db.connect();
});
afterAll(async () => db.cleanup());
beforeEach(async () => {
  await cleaner.query("DELETE FROM schedules");
  await cleaner.query("DELETE FROM login_states");
});

function rig(opts: { schedules?: boolean } = {}) {
  const pool = db.connect();
  const store = new TaskStore(pool);
  const logins = new LoginStateStore(pool, randomBytes(32));
  const service = new TaskService({ store, approvals: new ApprovalStore(pool), queue: { enqueueRun: async () => {} }, limits: policy, artifacts: new PostgresArtifactStore(pool), abortRun: () => {}, logins });
  const schedules = new ScheduleStore(pool);
  const scheduler = new Scheduler({ store: schedules, tasks: service, isActive: async () => true, canStart: async () => true, existingLogins: (o, n) => logins.existing(o, n) });
  const app = buildApi({ service, tokenOwners: new Map([[hashToken(ALICE), "alice"], [hashToken(BOB), "bob"]]), ...(opts.schedules === false ? {} : { schedules, scheduler }) });
  const post = (token: string, url: string, payload: unknown) => app.inject({ method: "POST", url, headers: bearer(token), payload: payload as never });
  return { app, store, logins, post };
}

describe("schedules over HTTP", () => {
  it("creates, lists, pauses, resumes and deletes a schedule, showing when it runs next", async () => {
    const { app, post } = rig();
    const created = await post(ALICE, "/schedules", body);
    expect(created.statusCode).toBe(201);
    const s = created.json();
    expect(s).toMatchObject({ name: "Morning check", enabled: true, timezone: "Asia/Seoul", lastRun: null });
    expect(new Date(s.nextRunAt).getTime()).toBeGreaterThan(Date.now());

    expect((await app.inject({ url: "/schedules", headers: bearer(ALICE) })).json().schedules).toHaveLength(1);
    const paused = await app.inject({ method: "PATCH", url: `/schedules/${s.id}`, headers: bearer(ALICE), payload: { enabled: false } });
    expect(paused.json()).toMatchObject({ enabled: false, nextRunAt: null });
    const resumed = await app.inject({ method: "PATCH", url: `/schedules/${s.id}`, headers: bearer(ALICE), payload: { enabled: true } });
    expect(resumed.json().nextRunAt).not.toBeNull();
    expect((await app.inject({ method: "DELETE", url: `/schedules/${s.id}`, headers: bearer(ALICE) })).statusCode).toBe(204);
    expect((await app.inject({ url: "/schedules", headers: bearer(ALICE) })).json().schedules).toEqual([]);
    await app.close();
  });

  it("refuses bad input with a reason: too frequent, wrong time, unknown zone, a login you do not have", async () => {
    const { app, post, logins } = rig();
    for (const bad of [
      { ...body, schedule: { type: "interval", everyMinutes: 5 } },
      { ...body, schedule: { type: "daily", time: "25:00" } },
      { ...body, schedule: { type: "weekly", days: [], time: "08:00" } },
      { ...body, timezone: "Mars/Base" },
      { ...body, name: "" },
      { ...body, extra: true },
    ]) {
      expect((await post(ALICE, "/schedules", bad)).statusCode).toBe(400);
    }
    expect((await post(ALICE, "/schedules", { ...body, logins: ["nope"] })).statusCode).toBe(400);
    await logins.put("bob", "bobs", "https://a.example", { cookies: [{ name: "s", value: "v".repeat(20), domain: "a.example", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }], origins: [] });
    expect((await post(ALICE, "/schedules", { ...body, logins: ["bobs"] })).statusCode).toBe(400); // someone else's login is not hers
    await app.close();
  });

  it("keeps each person's schedules to themselves", async () => {
    const { app, post } = rig();
    const s = (await post(ALICE, "/schedules", body)).json();
    expect((await app.inject({ url: "/schedules", headers: bearer(BOB) })).json().schedules).toEqual([]);
    for (const [method, url] of [["PATCH", `/schedules/${s.id}`], ["DELETE", `/schedules/${s.id}`], ["POST", `/schedules/${s.id}/run`], ["GET", `/schedules/${s.id}/runs`]] as const) {
      const res = await app.inject({ method, url, headers: bearer(BOB), ...(method === "PATCH" ? { payload: { enabled: false } as never } : {}) });
      expect(res.statusCode).toBe(404);
    }
    expect((await app.inject({ url: "/schedules" })).statusCode).toBe(401);
    expect((await app.inject({ url: `/schedules/not-a-uuid/runs`, headers: bearer(ALICE) })).statusCode).toBe(400);
    await app.close();
  });

  it("runs now into an ordinary task that records where it came from, and shows the run in the history", async () => {
    const { app, post, store } = rig();
    const s = (await post(ALICE, "/schedules", { ...body, limits: { maxSpendUsd: 0.2 } })).json();
    const run = await post(ALICE, `/schedules/${s.id}/run`, {});
    expect(run.statusCode).toBe(201);
    const { taskId } = run.json();
    const task = await store.getTask(taskId);
    expect(task).toMatchObject({ owner: "alice", goal: "Read the dashboard", status: "queued" });
    expect(task.constraints.scheduleId).toBe(s.id);
    expect((task.constraints.limits as { maxSpendUsd: number }).maxSpendUsd).toBe(0.2);
    expect((await store.listEvents(taskId)).find((e) => e.type === "task.scheduled")!.payload).toMatchObject({ scheduleId: s.id, name: "Morning check" });

    const timeline = (await app.inject({ url: `/tasks/${taskId}/timeline`, headers: bearer(ALICE) })).json();
    expect(JSON.stringify(timeline)).toContain("Morning check");
    const runs = (await app.inject({ url: `/schedules/${s.id}/runs`, headers: bearer(ALICE) })).json().runs;
    expect(runs[0]).toMatchObject({ outcome: "started", taskId, taskStatus: "queued" });
    expect((await app.inject({ url: "/schedules", headers: bearer(ALICE) })).json().schedules[0].lastRun).toMatchObject({ outcome: "started", taskId });

    const again = await post(ALICE, `/schedules/${s.id}/run`, {}); // the first is still queued
    expect(again.statusCode).toBe(200);
    expect(again.json().outcome).toBe("skipped_overlap");
    await app.close();
  });

  it("says plainly when the server has schedules switched off", async () => {
    const { app, post } = rig({ schedules: false });
    expect((await app.inject({ url: "/schedules", headers: bearer(ALICE) })).statusCode).toBe(503);
    expect((await post(ALICE, "/schedules", body)).statusCode).toBe(503);
    await app.close();
  });
});
