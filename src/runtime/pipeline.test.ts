import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BrowserAdapter } from "../execution/browser-adapter.js";
import { PostgresArtifactStore } from "../artifacts/artifact-store.js";
import { ApprovalStore } from "../persistence/approval-store.js";
import { TaskStore } from "../persistence/task-store.js";
import { NotificationDispatcher } from "../notifications/dispatcher.js";
import { notificationOutbox } from "../notifications/outbox.js";
import type { EmailMessage } from "../notifications/email.js";
import { MockBrowser } from "../testing/mock-browser.js";
import { MockModel, call, done, finish } from "../testing/mock-model.js";
import { createTestDb } from "../testing/test-db.js";
import type { StepRequest } from "../model/types.js";
import { BrowserSessions } from "./browser-sessions.js";
import type { LimitPolicy } from "./limits.js";
import { TaskQueue } from "./queue.js";
import { TaskRunner } from "./task-runner.js";
import { TaskService } from "./task-service.js";

const HOME = "https://example.com/";
const DONE = "https://example.com/done";
const policy: LimitPolicy = {
  defaults: { maxToolCalls: 30, maxRuntimeMs: 600_000, maxSpendUsd: 0.5, maxSteps: 40, maxRecoveryAttempts: 1 },
  maximums: { maxToolCalls: 60, maxRuntimeMs: 1_800_000, maxSpendUsd: 2, maxSteps: 70, maxRecoveryAttempts: 2 },
};
const pages = () => ({
  [HOME]: {
    content: `- heading "Example"`,
    elements: [
      { role: "button" as const, name: "Next", goto: DONE },
      { role: "button" as const, name: "Send message", effect: "message-sent", sets: "Sent" },
    ],
  },
  [DONE]: { content: `- heading "Done"` },
});

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => void (db = await createTestDb()));
afterAll(async () => db.cleanup());

interface Rig {
  store: TaskStore;
  approvals: ApprovalStore;
  service: TaskService;
  artifacts: PostgresArtifactStore;
  sessions: BrowserSessions;
  runner: TaskRunner;
  queue: TaskQueue;
  browsers: MockBrowser[];
  model: MockModel;
}
const rigs: Rig[] = [];

async function startRig(opts: {
  decide: (req: StepRequest) => ReturnType<MockModel["step"]> | ReturnType<typeof finish>;
  launch?: () => Promise<BrowserAdapter>;
  startWorker?: boolean;
  idleMs?: number;
}): Promise<Rig> {
  const pool = db.connect();
  const store = new TaskStore(pool, undefined, notificationOutbox);
  const approvals = new ApprovalStore(pool);
  const artifacts = new PostgresArtifactStore(pool);
  const browsers: MockBrowser[] = [];
  const model = new MockModel(opts.decide as never);
  const sessions = new BrowserSessions(
    opts.launch ??
      (async () => {
        const b = new MockBrowser(pages());
        browsers.push(b);
        return b;
      }),
    opts.idleMs ?? 60_000,
  );
  const runner = new TaskRunner({ store, approvals, model, sessions, limits: policy, artifacts });
  const queue = new TaskQueue({
    connectionString: db.url,
    schema: `${db.bossSchema}_${rigs.length}`,
    maxRunSeconds: 600,
    retryDelaySeconds: 1,
  });
  await queue.start();
  const service = new TaskService({ store, approvals, queue, limits: policy, artifacts, abortRun: (id) => runner.abort(id) });
  const rig = { store, approvals, service, artifacts, sessions, runner, queue, browsers, model };
  rigs.push(rig);
  if (opts.startWorker !== false) {
    await queue.startWorker(async (id, ctx) => void (await runner.run(id, ctx.signal)), {
      concurrency: 2,
      onFinalFailure: (id, err) => runner.failTask(id, "worker_error", String(err)),
    });
  }
  return rig;
}

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.queue.stop(3000).catch(() => {});
    await r.sessions.closeAll();
  }
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
const statusIs = (rig: Rig, id: string, status: string) => async () => (await rig.store.getTask(id)).status === status || undefined;

const happy = (req: StepRequest) => {
  if (!done(req, "browser.goto")) return call("browser.goto", { url: HOME });
  if (!done(req, "browser.click")) return call("browser.click", { ref: "e1" });
  return finish();
};
const DONE_CRITERIA = { completionCriteria: [{ kind: "text_present" as const, value: "Done" }] };

describe("task pipeline: API service -> pg-boss -> worker -> orchestrator", () => {
  it("runs a submitted task to a verified completion and releases its browser", async () => {
    const rig = await startRig({ decide: happy });
    const t = await rig.service.createTask("alice", { goal: "reach done", ...DONE_CRITERIA });
    await waitFor(statusIs(rig, t.id, "completed"));
    expect(rig.browsers).toHaveLength(1);
    await waitFor(async () => !rig.sessions.has(t.id));
    const detail = await rig.service.getTask("alice", t.id);
    expect(detail.lastTransition).toMatchObject({ to: "completed", outcome: "verified" });
  });

  it("collapses duplicate enqueues: the task is planned and run once", async () => {
    const rig = await startRig({ decide: happy, startWorker: false });
    const t = await rig.service.createTask("alice", { goal: "reach done", ...DONE_CRITERIA });
    await rig.queue.enqueueRun(t.id);
    await rig.queue.enqueueRun(t.id);
    let jobsHandled = 0;
    await rig.queue.startWorker(
      async (id, ctx) => {
        jobsHandled++;
        await rig.runner.run(id, ctx.signal);
      },
      { concurrency: 1, onFinalFailure: async () => {} },
    );
    await waitFor(statusIs(rig, t.id, "completed"));
    await new Promise((r) => setTimeout(r, 2500)); // give any stray duplicate time to show up
    expect(jobsHandled).toBe(1); // three enqueue calls, one job
    expect(rig.model.planCalls).toBe(1);
  });

  it("queues different tasks independently while collapsing duplicates per task", async () => {
    const rig = await startRig({ decide: happy, startWorker: false });
    const a = await rig.service.createTask("alice", { goal: "a", ...DONE_CRITERIA });
    const b = await rig.service.createTask("alice", { goal: "b", ...DONE_CRITERIA });
    await rig.queue.enqueueRun(a.id);
    let jobsHandled = 0;
    await rig.queue.startWorker(
      async (id, ctx) => {
        jobsHandled++;
        await rig.runner.run(id, ctx.signal);
      },
      { concurrency: 2, onFinalFailure: async () => {} },
    );
    await waitFor(statusIs(rig, a.id, "completed"));
    await waitFor(statusIs(rig, b.id, "completed"));
    await new Promise((r) => setTimeout(r, 1500));
    expect(jobsHandled).toBe(2);
  });

  it("pauses for approval on the same browser, then resumes it after the owner approves", async () => {
    const send = (req: StepRequest) =>
      !done(req, "browser.goto") ? call("browser.goto", { url: HOME }) : done(req, "browser.click") ? finish() : call("browser.click", { ref: "e2" });
    const rig = await startRig({ decide: send });
    const t = await rig.service.createTask("alice", { goal: "send it", completionCriteria: [{ kind: "text_present", value: "Sent" }] });
    await waitFor(statusIs(rig, t.id, "awaiting_approval"));
    expect(rig.browsers[0]!.effects).toEqual([]);
    expect(rig.sessions.has(t.id)).toBe(true); // kept alive while waiting

    const [pending] = await rig.service.listPendingApprovals("alice");
    expect(pending!.context).toMatchObject({ target: { name: "Send message" } });
    await rig.service.decideApproval("alice", pending!.id, "approved");
    await waitFor(statusIs(rig, t.id, "completed"));
    expect(rig.browsers).toHaveLength(1); // same browser throughout
    expect(rig.browsers[0]!.effects).toEqual(["message-sent"]);
  });

  it("emails the owner about the approval request and the verified completion, once each", async () => {
    const send = (req: StepRequest) =>
      !done(req, "browser.goto") ? call("browser.goto", { url: HOME }) : done(req, "browser.click") ? finish() : call("browser.click", { ref: "e2" });
    const rig = await startRig({ decide: send });
    const pool = db.connect();
    const sent: EmailMessage[] = [];
    const dispatcher = new NotificationDispatcher({
      pool,
      store: rig.store,
      approvals: rig.approvals,
      sender: { send: async (m) => void sent.push(m) },
      ownerEmails: new Map([["mailer", "mailer@example.com"]]),
    });
    const t = await rig.service.createTask("mailer", { goal: "send it", completionCriteria: [{ kind: "text_present", value: "Sent" }] });
    await waitFor(statusIs(rig, t.id, "awaiting_approval"));
    await dispatcher.tick();
    const mine = () => sent.filter((m) => m.text.includes(t.id));
    expect(mine().map((m) => m.subject)).toEqual([expect.stringContaining("Approval needed")]);

    const [pending] = await rig.service.listPendingApprovals("mailer");
    await rig.service.decideApproval("mailer", pending!.id, "approved");
    await waitFor(statusIs(rig, t.id, "completed"));
    await dispatcher.tick();
    await dispatcher.tick();
    expect(mine().map((m) => m.subject)).toEqual([expect.stringContaining("Approval needed"), expect.stringContaining("completed (verified)")]);
  });

  it("captures evidence along the way: per-action screenshots, the page at approval time, and what the verifier saw", async () => {
    const send = (req: StepRequest) =>
      !done(req, "browser.goto") ? call("browser.goto", { url: HOME }) : done(req, "browser.click") ? finish() : call("browser.click", { ref: "e2" });
    const rig = await startRig({ decide: send });
    const t = await rig.service.createTask("alice", { goal: "send it", completionCriteria: [{ kind: "text_present", value: "Sent" }] });
    await waitFor(statusIs(rig, t.id, "awaiting_approval"));

    // The approver gets a screenshot of the page as it was when the agent asked.
    const [pending] = await rig.service.listPendingApprovals("alice");
    expect(pending!.screenshotId).toBeTruthy();
    const shot = await rig.service.getArtifact("alice", pending!.screenshotId!);
    expect(shot).toMatchObject({ kind: "screenshot", mime: "image/jpeg" });
    expect(shot.data.toString()).toContain("mock-screenshot|" + HOME);

    await rig.service.decideApproval("alice", pending!.id, "approved");
    await waitFor(statusIs(rig, t.id, "completed"));

    const files = await rig.service.listArtifacts("alice", t.id);
    const text = files.find((f) => f.kind === "page_text")!;
    expect((await rig.service.getArtifact("alice", text.id)).data.toString()).toContain("Sent");

    // Each history entry links to its evidence. (An unchanged page reuses the earlier image rather
    // than storing it twice, so the approval entry shares the screenshot taken after the first goto.)
    const timeline = await rig.service.getTimeline("alice", t.id);
    const kinds = (title: string) => timeline.items.find((i) => i.title.startsWith(title))?.artifacts?.map((a) => a.kind);
    expect(kinds("Open ")).toEqual(["screenshot"]);
    expect(kinds("Approval needed")).toEqual(["screenshot"]);
    expect(kinds("Click ")).toEqual(["screenshot"]);
    expect(kinds("Verified against")).toEqual(["screenshot", "page_text"]);
    const linked = timeline.items.flatMap((i) => i.artifacts ?? []).map((a) => a.id);
    for (const f of files) expect(linked).toContain(f.id);
  });

  it("a broken evidence capture never changes the outcome of the task", async () => {
    const rig = await startRig({
      decide: happy,
      launch: async () => {
        const b = new MockBrowser(pages());
        b.screenshot = async () => {
          throw new Error("renderer crashed");
        };
        return b;
      },
    });
    const t = await rig.service.createTask("alice", { goal: "reach done", ...DONE_CRITERIA });
    await waitFor(statusIs(rig, t.id, "completed"));
    const events = await rig.store.listEvents(t.id);
    expect(events.some((e) => e.type === "artifact.failed")).toBe(true);
    expect(events.find((e) => e.type === "verification.completed")!.payload).toMatchObject({ verdict: "verified" });
  });

  it("continues a failed task: new linked task, starts on the last page, and the model knows what happened", async () => {
    // Attempt 1 gets to the page, then claims it is done without the page showing the proof.
    const rig = await startRig({
      decide: (req) => {
        if (!done(req, "browser.goto")) return call("browser.goto", { url: HOME });
        // On the second attempt the model sees the earlier attempt and finishes the job.
        if (req.priorAttempt) return done(req, "browser.click") ? finish() : call("browser.click", { ref: "e1" });
        return finish("done");
      },
    });
    const first = await rig.service.createTask("alice", { goal: "reach done", ...DONE_CRITERIA, limits: { maxRecoveryAttempts: 0 } });
    await waitFor(statusIs(rig, first.id, "failed"));

    const next = await rig.service.continueTask("alice", first.id, { note: "click Next this time" });
    await waitFor(statusIs(rig, next.id, "completed"));

    const second = rig.model.stepRequests.filter((r) => r.priorAttempt);
    expect(second.length).toBeGreaterThan(0);
    expect(second[0]!.priorAttempt).toContain("browser.goto");
    expect(second[0]!.priorAttempt).toContain(HOME);
    expect(second[0]!.userNote).toBe("click Next this time");
    expect(second[0]!.goal).toBe("reach done");

    // It began on the page the first attempt ended on instead of from a blank browser.
    const events = await rig.store.listEvents(next.id);
    expect(events.find((e) => e.type === "session.restored")!.payload).toMatchObject({ url: HOME });
    // The first attempt is exactly as it was.
    expect((await rig.store.getTask(first.id)).status).toBe("failed");
    expect((await rig.service.getTask("alice", first.id)).continuations.map((c) => c.id)).toEqual([next.id]);
  });

  it("a rejected approval is never executed", async () => {
    const send = (req: StepRequest) =>
      !done(req, "browser.goto")
        ? call("browser.goto", { url: HOME })
        : req.observations.some((o) => o.kind === "approval_rejected")
          ? finish()
          : call("browser.click", { ref: "e2" });
    const rig = await startRig({ decide: send });
    const t = await rig.service.createTask("alice", {
      goal: "send it",
      completionCriteria: [{ kind: "text_present", value: "Sent" }],
      limits: { maxRecoveryAttempts: 0 },
    });
    await waitFor(statusIs(rig, t.id, "awaiting_approval"));
    const [pending] = await rig.service.listPendingApprovals("alice");
    await rig.service.decideApproval("alice", pending!.id, "rejected");
    await waitFor(statusIs(rig, t.id, "failed"));
    expect(rig.browsers[0]!.effects).toEqual([]);
  });

  it("restores the last page when the browser session was lost while waiting", async () => {
    const send = (req: StepRequest) =>
      !done(req, "browser.goto") ? call("browser.goto", { url: HOME }) : done(req, "browser.click") ? finish() : call("browser.snapshot", {});
    const rig = await startRig({
      decide: (req) => {
        if (!done(req, "browser.goto")) return call("browser.goto", { url: HOME });
        const snapshots = req.observations.filter((o) => o.kind === "tool_result" && o.tool === "browser.snapshot").length;
        if (snapshots === 0) return call("browser.click", { ref: "e2" }); // needs approval
        return done(req, "browser.click") ? finish() : call("browser.snapshot", {});
      },
    });
    void send;
    const t = await rig.service.createTask("alice", { goal: "send it", completionCriteria: [{ kind: "text_present", value: "Sent" }] });
    await waitFor(statusIs(rig, t.id, "awaiting_approval"));
    await rig.sessions.close(t.id); // simulate restart / idle expiry

    const [pending] = await rig.service.listPendingApprovals("alice");
    await rig.service.decideApproval("alice", pending!.id, "approved");
    // A fresh browser comes back on the last known page; the old ref e2 is rejected until a new snapshot is taken.
    await waitFor(async () => (await rig.store.listEvents(t.id)).some((e) => e.type === "session.restored") || undefined);
    expect(rig.browsers).toHaveLength(2);
    const restored = (await rig.store.listEvents(t.id)).find((e) => e.type === "session.restored")!;
    expect(restored.payload).toMatchObject({ url: HOME });
  });

  it("retries a failing job, then marks the task failed when retries run out", async () => {
    const rig = await startRig({
      decide: happy,
      launch: async () => {
        throw new Error("chromium crashed");
      },
    });
    const t = await rig.service.createTask("alice", { goal: "reach done", ...DONE_CRITERIA });
    await waitFor(statusIs(rig, t.id, "failed"), 40_000);
    const events = await rig.store.listEvents(t.id);
    expect(events.find((e) => e.payload.to === "failed")!.payload).toMatchObject({ reason: "worker_error" });
    expect(JSON.stringify(events)).toContain("chromium crashed");
  }, 45_000);

  it("a task cancelled while queued does nothing when its job runs", async () => {
    const rig = await startRig({ decide: happy, startWorker: false });
    const t = await rig.service.createTask("alice", { goal: "reach done", ...DONE_CRITERIA });
    await rig.service.cancel("alice", t.id);
    await rig.queue.startWorker(async (id, ctx) => void (await rig.runner.run(id, ctx.signal)), { concurrency: 1, onFinalFailure: async () => {} });
    await new Promise((r) => setTimeout(r, 2500));
    expect((await rig.store.getTask(t.id)).status).toBe("cancelled");
    expect(rig.model.planCalls).toBe(0);
    expect(rig.browsers).toHaveLength(0);
  });
});
