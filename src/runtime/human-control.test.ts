import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresArtifactStore } from "../artifacts/artifact-store.js";
import { ApprovalStore } from "../persistence/approval-store.js";
import { TaskStore } from "../persistence/task-store.js";
import type { ModelAdapter, PlanResult, StepRequest, StepResult } from "../model/types.js";
import { MockBrowser } from "../testing/mock-browser.js";
import { USAGE, call, finish } from "../testing/mock-model.js";
import { createTestDb } from "../testing/test-db.js";
import { hashToken } from "./config.js";
import { buildApi } from "../api/server.js";
import { BrowserSessions } from "./browser-sessions.js";
import type { LimitPolicy } from "./limits.js";
import { TaskRunner } from "./task-runner.js";
import { ConflictError, NotFoundError, TaskService } from "./task-service.js";

const HOME = "https://example.com/";
const policy: LimitPolicy = {
  defaults: { maxToolCalls: 30, maxRuntimeMs: 600_000, maxSpendUsd: 0.5, maxSteps: 40, maxRecoveryAttempts: 1 },
  maximums: { maxToolCalls: 60, maxRuntimeMs: 1_800_000, maxSpendUsd: 2, maxSteps: 70, maxRecoveryAttempts: 2 },
};
const TOKEN = "alice-token-".padEnd(40, "a");
const OTHER = "bob-token-".padEnd(40, "b");

/** Waits inside step() until the run is interrupted, like a slow model call that gets aborted. */
class SlowModel implements ModelAdapter {
  readonly stepRequests: StepRequest[] = [];
  blocking = true;
  constructor(private readonly then: (req: StepRequest) => StepResult) {}
  async plan(): Promise<PlanResult> {
    return { steps: ["do it"], criteria: [{ kind: "text_present", value: "Example" }], usage: USAGE };
  }
  async step(req: StepRequest, signal: AbortSignal): Promise<StepResult> {
    this.stepRequests.push(req);
    if (this.blocking) {
      await new Promise<never>((_, reject) => {
        if (signal.aborted) return reject(new Error("aborted"));
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    return this.then(req);
  }
}

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => void (db = await createTestDb()));
afterAll(async () => db.cleanup());

async function rig() {
  const pool = db.connect();
  const store = new TaskStore(pool);
  const approvals = new ApprovalStore(pool);
  const artifacts = new PostgresArtifactStore(pool);
  const browsers: MockBrowser[] = [];
  const sessions = new BrowserSessions(async () => {
    const b = new MockBrowser({ [HOME]: { content: `- heading "Example"`, elements: [{ role: "textbox", name: "Code", inputType: "text" }] } });
    browsers.push(b);
    return b;
  }, 60_000);
  const model = new SlowModel((req) => (req.observations.some((o) => o.kind === "tool_result" && o.tool === "browser.goto") ? finish() : call("browser.goto", { url: HOME })));
  const runner = new TaskRunner({ store, approvals, model, sessions, limits: policy, artifacts });
  const enqueued: string[] = [];
  const service = new TaskService({
    store,
    approvals,
    queue: { enqueueRun: async (id) => void enqueued.push(id) },
    limits: policy,
    artifacts,
    abortRun: (id) => runner.abort(id),
    human: { browser: (id) => sessions.peek(id), isRunActive: (id) => runner.isActive(id), touch: (id) => sessions.keep(id) },
  });
  const api = buildApi({ service, tokenOwners: new Map([[hashToken(TOKEN), "alice"], [hashToken(OTHER), "bob"]]) });
  await api.ready();
  /** Starts a task and leaves it blocked inside its first model step. */
  const runs: Array<{ id: string; running: Promise<unknown> }> = [];
  const startRunning = async () => {
    const t = await service.createTask("alice", { goal: "open example" });
    const running = runner.run(t.id);
    runs.push({ id: t.id, running });
    for (let i = 0; i < 200 && model.stepRequests.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    return { id: t.id, running };
  };
  return { store, sessions, model, runner, service, api, browsers, enqueued, startRunning, close: async () => {
      // Free any run still blocked in the model, so its lease and connection are released.
      for (const run of runs) runner.abort(run.id);
      await Promise.all(runs.map((run) => run.running.catch(() => {})));
      await api.close();
      await sessions.closeAll();
    },
  };
}
const as = (token: string) => ({ authorization: `Bearer ${token}` });

describe("human control of the live browser", () => {
  it("interrupts the agent, lets the owner drive, then hands back so the agent continues and is told the page may have changed", async () => {
    const r = await rig();
    const { id, running } = await r.startRunning();
    expect((await r.store.getTask(id)).status).toBe("running");

    const view = await r.service.takeControl("alice", id);
    expect(view.status).toBe("human_control");
    // The interrupted run reports the state it stopped in; the takeover then moved the task on.
    expect((await running).status).toBe("running");
    expect(r.runner.isActive(id)).toBe(false);

    await r.service.humanInput("alice", id, { type: "click", x: 10, y: 20 });
    await r.service.humanInput("alice", id, { type: "text", text: "hunter2-super-secret" });
    await r.service.humanInput("alice", id, { type: "key", key: "Enter" });
    expect(r.browsers[0]!.humanInputs).toEqual([
      { type: "click", x: 10, y: 20 },
      { type: "text", text: "hunter2-super-secret" },
      { type: "key", key: "Enter" },
    ]);

    await r.service.releaseControl("alice", id, { note: "I solved the captcha" });
    expect(r.enqueued).toContain(id);
    expect((await r.store.getTask(id)).status).toBe("running");

    // The agent carries on from the persisted state and sees the handover.
    r.model.blocking = false;
    const result = await r.runner.run(id);
    expect(result.status).toBe("completed");
    const handover = r.model.stepRequests.at(-1)!.observations.find((o) => o.kind === "tool_result" && o.tool === "human.control");
    expect(JSON.stringify(handover)).toContain("take a new snapshot");
    expect(JSON.stringify(handover)).toContain("I solved the captcha");

    // History records that control happened and how much, but never what was typed.
    const events = await r.store.listEvents(id);
    const ended = events.find((e) => e.type === "human.control_ended")!;
    expect(ended.payload.inputs).toEqual({ clicks: 1, texts: 1, keys: 1, scrolls: 0 });
    expect(JSON.stringify(events)).not.toContain("hunter2-super-secret");
    await r.close();
  });

  it("ignores a duplicate run of the same task, so the real run can still be interrupted", async () => {
    const r = await rig();
    const { id, running } = await r.startRunning();
    // A second delivery of the same job while the first is in progress.
    expect(await r.runner.run(id)).toEqual({ status: "busy" });
    expect(r.runner.isActive(id)).toBe(true);
    expect(r.browsers).toHaveLength(1); // and it did not start another browser

    await r.service.takeControl("alice", id); // interrupts the real run; would have raced the old one
    expect((await running).status).toBe("running");
    expect(r.runner.isActive(id)).toBe(false);

    // After handing back, the task carries on instead of being blocked by a leftover run.
    await r.service.releaseControl("alice", id);
    r.model.blocking = false;
    expect((await r.runner.run(id)).status).toBe("completed");
    await r.close();
  });

  it("shows what the agent asked for on the task and in the list, until the browser is handed back", async () => {
    const r = await rig();
    const { id, running } = await r.startRunning();
    // Same thing the orchestrator does when the model returns request_help.
    r.runner.abort(id);
    await running;
    await r.store.appendEvent(id, "help.requested", { reason: "CAPTCHA on the login page" });
    await r.store.transition(id, "human_control", { payload: { reason: "agent_requested_help" } });

    expect((await r.service.getTask("alice", id)).helpRequest).toEqual({ reason: "CAPTCHA on the login page" });
    expect((await r.service.listTasks("alice", { limit: 10 })).find((t) => t.id === id)!.helpRequest).toEqual({ reason: "CAPTCHA on the login page" });
    expect((await r.api.inject({ url: `/tasks/${id}`, headers: as(TOKEN) })).json().helpRequest).toEqual({ reason: "CAPTCHA on the login page" });

    // The owner can drive straight away (there was no separate takeover), and hand-back counts their input.
    await r.service.humanInput("alice", id, { type: "click", x: 5, y: 5 });
    await r.service.releaseControl("alice", id, { note: "done" });
    const ended = (await r.store.listEvents(id)).find((e) => e.type === "human.control_ended")!;
    expect(ended.payload.inputs).toMatchObject({ clicks: 1 });
    expect((await r.service.getTask("alice", id)).helpRequest).toBeNull();
    await r.close();
  });

  it("does not count the person's time against the task's runtime", async () => {
    const r = await rig();
    const { id } = await r.startRunning();
    await r.service.takeControl("alice", id);
    const events = await r.store.listEvents(id);
    const to = events.filter((e) => e.type === "task.state_changed").map((e) => e.payload.to);
    expect(to.at(-1)).toBe("human_control");
    await r.close();
  });

  it("refuses input unless the task is under human control, and refuses takeover unless it is running", async () => {
    const r = await rig();
    const { id } = await r.startRunning();
    await expect(r.service.humanInput("alice", id, { type: "click", x: 1, y: 1 })).rejects.toBeInstanceOf(ConflictError);
    await r.service.takeControl("alice", id);
    await r.service.releaseControl("alice", id);
    await r.store.transition(id, "awaiting_approval");
    await expect(r.service.takeControl("alice", id)).rejects.toBeInstanceOf(ConflictError);
    await r.store.transition(id, "cancelled");
    await expect(r.service.takeControl("alice", id)).rejects.toBeInstanceOf(ConflictError);
    expect(r.browsers[0]!.humanInputs).toHaveLength(0);
    await r.close();
  });

  it("treats someone else's task as missing for every control action", async () => {
    const r = await rig();
    const { id } = await r.startRunning();
    await expect(r.service.takeControl("bob", id)).rejects.toBeInstanceOf(NotFoundError);
    await r.service.takeControl("alice", id);
    await expect(r.service.humanInput("bob", id, { type: "text", text: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(r.service.liveFrame("bob", id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(r.service.releaseControl("bob", id)).rejects.toBeInstanceOf(NotFoundError);
    expect(r.browsers[0]!.humanInputs).toHaveLength(0);
    await r.close();
  });

  it("serves the live frame and validates input over HTTP", async () => {
    const r = await rig();
    const { id } = await r.startRunning();
    const frame = await r.api.inject({ url: `/tasks/${id}/live`, headers: as(TOKEN) });
    expect(frame.statusCode).toBe(200);
    expect(frame.headers["content-type"]).toBe("image/jpeg");
    expect(frame.headers["cache-control"]).toBe("no-store");
    expect(frame.headers["x-frame-width"]).toBe("1280");
    expect((await r.api.inject({ url: `/tasks/${id}/live` })).statusCode).toBe(401);
    expect((await r.api.inject({ url: `/tasks/${id}/live`, headers: as(OTHER) })).statusCode).toBe(404);

    expect((await r.api.inject({ method: "POST", url: `/tasks/${id}/control/take`, headers: as(TOKEN) })).statusCode).toBe(200);
    const post = (payload: unknown) => r.api.inject({ method: "POST", url: `/tasks/${id}/control/input`, headers: as(TOKEN), payload: payload as never });
    expect((await post({ type: "click", x: 5, y: 5 })).statusCode).toBe(204);
    for (const bad of [{ type: "key", key: "rm -rf" }, { type: "text", text: "" }, { type: "text", text: "x".repeat(501) }, { type: "click", x: -1, y: 0 }, { type: "eval", code: "1" }, { type: "click", x: 1, y: 1, extra: 1 }]) {
      expect((await post(bad)).statusCode).toBe(400);
    }
    expect(r.browsers[0]!.humanInputs).toHaveLength(1);
    expect((await r.api.inject({ method: "POST", url: `/tasks/${id}/control/release`, headers: as(TOKEN), payload: { note: "ok" } })).statusCode).toBe(200);
    await r.close();
  });

  it("has no live view for a finished task", async () => {
    const r = await rig();
    const { id } = await r.startRunning();
    await r.store.transition(id, "cancelled");
    const res = await r.api.inject({ url: `/tasks/${id}/live`, headers: as(TOKEN) });
    expect(res.statusCode).toBe(409);
    await r.close();
  });
});
