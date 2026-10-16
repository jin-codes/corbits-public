import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresArtifactStore } from "../artifacts/artifact-store.js";
import { BrowserArtifactRecorder } from "../artifacts/recorder.js";
import { Orchestrator, type OrchestratorConfig } from "../orchestrator/orchestrator.js";
import { ApprovalStore } from "../persistence/approval-store.js";
import { TaskStore } from "../persistence/task-store.js";
import { PolicyEngine } from "../policy/policy-engine.js";
import { Redactor } from "../security/redact.js";
import { MockBrowser } from "../testing/mock-browser.js";
import { MockModel, call, done, finish } from "../testing/mock-model.js";
import { createTestDb } from "../testing/test-db.js";
import { createBrowserTools } from "../tools/browser-tools.js";
import { ToolRegistry } from "../tools/registry.js";
import { createVaultTools } from "../tools/vault-tools.js";
import { BrowserStateVerifier } from "../verification/verifier.js";
import { SecretStore } from "./secret-store.js";
import { OneTimeSecretStore } from "./one-time.js";
import { TaskService } from "../runtime/task-service.js";

// A login flow end to end with real encryption and a real database: the model only ever knows the
// credential's NAME, and the value reaches the page only after a human approves.
const PASSWORD = "Corr3ct-Horse-Battery-Staple";
const LOGIN = "https://app.example/login";

const pages = () => ({
  [LOGIN]: {
    content: `- heading "Sign in"`,
    elements: [
      { role: "textbox" as const, name: "Email", inputType: "email" }, // e1
      { role: "textbox" as const, name: "Password", inputType: "password", insideForm: true }, // e2
      { role: "button" as const, name: "Log in", insideForm: true, inputType: "submit", sets: "Welcome back" }, // e3
    ],
  },
});

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => void (db = await createTestDb()));
afterAll(async () => db.cleanup());

const cfg: OrchestratorConfig = {
  limits: { maxToolCalls: 30, maxRuntimeMs: 60_000, maxSpendUsd: 5 },
  maxSteps: 30,
  maxRecoveryAttempts: 0,
  grantedPermissions: new Set(["browser.navigate", "browser.click", "browser.type", "browser.read", "browser.type_secret"]),
};

async function rig() {
  const pool = db.connect();
  const redactor = new Redactor();
  const store = new TaskStore(pool, redactor);
  const approvals = new ApprovalStore(pool, redactor);
  const artifacts = new PostgresArtifactStore(pool);
  const vault = new SecretStore(pool, randomBytes(32));
  await vault.put("alice", { name: "app-password", origin: "https://app.example", value: PASSWORD });
  const browser = new MockBrowser(pages());
  const registry = new ToolRegistry();
  for (const t of [...createBrowserTools(browser), ...createVaultTools({ browser, vault, owner: "alice", redactor })]) registry.register(t);
  const model = new MockModel((req) => {
    if (!done(req, "browser.goto")) return call("browser.goto", { url: LOGIN });
    if (!done(req, "browser.type")) return call("browser.type", { ref: "e1", text: "alice@example.com" });
    const typed = req.observations.some((o) => o.kind === "tool_result" && o.tool === "browser.type_secret" && o.outcome.status === "ok");
    if (!typed) return call("browser.type_secret", { ref: "e2", secretName: "app-password" });
    if (!req.observations.some((o) => o.kind === "tool_result" && o.tool === "browser.click" && o.outcome.status === "ok")) return call("browser.click", { ref: "e3" });
    return finish("logged in");
  });
  const orch = new Orchestrator({
    store,
    approvals,
    registry,
    policy: new PolicyEngine(registry),
    model,
    verifier: new BrowserStateVerifier(browser),
    config: cfg,
    actionContext: async () => ({ url: browser.currentUrl() }),
    availableSecrets: async () => (await vault.list("alice")).map((m) => ({ name: m.name, origin: m.origin })),
    artifacts: new BrowserArtifactRecorder({ browser, artifacts, store, redactor }),
  });
  return { pool, store, approvals, artifacts, vault, browser, model, orch };
}

const dump = async (r: Awaited<ReturnType<typeof rig>>, taskId: string) =>
  JSON.stringify({
    events: await r.store.listEvents(taskId),
    approvals: (await r.pool.query("SELECT * FROM approvals WHERE task_id = $1", [taskId])).rows,
    artifacts: (await r.pool.query("SELECT label, attach_key, encode(data, 'escape') AS data FROM artifacts WHERE task_id = $1", [taskId])).rows,
    modelRequests: r.model.stepRequests,
  });

describe("logging in with a saved credential", () => {
  it("pauses for approval before typing, types only after approval, and the value is stored nowhere", async () => {
    const r = await rig();
    const task = await r.store.createTask({ owner: "alice", goal: "log in", completionCriteria: [{ kind: "text_present", value: "Welcome back" }] });

    // Run until the agent asks to use the credential.
    expect(await r.orch.run(task.id)).toEqual({ status: "awaiting_approval" });
    const [secretApproval] = await r.approvals.listPending(task.id);
    expect(secretApproval).toMatchObject({ tool: "browser.type_secret", consequentialKind: "use_credentials", input: { ref: "e2", secretName: "app-password" } });
    expect(secretApproval!.context).toMatchObject({ target: { name: "Password", inputType: "password", pageOrigin: "https://app.example", secretOrigin: "https://app.example" } });
    expect(r.browser.typed).toEqual([{ ref: "e1", text: "alice@example.com" }]); // the email, not the password

    // The user approves; the credential is typed. Submitting the form is a second, separate approval.
    await r.orch.decideApproval(secretApproval!.id, "approved", "alice");
    expect(await r.orch.run(task.id)).toEqual({ status: "awaiting_approval" });
    expect(r.browser.typed).toContainEqual({ ref: "e2", text: PASSWORD });
    const [submit] = await r.approvals.listPending(task.id);
    expect(submit).toMatchObject({ tool: "browser.click" });
    await r.orch.decideApproval(submit!.id, "approved", "alice");
    expect(await r.orch.run(task.id)).toEqual({ status: "completed" });

    // The password is in the page and nowhere else: not in history, approvals, evidence, or what the model saw.
    const everything = await dump(r, task.id);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).toContain("app-password"); // the NAME is fine to show
    expect(r.model.stepRequests[0]!.secrets).toEqual([{ name: "app-password", origin: "https://app.example" }]);
  });

  it("does nothing if the user rejects, and the agent cannot reach the same credential another way", async () => {
    const r = await rig();
    const task = await r.store.createTask({ owner: "alice", goal: "log in", completionCriteria: [{ kind: "text_present", value: "Welcome back" }] });
    await r.orch.run(task.id);
    const [pending] = await r.approvals.listPending(task.id);
    await r.orch.decideApproval(pending!.id, "rejected", "alice");
    await r.orch.run(task.id).catch(() => undefined);
    expect(r.browser.typed.some((t) => t.text === PASSWORD)).toBe(false);
    expect(await dump(r, task.id)).not.toContain(PASSWORD);
  });

  it("refuses without asking when the agent is on the wrong site", async () => {
    const r = await rig();
    const evil = new MockBrowser({ "https://evil.example/": { content: `- heading "Sign in"`, elements: [{ role: "textbox" as const, name: "Password", inputType: "password" }] } });
    await evil.goto("https://evil.example/");
    const registry = new ToolRegistry();
    for (const t of [...createBrowserTools(evil), ...createVaultTools({ browser: evil, vault: r.vault, owner: "alice", redactor: new Redactor() })]) registry.register(t);
    const model = new MockModel((req) => (req.observations.some((o) => o.kind === "tool_denied") ? finish() : call("browser.type_secret", { ref: "e1", secretName: "app-password" })));
    const orch = new Orchestrator({ store: r.store, approvals: r.approvals, registry, policy: new PolicyEngine(registry), model, verifier: new BrowserStateVerifier(evil), config: { ...cfg, maxRecoveryAttempts: 0 }, actionContext: async () => ({ url: evil.currentUrl() }) });
    const task = await r.store.createTask({ owner: "alice", goal: "log in", completionCriteria: [{ kind: "text_present", value: "Welcome" }] });
    await orch.run(task.id);
    expect(await r.approvals.listPending(task.id)).toHaveLength(0); // nobody was asked to approve it
    expect(evil.typed).toEqual([]);
    const denied = (await r.store.listEvents(task.id)).find((e) => e.type === "tool.denied")!;
    expect(denied.payload).toMatchObject({ code: "precondition_failed" });
  });
});

describe("entering the password in the approval card", () => {
  async function askRig() {
    const pool = db.connect();
    const redactor = new Redactor();
    const store = new TaskStore(pool, redactor);
    const approvals = new ApprovalStore(pool, redactor);
    const artifacts = new PostgresArtifactStore(pool);
    const key = randomBytes(32);
    const vault = new SecretStore(pool, key);
    const oneTime = new OneTimeSecretStore(pool, key);
    const browser = new MockBrowser(pages());
    const registry = new ToolRegistry();
    for (const t of [...createBrowserTools(browser), ...createVaultTools({ browser, vault, owner: "alice", redactor, oneTime })]) registry.register(t);
    const model = new MockModel((req) => {
      if (!done(req, "browser.goto")) return call("browser.goto", { url: LOGIN });
      if (!done(req, "browser.type")) return call("browser.type", { ref: "e1", text: "alice@example.com" });
      const entered = req.observations.some((o) => o.kind === "tool_result" && o.tool === "browser.ask_password" && o.outcome.status === "ok");
      if (!entered) return call("browser.ask_password", { ref: "e2" });
      if (!req.observations.some((o) => o.kind === "tool_result" && o.tool === "browser.click" && o.outcome.status === "ok")) return call("browser.click", { ref: "e3" });
      return finish("logged in");
    });
    const orch = new Orchestrator({
      store,
      approvals,
      registry,
      policy: new PolicyEngine(registry),
      model,
      verifier: new BrowserStateVerifier(browser),
      config: cfg,
      actionContext: async () => ({ url: browser.currentUrl() }),
      artifacts: new BrowserArtifactRecorder({ browser, artifacts, store, redactor }),
    });
    const service = new TaskService({
      store,
      approvals,
      queue: { enqueueRun: async () => undefined },
      limits: { defaults: { maxToolCalls: 30, maxRuntimeMs: 60_000, maxSpendUsd: 1, maxSteps: 30, maxRecoveryAttempts: 0 }, maximums: { maxToolCalls: 30, maxRuntimeMs: 60_000, maxSpendUsd: 1, maxSteps: 30, maxRecoveryAttempts: 0 } },
      artifacts,
      oneTime,
      vault,
      abortRun: () => undefined,
    });
    return { pool, store, approvals, artifacts, oneTime, vault, browser, model, orch, service };
  }

  const leaks = async (r: Awaited<ReturnType<typeof askRig>>, taskId: string) =>
    JSON.stringify({
      events: await r.store.listEvents(taskId),
      approvals: (await r.pool.query("SELECT * FROM approvals WHERE task_id = $1", [taskId])).rows,
      artifacts: (await r.pool.query("SELECT label, encode(data, 'escape') AS data FROM artifacts WHERE task_id = $1", [taskId])).rows,
      oneTimeRows: (await r.pool.query("SELECT t::text FROM approval_secrets t")).rows,
      views: await r.service.getTask("alice", taskId),
      timeline: await r.service.getTimeline("alice", taskId),
      modelRequests: r.model.stepRequests,
    });

  it("asks for the password in the approval, types it once after approval, and leaves no trace of it", async () => {
    const r = await askRig();
    const task = await r.store.createTask({ owner: "alice", goal: "log in", completionCriteria: [{ kind: "text_present", value: "Welcome back" }] });

    expect(await r.orch.run(task.id)).toEqual({ status: "awaiting_approval" });
    const [req] = await r.service.listPendingApprovals("alice");
    expect(req).toMatchObject({ tool: "browser.ask_password", needsSecret: true, consequentialKind: "use_credentials", summary: expect.stringContaining("Password") });
    expect(req!.screenshotId).toBeTruthy(); // the card shows the page the password is for
    expect(r.browser.typed.some((t) => t.text === PASSWORD)).toBe(false);

    // The user types the password into the card and approves; the browser types it, then the run continues.
    await r.service.decideApproval("alice", req!.id, "approved", { secret: PASSWORD });
    expect(await r.orch.run(task.id)).toEqual({ status: "awaiting_approval" }); // next: the Log in click
    expect(r.browser.typed).toContainEqual({ ref: "e2", text: PASSWORD });
    const [submit] = await r.approvals.listPending(task.id);
    expect(submit).toMatchObject({ tool: "browser.click" });
    await r.service.decideApproval("alice", submit!.id, "approved");
    expect(await r.orch.run(task.id)).toEqual({ status: "completed" });

    const everything = await leaks(r, task.id);
    expect(everything).not.toContain(PASSWORD);
    expect(Number((await r.pool.query("SELECT count(*) AS n FROM approval_secrets")).rows[0].n)).toBe(0); // used up
  });

  it("does nothing if the user rejects, and nothing is left behind", async () => {
    const r = await askRig();
    const task = await r.store.createTask({ owner: "alice", goal: "log in", completionCriteria: [{ kind: "text_present", value: "Welcome back" }] });
    await r.orch.run(task.id);
    const [req] = await r.service.listPendingApprovals("alice");
    await r.service.decideApproval("alice", req!.id, "rejected");
    await r.orch.run(task.id).catch(() => undefined);
    expect(r.browser.typed.some((t) => t.text === PASSWORD)).toBe(false);
    expect(Number((await r.pool.query("SELECT count(*) AS n FROM approval_secrets")).rows[0].n)).toBe(0);
  });

  it("also saves it for next time when asked, and the saved copy then works without typing it again", async () => {
    const r = await askRig();
    const task = await r.store.createTask({ owner: "alice", goal: "log in", completionCriteria: [{ kind: "text_present", value: "Welcome back" }] });
    await r.orch.run(task.id);
    const [req] = await r.service.listPendingApprovals("alice");
    await r.service.decideApproval("alice", req!.id, "approved", { secret: PASSWORD, saveAs: "app-saved" });
    expect(await r.vault.reveal("alice", "app-saved")).toEqual({ origin: "https://app.example", value: PASSWORD });
    expect((await r.vault.list("alice")).find((m) => m.name === "app-saved")!.origin).toBe("https://app.example");
  });
});
