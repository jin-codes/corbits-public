import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresArtifactStore } from "../artifacts/artifact-store.js";
import { ApprovalStore } from "../persistence/approval-store.js";
import { TaskStore } from "../persistence/task-store.js";
import type { ModelAdapter, PlanResult, StepRequest, StepResult } from "../model/types.js";
import { Redactor } from "../security/redact.js";
import { MockBrowser } from "../testing/mock-browser.js";
import { USAGE, finish } from "../testing/mock-model.js";
import { createTestDb } from "../testing/test-db.js";
import { BrowserSessions } from "./browser-sessions.js";
import type { LimitPolicy } from "./limits.js";
import { createModelRouter } from "./model-router.js";
import { TaskRunner } from "./task-runner.js";

const policy: LimitPolicy = {
  defaults: { maxToolCalls: 30, maxRuntimeMs: 600_000, maxSpendUsd: 0.5, maxSteps: 40, maxRecoveryAttempts: 1 },
  maximums: { maxToolCalls: 60, maxRuntimeMs: 1_800_000, maxSpendUsd: 2, maxSteps: 70, maxRecoveryAttempts: 2 },
};
const SECRET_KEY = "sk-ant-api03-" + "Zz9Yy8Xx7Ww6Vv5Uu4Tt3".repeat(3);

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => void (db = await createTestDb()));
afterAll(async () => db.cleanup());

/** A model that records who asked it, so we can see whose account a task ran on. */
class Recording implements ModelAdapter {
  readonly asked: string[] = [];
  constructor(readonly name: string, private readonly errorWith?: string) {}
  async plan(): Promise<PlanResult> {
    this.asked.push("plan");
    if (this.errorWith) throw new Error(this.errorWith);
    return { steps: ["x"], criteria: [{ kind: "text_present", value: "Example" }], usage: USAGE };
  }
  async step(_req: StepRequest): Promise<StepResult> {
    this.asked.push("step");
    return finish("done");
  }
}

function setup(opts: { serverIsShareable: boolean; keys: Record<string, string>; admins?: string[] }) {
  const pool = db.connect();
  const store = new TaskStore(pool, new Redactor());
  const approvals = new ApprovalStore(pool);
  const server = new Recording("server");
  const own = new Map<string, Recording>();
  const redactor = new Redactor();
  const modelFor = createModelRouter({
    defaultModel: server,
    isAdmin: async (o) => (opts.admins ?? []).includes(o),
    ownKey: async (o) => opts.keys[o] ?? null,
    serverModelIsShareable: opts.serverIsShareable,
    forKey: (k) => {
      const m = new Recording(`own:${k.slice(-4)}`);
      own.set(k, m);
      return m;
    },
    onKey: (k) => redactor.addSecret(k),
  });
  const sessions = new BrowserSessions(async () => new MockBrowser({ "about:blank": { content: `- heading "Example"` } }), 60_000);
  const runner = new TaskRunner({ store, approvals, model: server, modelFor, sessions, limits: policy, artifacts: new PostgresArtifactStore(pool), redactor });
  return { store, runner, server, own, sessions };
}

describe("a task runs on the model its owner is entitled to", () => {
  it("runs a person's task on their own key and never touches the server's model", async () => {
    const { store, runner, server, own, sessions } = setup({ serverIsShareable: false, keys: { alice: SECRET_KEY } });
    const task = await store.createTask({ owner: "alice", goal: "g", completionCriteria: [{ kind: "text_present", value: "Example" }] });
    await runner.run(task.id);
    expect(server.asked).toEqual([]); // the owner's login/key was not used
    expect(own.get(SECRET_KEY)!.asked).toContain("plan");
    await sessions.closeAll();
  });

  it("fails a keyless person's task cleanly instead of using the owner's personal login", async () => {
    const { store, runner, server, sessions } = setup({ serverIsShareable: false, keys: {} });
    const task = await store.createTask({ owner: "bob", goal: "g", completionCriteria: [{ kind: "text_present", value: "Example" }] });
    const result = await runner.run(task.id);
    expect(result.status).toBe("failed");
    expect(server.asked).toEqual([]);
    const events = await store.listEvents(task.id);
    const err = events.find((e) => e.type === "model.error")!;
    expect(String(err.payload.message)).toContain("own Anthropic API key");
    await sessions.closeAll();
  });

  it("gives an admin the server's model", async () => {
    const { store, runner, server, sessions } = setup({ serverIsShareable: false, keys: {}, admins: ["boss"] });
    const task = await store.createTask({ owner: "boss", goal: "g", completionCriteria: [{ kind: "text_present", value: "Example" }] });
    await runner.run(task.id);
    expect(server.asked).toContain("plan");
    await sessions.closeAll();
  });

  it("scrubs a person's key from history even if a model error echoes it", async () => {
    const pool = db.connect();
    const redactor = new Redactor();
    const store = new TaskStore(pool, redactor);
    const leaky = new Recording("own", `401 invalid x-api-key: ${SECRET_KEY}`);
    const modelFor = createModelRouter({
      defaultModel: new Recording("server"),
      isAdmin: async () => false,
      ownKey: async () => SECRET_KEY,
      serverModelIsShareable: false,
      forKey: () => leaky,
      onKey: (k) => redactor.addSecret(k),
    });
    const sessions = new BrowserSessions(async () => new MockBrowser({ "about:blank": { content: `- heading "Example"` } }), 60_000);
    const runner = new TaskRunner({ store, approvals: new ApprovalStore(pool), model: new Recording("server"), modelFor, sessions, limits: policy, artifacts: new PostgresArtifactStore(pool), redactor });
    const task = await store.createTask({ owner: "alice", goal: "g", completionCriteria: [{ kind: "text_present", value: "Example" }] });
    await runner.run(task.id);
    const everything = JSON.stringify(await store.listEvents(task.id));
    expect(everything).not.toContain(SECRET_KEY);
    expect(everything).not.toContain(SECRET_KEY.slice(0, 30));
    await sessions.closeAll();
  });
});
