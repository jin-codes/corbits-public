import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresArtifactStore } from "../artifacts/artifact-store.js";
import { ApprovalStore } from "../persistence/approval-store.js";
import { TaskStore } from "../persistence/task-store.js";
import { createTestDb } from "../testing/test-db.js";
import type { LimitPolicy } from "./limits.js";
import { TaskService } from "./task-service.js";

const policy: LimitPolicy = {
  defaults: { maxToolCalls: 30, maxRuntimeMs: 600_000, maxSpendUsd: 0.5, maxSteps: 40, maxRecoveryAttempts: 1 },
  maximums: { maxToolCalls: 60, maxRuntimeMs: 1_800_000, maxSpendUsd: 2, maxSteps: 70, maxRecoveryAttempts: 2 },
};
const grant = { tool: "browser.click" as const, origin: "https://blog.example.com", names: ["Publish now"] };

let db: Awaited<ReturnType<typeof createTestDb>>;
let store: TaskStore;
let service: TaskService;
beforeAll(async () => {
  db = await createTestDb();
  const pool = db.connect();
  store = new TaskStore(pool);
  // A fake queue: nothing runs, so nothing is left behind in the job queue.
  service = new TaskService({
    store,
    approvals: new ApprovalStore(pool),
    queue: { enqueueRun: async () => {} },
    limits: policy,
    artifacts: new PostgresArtifactStore(pool),
    abortRun: () => {},
  });
});
afterAll(async () => db.cleanup());

describe("standing approvals on a task", () => {
  it("are stored with the task when the owner gives them", async () => {
    const t = await service.createTask("alice", { goal: "publish", standingApprovals: [grant] });
    expect((await store.getTask(t.id)).constraints.standingApprovals).toEqual([grant]);
  });

  it("are not carried over when the task is continued", async () => {
    const t = await service.createTask("alice", { goal: "publish", standingApprovals: [grant] });
    await service.cancel("alice", t.id);
    const again = await service.continueTask("alice", t.id, {});
    expect((await store.getTask(again.id)).constraints.standingApprovals).toBeUndefined();
  });

  it("a task made without them has none", async () => {
    const t = await service.createTask("alice", { goal: "publish" });
    expect((await store.getTask(t.id)).constraints.standingApprovals).toBeUndefined();
  });
});
