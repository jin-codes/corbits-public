import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApi } from "../api/server.js";
import { PostgresArtifactStore } from "../artifacts/artifact-store.js";
import type { StorageState } from "../execution/login-state.js";
import type { ModelAdapter, PlanResult, StepRequest, StepResult } from "../model/types.js";
import { ApprovalStore } from "../persistence/approval-store.js";
import { TaskStore } from "../persistence/task-store.js";
import { Redactor } from "../security/redact.js";
import { MockBrowser } from "../testing/mock-browser.js";
import { USAGE, finish } from "../testing/mock-model.js";
import { createTestDb } from "../testing/test-db.js";
import { LoginStateStore, MAX_LOGINS_PER_OWNER } from "../vault/login-state-store.js";
import { BrowserSessions, type LaunchOptions } from "./browser-sessions.js";
import { hashToken } from "./config.js";
import type { LimitPolicy } from "./limits.js";
import { TaskRunner } from "./task-runner.js";
import { TaskService } from "./task-service.js";

const policy: LimitPolicy = {
  defaults: { maxToolCalls: 30, maxRuntimeMs: 600_000, maxSpendUsd: 0.5, maxSteps: 40, maxRecoveryAttempts: 1 },
  maximums: { maxToolCalls: 60, maxRuntimeMs: 1_800_000, maxSpendUsd: 2, maxSteps: 70, maxRecoveryAttempts: 2 },
};
const ALICE = "alice-token-".padEnd(40, "a");
const BOB = "bob-token-".padEnd(40, "b");
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const COOKIE_VALUE = "COOKIE-VALUE-" + "k".repeat(30);
const LS_VALUE = "LOCALSTORAGE-VALUE-" + "z".repeat(20);
const mail = (value = COOKIE_VALUE): StorageState => ({
  cookies: [{ name: "sid", value, domain: "mail.example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
  origins: [{ origin: "https://mail.example.com", localStorage: [{ name: "t", value: LS_VALUE }] }],
});

let db: Awaited<ReturnType<typeof createTestDb>>;
let cleaner: ReturnType<(typeof db)["connect"]>;
beforeAll(async () => {
  db = await createTestDb();
  cleaner = db.connect();
});
afterAll(async () => db.cleanup());
// Tests share one database and the same people: start each with no saved logins.
beforeEach(async () => void (await cleaner.query("DELETE FROM login_states")));

function rig() {
  const pool = db.connect();
  const store = new TaskStore(pool);
  const logins = new LoginStateStore(pool, randomBytes(32));
  const browsers: MockBrowser[] = [];
  const launches: LaunchOptions[] = [];
  const sessions = new BrowserSessions(async (opts) => {
    launches.push(opts);
    const b = new MockBrowser({ "about:blank": { content: `- heading "Example"` } });
    browsers.push(b);
    return b;
  }, 60_000);
  const service = new TaskService({
    store,
    approvals: new ApprovalStore(pool),
    queue: { enqueueRun: async () => {} },
    limits: policy,
    artifacts: new PostgresArtifactStore(pool),
    abortRun: () => {},
    logins,
    human: { browser: (id) => sessions.peek(id), isRunActive: () => false, touch: () => {} },
  });
  const app = buildApi({ service, tokenOwners: new Map([[hashToken(ALICE), "alice"], [hashToken(BOB), "bob"]]) });
  /** A task that is under human control with a browser, as it is after the owner took over. */
  const underControl = async (owner = "alice") => {
    const t = await store.createTask({ owner, goal: "sign in", completionCriteria: [] });
    await sessions.acquire(t.id);
    await store.transition(t.id, "planning");
    await store.transition(t.id, "running");
    await store.transition(t.id, "human_control");
    return t.id;
  };
  return { pool, store, logins, sessions, service, app, browsers, launches, underControl };
}

describe("the encrypted store", () => {
  it("keeps a login for one site, returns it only to the task that asks, and never stores it readable", async () => {
    const { logins, pool } = rig();
    const meta = await logins.put("alice", "mail", "https://mail.example.com", mail());
    expect(meta).toMatchObject({ name: "mail", origin: "https://mail.example.com", cookieCount: 1 });
    const raw = JSON.stringify((await pool.query("SELECT * FROM login_states")).rows);
    expect(raw).not.toContain(COOKIE_VALUE);
    expect(raw).not.toContain(LS_VALUE);
    const [got] = await logins.reveal("alice", ["mail"]);
    expect(got!.state.cookies[0]!.value).toBe(COOKIE_VALUE);
    expect(await logins.reveal("bob", ["mail"])).toEqual([]); // someone else's name is not there for bob
    expect([...(await logins.existing("alice", ["mail", "nope"]))]).toEqual(["mail"]);
  });

  it("is bound to its owner and site: a row moved to someone else, or pointed at another site, does not decrypt", async () => {
    const { logins, pool } = rig();
    await logins.put("alice", "mail", "https://mail.example.com", mail());
    const { rows } = await pool.query("SELECT iv, ciphertext FROM login_states WHERE owner = 'alice' AND name = 'mail'");
    await pool.query("INSERT INTO login_states (id, owner, name, origin, iv, ciphertext) VALUES (gen_random_uuid(), 'bob', 'mail', 'https://mail.example.com', $1, $2)", [rows[0].iv, rows[0].ciphertext]);
    await expect(logins.reveal("bob", ["mail"])).rejects.toThrow();
    await pool.query("UPDATE login_states SET origin = 'https://evil.example' WHERE owner = 'alice'");
    await expect(logins.reveal("alice", ["mail"])).rejects.toThrow();
  });

  it("refuses an empty login, a bad name, and too many logins; replacing one keeps the count", async () => {
    const { logins } = rig();
    await expect(logins.put("carol", "x", "https://a.example", { cookies: [], origins: [] })).rejects.toThrow(/nothing to save/);
    await expect(logins.put("carol", "Bad Name", "https://a.example", mail())).rejects.toThrow();
    for (let i = 0; i < MAX_LOGINS_PER_OWNER; i++) await logins.put("carol", `site${i}`, "https://a.example", mail());
    await expect(logins.put("carol", "one-too-many", "https://a.example", mail())).rejects.toThrow(/at most/);
    await logins.put("carol", "site0", "https://a.example", mail("N".repeat(20))); // replacing is fine
    expect(await logins.list("carol")).toHaveLength(MAX_LOGINS_PER_OWNER);
    expect(await logins.delete("carol", "site0")).toBe(true);
    expect(await logins.delete("carol", "site0")).toBe(false);
  });
});

describe("keeping the login you just made", () => {
  it("saves the open page's login while you have the browser, shows it by name only, and records no values", async () => {
    const { app, underControl, browsers, store } = rig();
    const id = await underControl();
    browsers[0]!.loginState = { origin: "https://mail.example.com", state: mail() };

    const saved = await app.inject({ method: "POST", url: `/tasks/${id}/control/save-login`, headers: bearer(ALICE), payload: { name: "mail" } });
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({ name: "mail", origin: "https://mail.example.com", cookieCount: 1 });

    const list = await app.inject({ url: "/logins", headers: bearer(ALICE) });
    expect(list.json().logins).toHaveLength(1);
    const everything = [saved.body, list.body, JSON.stringify(await store.listEvents(id))].join("\n");
    expect(everything).not.toContain(COOKIE_VALUE);
    expect(everything).not.toContain(LS_VALUE);
    expect((await store.listEvents(id)).find((e) => e.type === "login.saved")!.payload).toEqual({ name: "mail", origin: "https://mail.example.com", cookies: 1 });
    await app.close();
  });

  it("only works while you are in control of your own task, and says why when it cannot save", async () => {
    const { app, underControl, browsers, store } = rig();
    const id = await underControl();
    const save = (token: string, name = "mail") => app.inject({ method: "POST", url: `/tasks/${id}/control/save-login`, headers: bearer(token), payload: { name } });

    expect((await save(BOB)).statusCode).toBe(404); // not bob's task
    browsers[0]!.loginState = undefined;
    expect((await save(ALICE)).statusCode).toBe(500); // an unexpected failure is not mistaken for a user mistake
    browsers[0]!.loginState = { origin: "https://mail.example.com", state: { cookies: [], origins: [] } };
    const empty = await save(ALICE);
    expect(empty.statusCode).toBe(400);
    expect(empty.body).toContain("nothing to save");
    browsers[0]!.loginState = { origin: "https://mail.example.com", state: mail() };
    expect((await save(ALICE, "Bad Name")).statusCode).toBe(400);

    await store.transition(id, "running"); // handed back
    expect((await save(ALICE)).statusCode).toBe(409);
    expect((await app.inject({ url: "/logins", headers: bearer(ALICE) })).json().logins).toEqual([]);
    await app.close();
  });

  it("keeps each person's logins to themselves", async () => {
    const { app, underControl, browsers } = rig();
    const id = await underControl();
    browsers[0]!.loginState = { origin: "https://mail.example.com", state: mail() };
    await app.inject({ method: "POST", url: `/tasks/${id}/control/save-login`, headers: bearer(ALICE), payload: { name: "mail" } });
    expect((await app.inject({ url: "/logins", headers: bearer(BOB) })).json().logins).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: "/logins/mail", headers: bearer(BOB) })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/logins/mail", headers: bearer(ALICE) })).statusCode).toBe(204);
    expect((await app.inject({ url: "/logins", headers: bearer(ALICE) })).json().logins).toEqual([]);
    await app.close();
  });
});

describe("starting a task signed in", () => {
  const create = (app: ReturnType<typeof rig>["app"], token: string, logins?: string[]) =>
    app.inject({ method: "POST", url: "/tasks", headers: bearer(token), payload: { goal: "check mail", ...(logins ? { logins } : {}) } as never });

  it("accepts only logins the person really saved, and remembers them on the task", async () => {
    const { app, logins, store } = rig();
    await logins.put("alice", "mail", "https://mail.example.com", mail());
    await logins.put("bob", "bobs-bank", "https://bank.example", mail());

    const ok = await create(app, ALICE, ["mail"]);
    expect(ok.statusCode).toBe(201);
    expect((await store.getTask(ok.json().id)).constraints.logins).toEqual(["mail"]);
    expect((await create(app, ALICE, ["nope"])).statusCode).toBe(400);
    expect((await create(app, ALICE, ["bobs-bank"])).statusCode).toBe(400); // someone else's is not hers to use
    const plain = await create(app, ALICE);
    expect((await store.getTask(plain.json().id)).constraints.logins).toBeUndefined(); // nothing is loaded unless asked for
    await app.close();
  });

  it("carries the logins into a continued task, minus any deleted since", async () => {
    const { app, logins, store } = rig();
    await logins.put("alice", "mail", "https://mail.example.com", mail());
    await logins.put("alice", "cal", "https://cal.example.com", mail("C".repeat(20)));
    const first = (await create(app, ALICE, ["mail", "cal"])).json().id;
    await store.transition(first, "failed");
    await logins.delete("alice", "cal");
    const next = (await app.inject({ method: "POST", url: `/tasks/${first}/continue`, headers: bearer(ALICE), payload: {} })).json();
    expect((await store.getTask(next.id)).constraints.logins).toEqual(["mail"]);
    await app.close();
  });
});

class Spy implements ModelAdapter {
  seen: StepRequest | undefined;
  async plan(): Promise<PlanResult> {
    return { steps: ["x"], criteria: [{ kind: "text_present", value: "Example" }], usage: USAGE };
  }
  async step(req: StepRequest): Promise<StepResult> {
    this.seen = req;
    return finish("done");
  }
}

describe("the task's browser", () => {
  it("starts with exactly the logins the task named, tells the model which sites (never the session), and scrubs their values", async () => {
    const { store, logins, sessions, launches, pool } = rig();
    await logins.put("alice", "mail", "https://mail.example.com", mail());
    await logins.put("alice", "other", "https://other.example", mail("O".repeat(24)));
    const model = new Spy();
    const redactor = new Redactor();
    const runner = new TaskRunner({ store, approvals: new ApprovalStore(pool), model, sessions, limits: policy, artifacts: new PostgresArtifactStore(pool), redactor, logins });
    const t = await store.createTask({ owner: "alice", goal: "check mail", constraints: { logins: ["mail"] }, completionCriteria: [{ kind: "text_present", value: "Example" }] });
    await runner.run(t.id);

    expect(launches).toHaveLength(1);
    expect(launches[0]!.storageState!.cookies.map((c) => c.value)).toEqual([COOKIE_VALUE]); // "other" was not asked for
    expect(model.seen!.signedIn).toEqual([{ name: "mail", origin: "https://mail.example.com" }]);
    expect(JSON.stringify(model.seen)).not.toContain(COOKIE_VALUE);
    expect((await store.listEvents(t.id)).find((e) => e.type === "logins.applied")!.payload).toEqual({ logins: [{ name: "mail", origin: "https://mail.example.com" }] });
    expect(redactor.redactString(`oops ${COOKIE_VALUE} oops`)).not.toContain(COOKIE_VALUE); // even if a page ever echoed it
    await sessions.closeAll();
  });

  it("starts signed out when the task named no logins, and cannot load someone else's", async () => {
    const { store, logins, sessions, launches, pool } = rig();
    await logins.put("bob", "bobs-mail", "https://mail.example.com", mail());
    const model = new Spy();
    const runner = new TaskRunner({ store, approvals: new ApprovalStore(pool), model, sessions, limits: policy, artifacts: new PostgresArtifactStore(pool), logins });
    const plain = await store.createTask({ owner: "alice", goal: "g", completionCriteria: [{ kind: "text_present", value: "Example" }] });
    await runner.run(plain.id);
    expect(launches[0]).toEqual({});
    expect(model.seen!.signedIn).toBeUndefined();
    await sessions.closeAll();

    const sneaky = rig();
    await sneaky.logins.put("bob", "bobs-mail", "https://mail.example.com", mail());
    const runner2 = new TaskRunner({ store: sneaky.store, approvals: new ApprovalStore(sneaky.pool), model: new Spy(), sessions: sneaky.sessions, limits: policy, artifacts: new PostgresArtifactStore(sneaky.pool), logins: sneaky.logins });
    // Even if a task row names another person's login, the owner's own scope applies and nothing is loaded.
    const t = await sneaky.store.createTask({ owner: "alice", goal: "g", constraints: { logins: ["bobs-mail"] }, completionCriteria: [{ kind: "text_present", value: "Example" }] });
    await runner2.run(t.id);
    expect(sneaky.launches[0]).toEqual({});
    await sneaky.sessions.closeAll();
  });
});
