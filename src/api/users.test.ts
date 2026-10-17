import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresArtifactStore } from "../artifacts/artifact-store.js";
import { createTranslator } from "../i18n/messages.js";
import { ApprovalStore } from "../persistence/approval-store.js";
import { TaskStore } from "../persistence/task-store.js";
import { UserStore } from "../persistence/user-store.js";
import { hashToken } from "../runtime/config.js";
import { ApiKeyStore } from "../vault/api-key-store.js";
import { accessFor } from "../runtime/model-router.js";
import type { LimitPolicy } from "../runtime/limits.js";
import { QuotaService } from "../runtime/quota.js";
import { TaskService } from "../runtime/task-service.js";
import { createTestDb } from "../testing/test-db.js";
import { buildApi } from "./server.js";

const ADMIN = "boss-token-".padEnd(40, "b");
const policy: LimitPolicy = {
  defaults: { maxToolCalls: 30, maxRuntimeMs: 600_000, maxSpendUsd: 0.5, maxSteps: 40, maxRecoveryAttempts: 1 },
  maximums: { maxToolCalls: 60, maxRuntimeMs: 1_800_000, maxSpendUsd: 2, maxSteps: 70, maxRecoveryAttempts: 2 },
};
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => void (db = await createTestDb()));
afterAll(async () => db.cleanup());

/** One server: "boss" comes from .env (an admin); everyone else is added through the API. */
function rig(opts: { ownChrome?: boolean; sharedLoginOwnerOnly?: boolean; withKeys?: boolean; verify?: "valid" | "invalid" | "unknown"; defaults?: { maxConcurrent: number; dailySpendUsd: number; maxTasksPerHour: number } } = {}) {
  const pool = db.connect();
  const store = new TaskStore(pool);
  const approvals = new ApprovalStore(pool);
  const envOwners = new Set(["boss"]);
  const users = new UserStore(pool, envOwners);
  const apiKeys = opts.withKeys || opts.sharedLoginOwnerOnly ? new ApiKeyStore(pool, randomBytes(32)) : undefined;
  const quota = new QuotaService(
    pool,
    opts.defaults ?? { maxConcurrent: 2, dailySpendUsd: 1, maxTasksPerHour: 30 },
    async (owner) => {
      if (envOwners.has(owner)) return { unlimited: true, maxConcurrent: null, dailySpendUsd: null };
      const u = await users.get(owner);
      return u ? { unlimited: u.role === "admin", maxConcurrent: u.maxConcurrent, dailySpendUsd: u.dailySpendUsd, ownKey: apiKeys ? await apiKeys.has(owner) : false } : undefined;
    },
    createTranslator("en"),
  );
  const service = new TaskService({ store, approvals, queue: { enqueueRun: async () => {} }, limits: policy, artifacts: new PostgresArtifactStore(pool), abortRun: () => {}, quota });
  const modelAccess = async (owner: string, role: "admin" | "user") =>
    accessFor({ admin: role === "admin", hasOwnKey: apiKeys ? await apiKeys.has(owner) : false, serverModelIsShareable: !opts.sharedLoginOwnerOnly });
  const app = buildApi({
    service,
    tokenOwners: new Map([[hashToken(ADMIN), "boss"]]),
    users,
    quota,
    modelAccess,
    ...(opts.ownChrome ? { ownChrome: true } : {}),
    ...(apiKeys ? { apiKeys, verifyApiKey: async () => opts.verify ?? "valid" } : {}),
  });
  // Tests share one database, so every rig gets its own names.
  const tag = randomBytes(3).toString("hex");
  const n = (name: string) => `${name}-${tag}`;
  const addUser = async (body: Record<string, unknown>) => {
    const res = await app.inject({ method: "POST", url: "/admin/users", headers: bearer(ADMIN), payload: body as never });
    return { res, token: res.json().token as string };
  };
  const post = (token: string, url: string, payload: unknown = { goal: "open example.com" }) => app.inject({ method: "POST", url, headers: bearer(token), payload: payload as never });
  return { app, store, users, pool, addUser, post, n, apiKeys };
}

describe("adding people", () => {
  it("lets an admin create a user, shows the token once, and the token then works", async () => {
    const { app, addUser, users, n } = rig();
    const { res, token } = await addUser({ name: n("alice"), email: "alice@example.com" });
    expect(res.statusCode).toBe(201);
    expect(token).toMatch(/^cbu_[0-9a-f]{64}$/);
    expect(res.json().user).toMatchObject({ owner: n("alice"), role: "user", disabled: false });
    expect(JSON.stringify(res.json().user)).not.toContain(token);

    const me = await app.inject({ url: "/me", headers: bearer(token) });
    expect(me.json()).toMatchObject({ owner: n("alice"), role: "user" });
    // Only the hash is stored: the token cannot be looked up again, by the API or the store.
    const list = (await app.inject({ url: "/admin/users", headers: bearer(ADMIN) })).json();
    expect(JSON.stringify(list)).not.toContain(token);
    expect(JSON.stringify(await users.list())).not.toContain(token);
    await app.close();
  });

  it("is for admins only, and refuses odd or taken names", async () => {
    const { app, addUser, n } = rig();
    const { token: aliceToken } = await addUser({ name: n("alice") });
    expect((await app.inject({ url: "/admin/users", headers: bearer(aliceToken) })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/admin/users", headers: bearer(aliceToken), payload: { name: n("mallory") } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/admin/users" })).statusCode).toBe(401);

    for (const name of ["A", "Bad Name", "x".repeat(40), "-start", "ok;drop"]) {
      expect((await app.inject({ method: "POST", url: "/admin/users", headers: bearer(ADMIN), payload: { name } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: "/admin/users", headers: bearer(ADMIN), payload: { name: n("alice") } })).statusCode).toBe(409); // taken
    expect((await app.inject({ method: "POST", url: "/admin/users", headers: bearer(ADMIN), payload: { name: "boss" } })).statusCode).toBe(409); // the .env owner's name is reserved
    expect((await app.inject({ method: "POST", url: "/admin/users", headers: bearer(ADMIN), payload: { name: n("eve"), role: "root" } })).statusCode).toBe(400);
    await app.close();
  });

  it("keeps people apart: nobody sees or touches anyone else's tasks, admins included", async () => {
    const { app, addUser, post, n } = rig({ defaults: { maxConcurrent: 5, dailySpendUsd: 5, maxTasksPerHour: 50 } });
    const { token: a } = await addUser({ name: n("alice") });
    const { token: b } = await addUser({ name: n("bob") });
    const made = (await post(a, "/tasks")).json();
    expect(made.id).toBeTruthy();
    expect((await app.inject({ url: `/tasks/${made.id}`, headers: bearer(b) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/tasks/${made.id}`, headers: bearer(ADMIN) })).statusCode).toBe(404); // privacy holds for the admin too
    expect((await app.inject({ method: "POST", url: `/tasks/${made.id}/cancel`, headers: bearer(b) })).statusCode).toBe(404);
    expect((await app.inject({ url: "/tasks", headers: bearer(b) })).json().tasks).toEqual([]);
    expect((await app.inject({ url: "/tasks", headers: bearer(a) })).json().tasks).toHaveLength(1);
    await app.close();
  });
});

describe("managing people", () => {
  it("disabling cuts access at once, including sessions; enabling brings it back; a new token replaces the old", async () => {
    const { app, addUser, n } = rig();
    const { token } = await addUser({ name: n("alice") });
    const { code } = (await app.inject({ method: "POST", url: "/auth/code", headers: bearer(token) })).json();
    const session = (await app.inject({ method: "POST", url: "/auth/redeem", payload: { code } })).json().token as string;
    expect((await app.inject({ url: "/me", headers: bearer(session) })).statusCode).toBe(200);

    await app.inject({ method: "PATCH", url: `/admin/users/${n("alice")}`, headers: bearer(ADMIN), payload: { disabled: true } });
    expect((await app.inject({ url: "/me", headers: bearer(token) })).statusCode).toBe(401);
    expect((await app.inject({ url: "/me", headers: bearer(session) })).statusCode).toBe(401);

    await app.inject({ method: "PATCH", url: `/admin/users/${n("alice")}`, headers: bearer(ADMIN), payload: { disabled: false } });
    expect((await app.inject({ url: "/me", headers: bearer(token) })).statusCode).toBe(200);

    const rotated = (await app.inject({ method: "POST", url: `/admin/users/${n("alice")}/token`, headers: bearer(ADMIN) })).json().token as string;
    expect(rotated).not.toBe(token);
    expect((await app.inject({ url: "/me", headers: bearer(token) })).statusCode).toBe(401); // the old one is dead
    expect((await app.inject({ url: "/me", headers: bearer(rotated) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/admin/users/${n("ghost")}/token`, headers: bearer(ADMIN) })).statusCode).toBe(404);
    await app.close();
  });

  it("will not let an admin lock themselves out, and a user cannot raise their own limits", async () => {
    const { app, addUser, n } = rig();
    const { token: second } = await addUser({ name: n("second"), role: "admin" });
    expect((await app.inject({ method: "PATCH", url: `/admin/users/${n("second")}`, headers: bearer(second), payload: { disabled: true } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PATCH", url: `/admin/users/${n("second")}`, headers: bearer(second), payload: { role: "user" } })).statusCode).toBe(409);
    const { token: plain } = await addUser({ name: n("plain") });
    expect((await app.inject({ method: "PATCH", url: `/admin/users/${n("plain")}`, headers: bearer(plain), payload: { maxConcurrent: 50 } })).statusCode).toBe(403);
    await app.close();
  });
});

describe("limits", () => {
  it("stops a user at their task limit with a clear message, but never an admin", async () => {
    const { app, addUser, post, n } = rig({ defaults: { maxConcurrent: 2, dailySpendUsd: 100, maxTasksPerHour: 100 } });
    const { token } = await addUser({ name: n("alice") });
    expect((await post(token, "/tasks")).statusCode).toBe(201);
    expect((await post(token, "/tasks")).statusCode).toBe(201);
    const third = await post(token, "/tasks");
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: "quota_exceeded", reason: "too_many_active" });
    expect(third.json().message).toContain("limit 2");

    for (let i = 0; i < 4; i++) expect((await post(ADMIN, "/tasks")).statusCode).toBe(201); // .env admin: no limit
    const { token: second } = await addUser({ name: n("second"), role: "admin" });
    for (let i = 0; i < 3; i++) expect((await post(second, "/tasks")).statusCode).toBe(201);
    await app.close();
  });

  it("applies a per-user override instead of the server default", async () => {
    const { app, addUser, post, n } = rig({ defaults: { maxConcurrent: 1, dailySpendUsd: 100, maxTasksPerHour: 100 } });
    const { token } = await addUser({ name: n("roomy"), maxConcurrent: 3 });
    for (let i = 0; i < 3; i++) expect((await post(token, "/tasks")).statusCode).toBe(201);
    expect((await post(token, "/tasks")).statusCode).toBe(429);
    await app.close();
  });

  it("stops a user who has used up the day's estimated spend, counted from what was recorded", async () => {
    const { app, addUser, post, store, n } = rig({ defaults: { maxConcurrent: 10, dailySpendUsd: 0.5, maxTasksPerHour: 100 } });
    const { token } = await addUser({ name: n("spender") });
    const t = (await post(token, "/tasks")).json();
    await store.appendEvent(t.id, "model.usage", { phase: "step", costUsd: 0.3 });
    expect((await post(token, "/tasks")).statusCode).toBe(201); // 0.30 of 0.50 used
    await store.appendEvent(t.id, "model.usage", { phase: "step", costUsd: 0.25 });
    const over = await post(token, "/tasks");
    expect(over.statusCode).toBe(429);
    expect(over.json().reason).toBe("daily_spend");
    // Someone else's spending does not count against them.
    const { token: other } = await addUser({ name: n("other") });
    expect((await post(other, "/tasks")).statusCode).toBe(201);
    await app.close();
  });

  it("limits how many tasks one person may start per hour", async () => {
    const { app, addUser, post, pool, n } = rig({ defaults: { maxConcurrent: 100, dailySpendUsd: 100, maxTasksPerHour: 3 } });
    const { token } = await addUser({ name: n("busy") });
    for (let i = 0; i < 3; i++) {
      const id = (await post(token, "/tasks")).json().id;
      await pool.query("UPDATE tasks SET status = 'completed' WHERE id = $1", [id]); // finished, so only the hourly cap applies
    }
    const res = await post(token, "/tasks");
    expect(res.statusCode).toBe(429);
    expect(res.json().reason).toBe("too_many_recent");
    await app.close();
  });

  it("tells a person what they have used on /me", async () => {
    const { app, addUser, post, n } = rig({ defaults: { maxConcurrent: 4, dailySpendUsd: 2, maxTasksPerHour: 30 } });
    const { token } = await addUser({ name: n("alice") });
    await post(token, "/tasks");
    const me = (await app.inject({ url: "/me", headers: bearer(token) })).json();
    expect(me.limits).toEqual({ maxConcurrent: 4, dailySpendUsd: 2, maxTasksPerHour: 30 });
    expect(me.usage).toMatchObject({ activeTasks: 1 });
    const admin = (await app.inject({ url: "/me", headers: bearer(ADMIN) })).json();
    expect(admin).toMatchObject({ owner: "boss", role: "admin", limits: null });
    await app.close();
  });
});

const KEY = "sk-ant-api03-" + "A1b2C3d4E5f6G7h8I9j0".repeat(3);

describe("a personal Claude login is not lent out", () => {
  it("lets only admins start tasks while the model is the owner's login and the person has no key of their own", async () => {
    const { app, addUser, post, n } = rig({ sharedLoginOwnerOnly: true });
    const { token } = await addUser({ name: n("alice") });
    const refused = await post(token, "/tasks");
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "needs_api_key" });
    expect((await post(token, "/tasks/00000000-0000-4000-8000-000000000000/continue", {})).statusCode).toBe(403);
    expect((await app.inject({ url: "/me", headers: bearer(token) })).json()).toMatchObject({ blocked: "needs_api_key", byok: true });

    // They can still look around, and the owner is unaffected.
    expect((await app.inject({ url: "/tasks", headers: bearer(token) })).statusCode).toBe(200);
    expect((await post(ADMIN, "/tasks")).statusCode).toBe(201);
    expect((await app.inject({ url: "/me", headers: bearer(ADMIN) })).json().blocked).toBeUndefined();
    await app.close();
  });

  it("lets users work once the server model is a shareable API key", async () => {
    const { app, addUser, post, n } = rig({ sharedLoginOwnerOnly: false });
    const { token } = await addUser({ name: n("alice") });
    expect((await post(token, "/tasks")).statusCode).toBe(201);
    await app.close();
  });
});

describe("bring your own key", () => {
  const put = (app: ReturnType<typeof rig>["app"], token: string, apiKey: unknown) =>
    app.inject({ method: "PUT", url: "/me/api-key", headers: bearer(token), payload: { apiKey } as never });

  it("unblocks a person who saves their own key, and blocks them again when they remove it", async () => {
    const { app, addUser, post, n } = rig({ sharedLoginOwnerOnly: true });
    const { token } = await addUser({ name: n("alice") });
    expect((await post(token, "/tasks")).statusCode).toBe(403);

    const saved = await put(app, token, KEY);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().apiKey).toMatchObject({ saved: true, hint: KEY.slice(-4) });
    expect((await app.inject({ url: "/me", headers: bearer(token) })).json()).toMatchObject({ apiKey: { saved: true, hint: KEY.slice(-4) } });
    expect((await app.inject({ url: "/me", headers: bearer(token) })).json().blocked).toBeUndefined();
    expect((await post(token, "/tasks")).statusCode).toBe(201);

    expect((await app.inject({ method: "DELETE", url: "/me/api-key", headers: bearer(token) })).statusCode).toBe(204);
    expect((await post(token, "/tasks")).statusCode).toBe(403);
    expect((await app.inject({ url: "/me", headers: bearer(token) })).json().apiKey).toMatchObject({ saved: false, hint: null });
    await app.close();
  });

  it("never shows the key again: not in any response, the user list, or the database", async () => {
    const { app, addUser, pool, n } = rig({ withKeys: true });
    const { token } = await addUser({ name: n("alice") });
    const saved = await put(app, token, KEY);
    const everything = [
      saved.body,
      (await app.inject({ url: "/me", headers: bearer(token) })).body,
      (await app.inject({ url: "/admin/users", headers: bearer(ADMIN) })).body,
      JSON.stringify((await pool.query("SELECT * FROM user_api_keys")).rows),
    ].join("\n");
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(KEY.slice(0, 30)); // no recognizable part of it either
    await app.close();
  });

  it("refuses things that are not keys, and keys Anthropic does not accept, but saves when Anthropic cannot be reached", async () => {
    const { app, addUser, n } = rig({ withKeys: true });
    const { token } = await addUser({ name: n("alice") });
    for (const bad of ["", "hello", "sk-ant-short", "sk-proj-" + "x".repeat(40), `${KEY} extra`, 12345]) {
      expect((await put(app, token, bad)).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "PUT", url: "/me/api-key", headers: bearer(token), payload: { apiKey: KEY, other: 1 } as never })).statusCode).toBe(400);
    await app.close();

    const rejected = rig({ withKeys: true, verify: "invalid" });
    const { token: t2 } = await rejected.addUser({ name: rejected.n("bob") });
    const res = await put(rejected.app, t2, KEY);
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(KEY);
    expect((await rejected.app.inject({ url: "/me", headers: bearer(t2) })).json().apiKey.saved).toBe(false);
    await rejected.app.close();

    const outage = rig({ withKeys: true, verify: "unknown" });
    const { token: t3 } = await outage.addUser({ name: outage.n("carol") });
    expect((await put(outage.app, t3, KEY)).statusCode).toBe(200);
    await outage.app.close();
  });

  it("keeps each person's key to themselves", async () => {
    const { app, addUser, apiKeys, n } = rig({ withKeys: true });
    const { token: a } = await addUser({ name: n("alice") });
    const { token: b } = await addUser({ name: n("bob") });
    await put(app, a, KEY);
    expect((await app.inject({ url: "/me", headers: bearer(b) })).json().apiKey.saved).toBe(false);
    expect(await apiKeys!.has(n("bob"))).toBe(false);
    expect(await apiKeys!.reveal(n("alice"))).toBe(KEY); // only the model adapter running her tasks calls this
    // The stored key is bound to its owner: moving the row to someone else does not let them use it.
    const { rows } = await (apiKeys as unknown as { pool: { query: (q: string, v?: unknown[]) => Promise<{ rows: unknown[] }> } }).pool.query("SELECT iv, ciphertext FROM user_api_keys WHERE owner = $1", [n("alice")]);
    await (apiKeys as unknown as { pool: { query: (q: string, v?: unknown[]) => Promise<unknown> } }).pool.query("INSERT INTO user_api_keys (owner, iv, ciphertext, hint) VALUES ($1, $2, $3, 'xxxx')", [n("bob"), (rows[0] as { iv: Buffer }).iv, (rows[0] as { ciphertext: Buffer }).ciphertext]);
    await expect(apiKeys!.reveal(n("bob"))).rejects.toThrow();
    await app.close();
  });

  it("does not apply the daily spend limit to someone paying with their own key, but still limits tasks at once", async () => {
    const { app, addUser, post, store, n } = rig({ sharedLoginOwnerOnly: true, defaults: { maxConcurrent: 1, dailySpendUsd: 0.1, maxTasksPerHour: 100 } });
    const { token } = await addUser({ name: n("alice") });
    await put(app, token, KEY);
    const t = (await post(token, "/tasks")).json();
    await store.appendEvent(t.id, "model.usage", { phase: "step", costUsd: 5 }); // far over the shared limit
    await store.transition(t.id, "cancelled"); // no longer active
    expect((await post(token, "/tasks")).statusCode).toBe(201); // their money, their call
    const me = (await app.inject({ url: "/me", headers: bearer(token) })).json();
    expect(me.limits.dailySpendUsd).toBeNull();
    expect((await post(token, "/tasks")).json().reason).toBe("too_many_active"); // resources are still shared
    void n;
    await app.close();
  });

  it("says plainly when the server cannot store keys", async () => {
    const { app, addUser, n } = rig(); // no key store
    const { token } = await addUser({ name: n("alice") });
    expect((await put(app, token, KEY)).statusCode).toBe(503);
    expect((await app.inject({ url: "/me", headers: bearer(token) })).json().byok).toBe(false);
    await app.close();
  });
});

describe("standing approvals", () => {
  const grants = [{ tool: "browser.click", origin: "https://blog.example.com", names: ["Publish now"] }];

  it("may be given by an admin token only, are stored on the task, and must be well formed", async () => {
    const { post, addUser, n, store } = rig();
    const { token } = await addUser({ name: n("dave"), email: "dave@example.com" });
    expect((await post(token, "/tasks", { goal: "x", standingApprovals: grants })).statusCode).toBe(403);

    const made = await post(ADMIN, "/tasks", { goal: "x", standingApprovals: grants });
    expect(made.statusCode).toBe(201);
    expect((await store.getTask(made.json().id)).constraints.standingApprovals).toEqual(grants);

    expect((await post(ADMIN, "/tasks", { goal: "x", standingApprovals: [{ ...grants[0], origin: "http://blog.example.com" }] })).statusCode).toBe(400);
    expect((await post(ADMIN, "/tasks", { goal: "x", standingApprovals: [{ ...grants[0], anyOrigin: true }] })).statusCode).toBe(400);
  });
});

describe("running a task in your own Chrome", () => {
  it("is offered to admins only: they may pick it, other people are refused, and /me shows it to admins alone", async () => {
    const { app, post, addUser, n, store } = rig({ ownChrome: true });
    const { token } = await addUser({ name: n("carol"), email: "carol@example.com" });
    expect((await post(token, "/tasks", { goal: "x", browser: "chrome" })).statusCode).toBe(403);
    expect((await post(token, "/tasks", { goal: "x", browser: "sandbox" })).statusCode).toBe(201);

    const made = await post(ADMIN, "/tasks", { goal: "x", browser: "chrome" });
    expect(made.statusCode).toBe(201);
    expect((await store.getTask(made.json().id)).constraints).toMatchObject({ browser: "chrome" });
    const plain = await post(ADMIN, "/tasks", { goal: "x" });
    expect((await store.getTask(plain.json().id)).constraints.browser).toBeUndefined();

    expect((await app.inject({ url: "/me", headers: bearer(ADMIN) })).json().ownChrome).toBe(true);
    expect((await app.inject({ url: "/me", headers: bearer(token) })).json().ownChrome).toBeUndefined();
  });
});
