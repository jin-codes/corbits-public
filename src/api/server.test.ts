import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { PostgresArtifactStore } from "../artifacts/artifact-store.js";
import { OneTimeSecretStore } from "../vault/one-time.js";
import { SecretStore } from "../vault/secret-store.js";
import { ApprovalStore } from "../persistence/approval-store.js";
import { TaskStore } from "../persistence/task-store.js";
import { hashToken } from "../runtime/config.js";
import type { LimitPolicy } from "../runtime/limits.js";
import { TaskService } from "../runtime/task-service.js";
import { createTestDb } from "../testing/test-db.js";
import { buildApi } from "./server.js";

const ALICE = "alice-token-".padEnd(40, "a");
const BOB = "bob-token-".padEnd(40, "b");
const policy: LimitPolicy = {
  defaults: { maxToolCalls: 30, maxRuntimeMs: 600_000, maxSpendUsd: 0.5, maxSteps: 40, maxRecoveryAttempts: 1 },
  maximums: { maxToolCalls: 60, maxRuntimeMs: 1_800_000, maxSpendUsd: 2, maxSteps: 70, maxRecoveryAttempts: 2 },
};

let db: Awaited<ReturnType<typeof createTestDb>>;
let store: TaskStore;
let approvals: ApprovalStore;
let artifacts: PostgresArtifactStore;
let vault: SecretStore;
let oneTime: OneTimeSecretStore;
let app: ReturnType<typeof buildApi>;
let svc: TaskService;
const enqueued: string[] = [];
const aborted: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  const pool = db.connect();
  store = new TaskStore(pool);
  approvals = new ApprovalStore(pool);
  artifacts = new PostgresArtifactStore(pool);
  const vaultKey = randomBytes(32);
  vault = new SecretStore(pool, vaultKey);
  oneTime = new OneTimeSecretStore(pool, vaultKey);
  const service = (svc = new TaskService({
    store,
    approvals,
    queue: { enqueueRun: async (id) => void enqueued.push(id) },
    limits: policy,
    artifacts,
    oneTime,
    vault,
    abortRun: (id) => void aborted.push(id),
  }));
  app = buildApi({
    service,
    tokenOwners: new Map([
      [hashToken(ALICE), "alice"],
      [hashToken(BOB), "bob"],
    ]),
    vault,
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.cleanup();
});

const as = (token: string) => ({ authorization: `Bearer ${token}` });
const create = async (token = ALICE, payload: unknown = { goal: "open example.com" }) =>
  app.inject({ method: "POST", url: "/tasks", headers: as(token), payload: payload as never });

describe("dashboard", () => {
  it("serves the page and its two assets without a token, with a strict CSP", async () => {
    for (const [url, type] of [
      ["/", "text/html"],
      ["/assets/app.js", "text/javascript"],
      ["/assets/style.css", "text/css"],
    ] as const) {
      const r = await app.inject({ url });
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toContain(type);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["cache-control"]).toBe("no-store");
    }
    const csp = String((await app.inject({ url: "/" })).headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("img-src 'self' blob: data:");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("contains no inline script, inline style, or innerHTML (what the CSP would block)", async () => {
    const html = (await app.inject({ url: "/" })).body;
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son\w+=/i);
    const js = (await app.inject({ url: "/assets/app.js" })).body.replace(/^\s*\/\/.*$/gm, ""); // ignore comments
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(js).not.toMatch(/setAttribute\(\s*["']style["']|style:\s*["']/);
  });

  it("serves only the fixed paths: traversal and guesses are 404", async () => {
    for (const url of ["/assets/../main.ts", "/assets/%2e%2e/main.ts", "/assets/app.js/../../../.env", "/src/web/app.js", "/index.html", "/assets/", "/.env"]) {
      expect((await app.inject({ url })).statusCode).toBe(404);
    }
  });

  it("stores the Jev mode a task asked for, and rejects unknown modes", async () => {
    const r = await create(ALICE, { goal: "open example.com", jevMode: "assist" });
    expect(r.statusCode).toBe(201);
    expect((await store.getTask(r.json().id)).constraints).toMatchObject({ jevMode: "assist" });
    expect((await create(ALICE, { goal: "open example.com" })).statusCode).toBe(201);
    expect((await create(ALICE, { goal: "x", jevMode: "turbo" })).statusCode).toBe(400);
  });

  it("only admins may point a task at their own Chrome, and only when the server has it", async () => {
    // This test server has no own-Chrome setup: even an admin is told so, and /me does not offer it.
    expect((await create(ALICE, { goal: "x", browser: "chrome" })).statusCode).toBe(409);
    expect((await app.inject({ url: "/me", headers: as(ALICE) })).json().ownChrome).toBeUndefined();
    expect((await create(ALICE, { goal: "x", browser: "sandbox" })).statusCode).toBe(201);
    expect((await create(ALICE, { goal: "x", browser: "firefox" })).statusCode).toBe(400);
  });

  it("/me says which Jev mode is the default only when Jev is on", async () => {
    expect((await app.inject({ url: "/me", headers: as(ALICE) })).json().jev).toBeUndefined();
  });

  it("/me needs a token and returns the caller", async () => {
    expect((await app.inject({ url: "/me" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/me", headers: as(BOB) })).json()).toMatchObject({ owner: "bob", role: "admin" });
  });
});

describe("dashboard language", () => {
  it("serves English by default and Korean when configured, from the same catalog", async () => {
    const en = await app.inject({ url: "/assets/i18n.js" });
    expect(en.statusCode).toBe(200);
    expect(en.headers["content-type"]).toContain("text/javascript");
    expect(en.body).toContain('export const locale = "en"');
    expect(en.body).toContain("Sign in");
    expect((await app.inject({ url: "/" })).body).toContain('<html lang="en">');

    // Run the served script itself: placeholders must really be filled in the browser.
    const mod = await import(`data:text/javascript;base64,${Buffer.from(en.body).toString("base64")}`);
    expect(mod.t("ui.startedAt", { time: "10:30" })).toBe("Started 10:30");
    expect(mod.t("ui.waitingDecision", { n: 3 })).toBe("Waiting for your decision (3)");
    expect(mod.t("ui.notMet", {})).toBe("Not met: {text}");
    expect(mod.t("does.not.exist")).toBe("does.not.exist");

    const koApp = buildApi({ service: undefined as never, tokenOwners: new Map(), locale: "ko" });
    await koApp.ready();
    const ko = await koApp.inject({ url: "/assets/i18n.js" });
    expect(ko.body).toContain('export const locale = "ko"');
    expect(ko.body).toContain("로그인");
    expect(ko.body).not.toContain("email.completed");
    const koMod = await import(`data:text/javascript;base64,${Buffer.from(ko.body).toString("base64")}`);
    expect(koMod.t("ui.startedAt", { time: "10:30" })).toBe("시작: 10:30");
    expect(koMod.t("ui.fileScreenshot", { label: "페이지 열기" })).toBe("스크린샷 — 페이지 열기");
    const page = (await koApp.inject({ url: "/" })).body;
    expect(page).toContain('<html lang="ko">');
    expect(page).toContain("JavaScript가 필요합니다");
    expect(page).not.toContain("{{");
    await koApp.close();
  });
});

describe("timeline route", () => {
  it("returns a readable history for the owner and 404 for others", async () => {
    const { id } = (await create(ALICE)).json();
    await store.appendEvent(id, "model.usage", { costUsd: 0.5 });
    const t = (await app.inject({ url: `/tasks/${id}/timeline`, headers: as(ALICE) })).json();
    expect(t.items[0]).toMatchObject({ title: "Task submitted" });
    expect(t.summary).toMatchObject({ costUsd: 0.5, modelCalls: 1 });
    expect((await app.inject({ url: `/tasks/${id}/timeline`, headers: as(BOB) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/tasks/${id}/timeline` })).statusCode).toBe(401);
  });

  it("approval views carry a one-line summary of the action", async () => {
    const { id } = (await create(ALICE)).json();
    await store.transition(id, "planning");
    await store.transition(id, "running");
    await store.transition(id, "awaiting_approval");
    await approvals.request(id, { tool: "browser.click", input: { ref: "e7" }, context: { target: { role: "button", name: "Subscribe" } }, actionFingerprint: `s-${id}`, effectFingerprint: `s2-${id}` });
    const detail = (await app.inject({ url: `/tasks/${id}`, headers: as(ALICE) })).json();
    expect(detail.pendingApprovals[0].summary).toBe("Click button “Subscribe”");
  });
});

describe("artifacts", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  async function withArtifact(token = ALICE) {
    const { id } = (await create(token)).json();
    const r = await artifacts.put({ taskId: id, kind: "screenshot", mime: "image/jpeg", label: "Open page", attachKey: "tool:c1", data: jpeg });
    if (!r.stored) throw new Error("not stored");
    return { taskId: id, artifactId: r.artifact.id };
  }

  it("lists artifact metadata and includes it in task detail", async () => {
    const { taskId, artifactId } = await withArtifact();
    const list = (await app.inject({ url: `/tasks/${taskId}/artifacts`, headers: as(ALICE) })).json().artifacts;
    expect(list).toEqual([expect.objectContaining({ id: artifactId, kind: "screenshot", mime: "image/jpeg", label: "Open page", sizeBytes: 8 })]);
    expect(list[0]).not.toHaveProperty("data");
    const detail = (await app.inject({ url: `/tasks/${taskId}`, headers: as(ALICE) })).json();
    expect(detail.artifacts.map((a: { id: string }) => a.id)).toEqual([artifactId]);
  });

  it("serves the bytes with the right type and locked-down headers", async () => {
    const { artifactId } = await withArtifact();
    const r = await app.inject({ url: `/artifacts/${artifactId}`, headers: as(ALICE) });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.equals(jpeg)).toBe(true);
    expect(r.headers["content-type"]).toBe("image/jpeg");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("serves page text as a plain-text download, never as something a browser could render", async () => {
    const { id } = (await create(ALICE)).json();
    const put = await artifacts.put({ taskId: id, kind: "page_text", mime: "text/plain", label: "t", attachKey: "verification:1", data: Buffer.from("<script>alert(1)</script>") });
    const r = await app.inject({ url: `/artifacts/${put.stored ? put.artifact.id : ""}`, headers: as(ALICE) });
    expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(String(r.headers["content-disposition"])).toContain("attachment");
    expect(r.headers["content-security-policy"]).toContain("sandbox");
  });

  it("hides other owners' artifacts as 404 for read, list and delete, and requires a token", async () => {
    const { taskId, artifactId } = await withArtifact(ALICE);
    expect((await app.inject({ url: `/artifacts/${artifactId}`, headers: as(BOB) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/tasks/${taskId}/artifacts`, headers: as(BOB) })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/artifacts/${artifactId}`, headers: as(BOB) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/artifacts/${artifactId}` })).statusCode).toBe(401);
    expect(await artifacts.getMeta(artifactId)).not.toBeNull();
    expect((await app.inject({ url: "/artifacts/00000000-0000-4000-8000-000000000000", headers: as(ALICE) })).statusCode).toBe(404);
    expect((await app.inject({ url: "/artifacts/nope", headers: as(ALICE) })).statusCode).toBe(400);
  });

  it("lets the owner delete one, records it, and the timeline stops pointing at it", async () => {
    const { taskId, artifactId } = await withArtifact();
    await store.appendEvent(taskId, "tool.completed", { callId: "c1", tool: "browser.goto", input: { url: "https://a.example" }, outcome: { status: "ok", output: {} } });
    await store.appendEvent(taskId, "artifact.created", { artifactId, kind: "screenshot", label: "x", attachKey: "tool:c1" });
    const before = (await app.inject({ url: `/tasks/${taskId}/timeline`, headers: as(ALICE) })).json();
    expect(before.items.some((i: { artifacts?: unknown[] }) => i.artifacts?.length)).toBe(true);

    expect((await app.inject({ method: "DELETE", url: `/artifacts/${artifactId}`, headers: as(ALICE) })).statusCode).toBe(204);
    expect((await app.inject({ url: `/artifacts/${artifactId}`, headers: as(ALICE) })).statusCode).toBe(404);
    const after = (await app.inject({ url: `/tasks/${taskId}/timeline`, headers: as(ALICE) })).json();
    expect(after.items.some((i: { artifacts?: unknown[] }) => i.artifacts?.length)).toBe(false);
    expect((await store.listEvents(taskId)).some((e) => e.type === "artifact.deleted")).toBe(true);
  });

  it("approval views carry the screenshot taken when the agent asked", async () => {
    const { id } = (await create(ALICE)).json();
    await store.transition(id, "planning");
    await store.transition(id, "running");
    await store.transition(id, "awaiting_approval");
    const { approval } = await approvals.request(id, { tool: "browser.click", input: { ref: "e7" }, actionFingerprint: `x-${id}`, effectFingerprint: `y-${id}` });
    const put = await artifacts.put({ taskId: id, kind: "screenshot", mime: "image/jpeg", label: "When approval was requested", attachKey: `approval:${approval.id}`, data: jpeg });
    await store.appendEvent(id, "artifact.created", { artifactId: put.stored ? put.artifact.id : "", kind: "screenshot", label: "When approval was requested", attachKey: `approval:${approval.id}` });
    const detail = (await app.inject({ url: `/tasks/${id}`, headers: as(ALICE) })).json();
    expect(detail.pendingApprovals[0].screenshotId).toBe(put.stored ? put.artifact.id : "");
    const list = (await app.inject({ url: "/approvals", headers: as(ALICE) })).json().approvals as Array<{ id: string; screenshotId: string | null }>;
    expect(list.find((a) => a.id === approval.id)!.screenshotId).toBe(put.stored ? put.artifact.id : "");
  });
});

describe("continuing a task", () => {
  async function failedTask(token = ALICE) {
    const created = (await create(token, { goal: "log in and read the page", completionCriteria: [{ kind: "text_present", value: "Welcome" }], limits: { maxSpendUsd: 0.3, maxToolCalls: 7 } })).json();
    const id = created.id as string;
    await store.transition(id, "planning");
    await store.transition(id, "running");
    await store.appendEvent(id, "tool.completed", { callId: "c1", tool: "browser.goto", input: { url: "https://a.example/login" }, outcome: { status: "ok", output: { url: "https://a.example/login" } } });
    await store.transition(id, "failed", { payload: { reason: "verification_failed" } });
    return id;
  }
  const cont = (token: string, id: string, payload?: unknown) =>
    app.inject({ method: "POST", url: `/tasks/${id}/continue`, headers: as(token), ...(payload === undefined ? {} : { payload: payload as never }) });

  it("starts a new linked task with the same goal and criteria, the old limits, and a summary of what was done", async () => {
    const parent = await failedTask();
    const before = enqueued.length;
    const r = await cont(ALICE, parent, { note: "use the saved password" });
    expect(r.statusCode).toBe(201);
    const child = r.json();
    expect(child).toMatchObject({ goal: "log in and read the page", status: "queued", parentTaskId: parent, completionCriteria: [{ kind: "text_present", value: "Welcome" }] });
    expect(child.limits).toMatchObject({ maxSpendUsd: 0.3, maxToolCalls: 7 });
    expect(enqueued.length).toBe(before + 1);

    const stored = await store.getTask(child.id);
    expect(stored.constraints).toMatchObject({ startUrl: "https://a.example/login", userNote: "use the saved password" });
    expect(String(stored.constraints.carryOver)).toContain("browser.goto");
    expect((await store.listEvents(child.id)).map((e) => e.type)).toContain("task.continued");
  });

  it("leaves the original task untouched and lists the continuation on it", async () => {
    const parent = await failedTask();
    const child = (await cont(ALICE, parent)).json();
    const detail = (await app.inject({ url: `/tasks/${parent}`, headers: as(ALICE) })).json();
    expect(detail.status).toBe("failed");
    expect(detail.continuations).toEqual([expect.objectContaining({ id: child.id, status: "queued" })]);
    expect(detail.parentTaskId).toBeNull();
  });

  it("allows a fresh budget, but never above the server maximum", async () => {
    const parent = await failedTask();
    const r = (await cont(ALICE, parent, { limits: { maxSpendUsd: 1.5, maxToolCalls: 100_000 } })).json();
    expect(r.limits).toMatchObject({ maxSpendUsd: 1.5, maxToolCalls: 60 });
  });

  it("only continues failed or cancelled tasks", async () => {
    const queued = (await create(ALICE)).json().id;
    expect((await cont(ALICE, queued)).statusCode).toBe(409);
    const done = (await create(ALICE)).json().id;
    await store.transition(done, "planning");
    await store.transition(done, "running");
    await store.transition(done, "verifying");
    await store.transition(done, "completed");
    expect((await cont(ALICE, done)).statusCode).toBe(409);
    const cancelled = (await create(ALICE)).json().id;
    await store.transition(cancelled, "cancelled");
    expect((await cont(ALICE, cancelled)).statusCode).toBe(201);
  });

  it("continues an unverified task, with a phrase that must be shown as its criterion", async () => {
    const t = (await create(ALICE, { goal: "read the changelog" })).json().id as string;
    await store.transition(t, "planning");
    await store.transition(t, "running");
    await store.transition(t, "verifying");
    await store.transition(t, "unverified", { payload: { reason: "no_completion_criteria" } });
    const r = await cont(ALICE, t, { mustShow: "Version 4.2" });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ parentTaskId: t, completionCriteria: [{ kind: "text_present", value: "Version 4.2" }] });
    // A task that already has criteria keeps them: the phrase is refused rather than silently replacing them.
    const parent = await failedTask();
    expect((await cont(ALICE, parent, { mustShow: "Other" })).statusCode).toBe(400);
  });

  it("marks an unverified result as looking right without ever completing it, once, and only for the owner", async () => {
    const t = (await create(ALICE, { goal: "read the changelog" })).json().id as string;
    const ack = (token: string) => app.inject({ method: "POST", url: `/tasks/${t}/acknowledge`, headers: as(token) });
    expect((await ack(ALICE)).statusCode).toBe(409); // not unverified yet
    await store.transition(t, "planning");
    await store.transition(t, "running");
    await store.transition(t, "verifying");
    await store.transition(t, "unverified", { payload: { reason: "no_completion_criteria" } });
    expect((await ack(BOB)).statusCode).toBe(404);
    const first = (await ack(ALICE)).json();
    expect(first).toMatchObject({ status: "unverified" });
    expect(first.acknowledgedAt).toEqual(expect.any(String));
    await ack(ALICE);
    expect((await store.listEvents(t)).filter((e) => e.type === "owner.acknowledged")).toHaveLength(1);
    expect((await store.getTask(t)).status).toBe("unverified");
  });

  it("hides other owners' tasks, requires a token, and validates the body", async () => {
    const parent = await failedTask(ALICE);
    expect((await cont(BOB, parent)).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/tasks/${parent}/continue` })).statusCode).toBe(401);
    expect((await cont(ALICE, parent, { note: "x".repeat(3000) })).statusCode).toBe(400);
    expect((await cont(ALICE, parent, { goal: "something else" })).statusCode).toBe(400); // the goal cannot be changed
    expect((await cont(ALICE, parent, { limits: { maxEverything: 1 } })).statusCode).toBe(400);
  });

  it("can be continued again and again, each linked to the one before", async () => {
    const first = await failedTask();
    const second = (await cont(ALICE, first)).json().id as string;
    await store.transition(second, "failed");
    const third = (await cont(ALICE, second)).json();
    expect(third.parentTaskId).toBe(second);
  });
});

describe("saved credentials", () => {
  const VALUE = "an-extremely-secret-password-9981";
  const save = (token: string, body: unknown) => app.inject({ method: "POST", url: "/secrets", headers: as(token), payload: body as never });

  it("saves a credential and never returns its value, in any response", async () => {
    const r = await save(ALICE, { name: "bank-pw", origin: "https://bank.example/login", value: VALUE });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: "bank-pw", origin: "https://bank.example", lastUsedAt: null });
    expect(r.body).not.toContain(VALUE);

    const list = await app.inject({ url: "/secrets", headers: as(ALICE) });
    expect(list.json().secrets.map((x: { name: string }) => x.name)).toContain("bank-pw");
    expect(list.body).not.toContain(VALUE);
    expect(JSON.stringify(list.json())).not.toMatch(/value|ciphertext|iv"/);
  });

  it("keeps each owner's credentials private", async () => {
    await save(ALICE, { name: "alice-only", origin: "https://a.example", value: VALUE });
    const bobList = (await app.inject({ url: "/secrets", headers: as(BOB) })).json().secrets.map((x: { name: string }) => x.name);
    expect(bobList).not.toContain("alice-only");
    expect((await app.inject({ method: "DELETE", url: "/secrets/alice-only", headers: as(BOB) })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/secrets/alice-only", headers: as(ALICE) })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: "/secrets/alice-only", headers: as(ALICE) })).statusCode).toBe(404);
  });

  it.each([
    ["bad name", { name: "Bad Name", origin: "https://a.example", value: VALUE }],
    ["http site", { name: "x", origin: "http://a.example", value: VALUE }],
    ["site with credentials", { name: "x", origin: "https://u:p@a.example", value: VALUE }],
    ["not a url", { name: "x", origin: "a.example", value: VALUE }],
    ["empty value", { name: "x", origin: "https://a.example", value: "" }],
    ["extra field", { name: "x", origin: "https://a.example", value: VALUE, owner: "bob" }],
    ["missing value", { name: "x", origin: "https://a.example" }],
  ])("rejects %s with 400 and does not echo the value", async (_n, body) => {
    const r = await save(ALICE, body);
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain(VALUE);
  });

  it("requires a token", async () => {
    expect((await app.inject({ url: "/secrets" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/secrets", payload: { name: "x", origin: "https://a.example", value: VALUE } })).statusCode).toBe(401);
  });

  it("answers 503 when the vault is not enabled", async () => {
    const noVault = buildApi({ service: undefined as never, tokenOwners: new Map([[hashToken(ALICE), "alice"]]) });
    await noVault.ready();
    for (const [method, url] of [["GET", "/secrets"], ["POST", "/secrets"], ["DELETE", "/secrets/x"]] as const) {
      const r = await noVault.inject({ method, url, headers: as(ALICE), ...(method === "POST" ? { payload: { name: "x", origin: "https://a.example", value: "v".repeat(10) } } : {}) });
      expect(r.statusCode, url).toBe(503);
      expect(r.json().error).toBe("vault_disabled");
    }
    await noVault.close();
  });
});

describe("entering a password while approving", () => {
  const PW = "typed-into-the-card-Zx81!";
  async function passwordApproval(pageOrigin = "https://app.example", tool = "browser.ask_password") {
    const { id } = (await create(ALICE)).json();
    await store.transition(id, "planning");
    await store.transition(id, "running");
    await store.transition(id, "awaiting_approval");
    const { approval } = await approvals.request(id, {
      tool,
      input: { ref: "e2" },
      context: { page: { url: `${pageOrigin}/login` }, target: { role: "textbox", name: "Password", inputType: "password", pageOrigin } },
      actionFingerprint: `p-${id}`,
      effectFingerprint: `q-${id}`,
      consequentialKind: "use_credentials",
    });
    return { taskId: id, approvalId: approval.id };
  }
  const decide = (token: string, id: string, payload: unknown) => app.inject({ method: "POST", url: `/approvals/${id}/decision`, headers: as(token), payload: payload as never });
  const held = async (approvalId: string) => Number((await db.connect().query("SELECT count(*) AS n FROM approval_secrets WHERE approval_id = $1", [approvalId])).rows[0].n);

  it("marks only password requests as needing a password", async () => {
    const pw = await passwordApproval();
    const other = await passwordApproval("https://app.example", "browser.click");
    const list = (await app.inject({ url: "/approvals", headers: as(ALICE) })).json().approvals as Array<{ id: string; needsSecret: boolean }>;
    expect(list.find((a) => a.id === pw.approvalId)!.needsSecret).toBe(true);
    expect(list.find((a) => a.id === other.approvalId)!.needsSecret).toBe(false);
  });

  it("will not approve a password request without the password, and leaves it pending", async () => {
    const { approvalId, taskId } = await passwordApproval();
    expect((await decide(ALICE, approvalId, { decision: "approved" })).statusCode).toBe(400);
    expect((await store.getTask(taskId)).status).toBe("awaiting_approval");
    expect(await held(approvalId)).toBe(0);
  });

  it("holds the password encrypted, approves, schedules the run, and never echoes it", async () => {
    const { approvalId, taskId } = await passwordApproval();
    const before = enqueued.filter((x) => x === taskId).length;
    const r = await decide(ALICE, approvalId, { decision: "approved", secret: PW });
    expect(r.statusCode).toBe(204);
    expect(r.body).not.toContain(PW);
    expect((await store.getTask(taskId)).status).toBe("running");
    expect(enqueued.filter((x) => x === taskId).length).toBe(before + 1);
    expect(await held(approvalId)).toBe(1);
    const stored = (await db.connect().query("SELECT t::text AS t FROM approval_secrets t WHERE approval_id = $1", [approvalId])).rows[0].t;
    expect(stored).not.toContain(PW);
    // The approval event and the approval row carry no password either.
    expect(JSON.stringify(await store.listEvents(taskId))).not.toContain(PW);
    expect(JSON.stringify((await db.connect().query("SELECT * FROM approvals WHERE id = $1", [approvalId])).rows)).not.toContain(PW);
  });

  it("refuses a password on a rejection or on any other kind of approval", async () => {
    const pw = await passwordApproval();
    expect((await decide(ALICE, pw.approvalId, { decision: "rejected", secret: PW })).statusCode).toBe(400);
    const click = await passwordApproval("https://app.example", "browser.click");
    const r = await decide(ALICE, click.approvalId, { decision: "approved", secret: PW });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain(PW);
    expect(await held(click.approvalId)).toBe(0);
    // Rejecting a password request needs no password and stores nothing.
    expect((await decide(ALICE, pw.approvalId, { decision: "rejected" })).statusCode).toBe(204);
    expect(await held(pw.approvalId)).toBe(0);
  });

  it("can save the password for next time under a name, tied to the page's site", async () => {
    const { approvalId } = await passwordApproval("https://shop.example");
    expect((await decide(ALICE, approvalId, { decision: "approved", secret: PW, saveAs: "shop-password" })).statusCode).toBe(204);
    expect(await vault.reveal("alice", "shop-password")).toEqual({ origin: "https://shop.example", value: PW });
  });

  it("validates before storing anything: bad save name, or a page that is not https", async () => {
    const a = await passwordApproval();
    const bad = await decide(ALICE, a.approvalId, { decision: "approved", secret: PW, saveAs: "Bad Name" });
    expect(bad.statusCode).toBe(400);
    expect(await held(a.approvalId)).toBe(0);
    expect((await approvals.get(a.approvalId)).status).toBe("pending");

    const http = await passwordApproval("http://insecure.example");
    const r = await decide(ALICE, http.approvalId, { decision: "approved", secret: PW });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain(PW);
    expect(await held(http.approvalId)).toBe(0);
  });

  it("only the owner can decide, and a repeat decision leaves no password behind", async () => {
    const { approvalId } = await passwordApproval();
    expect((await decide(BOB, approvalId, { decision: "approved", secret: PW })).statusCode).toBe(404);
    expect(await held(approvalId)).toBe(0);
    expect((await decide(ALICE, approvalId, { decision: "approved", secret: PW })).statusCode).toBe(204);
    await db.connect().query("DELETE FROM approval_secrets WHERE approval_id = $1", [approvalId]); // pretend it was used
    const again = await decide(ALICE, approvalId, { decision: "approved", secret: "second-attempt-pw-1" });
    expect(again.statusCode).toBe(409);
    expect(await held(approvalId)).toBe(0);
  });

  it("answers 503 when passwords cannot be held (no vault key)", async () => {
    const { approvalId } = await passwordApproval();
    const bare = new TaskService({ store, approvals, queue: { enqueueRun: async () => undefined }, limits: policy, artifacts, abortRun: () => undefined });
    const noVault = buildApi({ service: bare, tokenOwners: new Map([[hashToken(ALICE), "alice"]]) });
    await noVault.ready();
    const r = await noVault.inject({ method: "POST", url: `/approvals/${approvalId}/decision`, headers: as(ALICE), payload: { decision: "approved", secret: PW } });
    expect(r.statusCode).toBe(503);
    expect(r.body).not.toContain(PW);
    await noVault.close();
  });
});

describe("auth", () => {
  it("serves /healthz without a token but guards everything else", async () => {
    expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);
    for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: `Basic ${ALICE}` }, { authorization: "Bearer" }]) {
      const r = await app.inject({ url: "/tasks", headers });
      expect(r.statusCode).toBe(401);
      expect(r.headers["www-authenticate"]).toBe("Bearer");
    }
  });
});

describe("POST /tasks", () => {
  it("creates a queued task for the caller and enqueues a run", async () => {
    const r = await create();
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body).toMatchObject({ goal: "open example.com", status: "queued" });
    expect(enqueued).toContain(body.id);
    expect((await store.getTask(body.id)).owner).toBe("alice");
  });

  it("stores resolved limits, clamped to server maximums", async () => {
    const r = await create(ALICE, { goal: "x", limits: { maxToolCalls: 10_000, maxSpendUsd: 0.1, maxRuntimeMinutes: 2 } });
    expect(r.json().limits).toMatchObject({ maxToolCalls: 60, maxSpendUsd: 0.1, maxRuntimeMs: 120_000 });
  });

  it("accepts explicit completion criteria", async () => {
    const r = await create(ALICE, { goal: "x", completionCriteria: [{ kind: "text_present", value: "Done" }] });
    expect(r.json().completionCriteria).toEqual([{ kind: "text_present", value: "Done" }]);
  });

  it.each([
    ["empty goal", { goal: "   " }],
    ["missing goal", {}],
    ["unknown field", { goal: "x", owner: "bob" }],
    ["bad criterion kind", { goal: "x", completionCriteria: [{ kind: "eval_js", value: "1" }] }],
    ["bad limit", { goal: "x", limits: { maxToolCalls: -1 } }],
    ["unknown limit", { goal: "x", limits: { maxEverything: 1 } }],
  ])("rejects %s with 400 and creates nothing", async (_n, payload) => {
    const before = enqueued.length;
    const r = await create(ALICE, payload);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_request");
    expect(enqueued.length).toBe(before);
  });

  it("rejects oversized bodies", async () => {
    const r = await create(ALICE, { goal: "x".repeat(70_000) });
    expect(r.statusCode).toBe(413);
  });

  it("does not let the caller pick the owner", async () => {
    const r = await create(BOB, { goal: "mine" });
    expect((await store.getTask(r.json().id)).owner).toBe("bob");
  });
});

describe("ownership isolation", () => {
  it("hides other owners' tasks as 404 on every route", async () => {
    const { id } = (await create(ALICE)).json();
    for (const [method, url] of [
      ["GET", `/tasks/${id}`],
      ["GET", `/tasks/${id}/events`],
      ["POST", `/tasks/${id}/cancel`],
    ] as const) {
      expect((await app.inject({ method, url, headers: as(BOB) })).statusCode).toBe(404);
    }
    expect((await store.getTask(id)).status).toBe("queued");
    const list = (await app.inject({ url: "/tasks", headers: as(BOB) })).json().tasks as Array<{ id: string }>;
    expect(list.some((t) => t.id === id)).toBe(false);
  });

  it("returns 404 (not 400) for unknown ids and 400 for malformed ids", async () => {
    expect((await app.inject({ url: "/tasks/00000000-0000-4000-8000-000000000000", headers: as(ALICE) })).statusCode).toBe(404);
    expect((await app.inject({ url: "/tasks/not-a-uuid", headers: as(ALICE) })).statusCode).toBe(400);
  });
});

describe("reading tasks", () => {
  it("lists newest first with a limit and returns detail with outcome", async () => {
    const a = (await create(ALICE, { goal: "first" })).json();
    await create(ALICE, { goal: "second" });
    const c = (await create(ALICE, { goal: "third" })).json();
    const list = (await app.inject({ url: "/tasks?limit=2", headers: as(ALICE) })).json().tasks as Array<{ id: string }>;
    expect(list).toHaveLength(2);
    expect(list[0]!.id).toBe(c.id);
    expect(list.map((t) => t.id)).not.toContain(a.id);

    await store.transition(a.id, "failed", { payload: { reason: "limit_exceeded" } });
    const detail = (await app.inject({ url: `/tasks/${a.id}`, headers: as(ALICE) })).json();
    expect(detail).toMatchObject({ status: "failed", pendingApprovals: [], lastTransition: { reason: "limit_exceeded", to: "failed" } });
  });

  it("pages through events with after/limit", async () => {
    const { id } = (await create(ALICE)).json();
    for (let i = 0; i < 4; i++) await store.appendEvent(id, "note", { i });
    const page1 = (await app.inject({ url: `/tasks/${id}/events?limit=2`, headers: as(ALICE) })).json().events as Array<{ seq: number }>;
    expect(page1.map((e) => e.seq)).toEqual([1, 2]);
    const page2 = (await app.inject({ url: `/tasks/${id}/events?after=2&limit=10`, headers: as(ALICE) })).json().events as Array<{ seq: number }>;
    expect(page2.map((e) => e.seq)).toEqual([3, 4, 5]);
  });
});

describe("cancel", () => {
  it("cancels once, interrupts any in-flight run, and then reports a conflict", async () => {
    const { id } = (await create(ALICE)).json();
    const r = await app.inject({ method: "POST", url: `/tasks/${id}/cancel`, headers: as(ALICE) });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("cancelled");
    expect(aborted).toContain(id);
    expect((await app.inject({ method: "POST", url: `/tasks/${id}/cancel`, headers: as(ALICE) })).statusCode).toBe(409);
  });
});

describe("request bodies", () => {
  it("accepts a bodiless POST that still declares a JSON content type, and rejects malformed JSON", async () => {
    const { id } = (await create(ALICE)).json();
    const ok = await app.inject({ method: "POST", url: `/tasks/${id}/cancel`, headers: { ...as(ALICE), "content-type": "application/json" } });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({ method: "POST", url: "/tasks", headers: { ...as(ALICE), "content-type": "application/json" }, payload: "{not json" });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/tasks", headers: { ...as(ALICE), "content-type": "application/json" } })).statusCode).toBe(400); // empty body -> goal missing
  });
});

describe("approvals", () => {
  async function pendingApproval() {
    const { id } = (await create(ALICE)).json();
    await store.transition(id, "planning");
    await store.transition(id, "running");
    await store.transition(id, "awaiting_approval");
    const { approval } = await approvals.request(id, {
      tool: "browser.click",
      input: { ref: "e7" },
      context: { target: { name: "Subscribe" } },
      actionFingerprint: `fp-${id}`,
      effectFingerprint: `ef-${id}`,
      consequentialKind: "send_message",
    });
    return { taskId: id, approvalId: approval.id };
  }
  const decide = (token: string, id: string, payload: unknown) =>
    app.inject({ method: "POST", url: `/approvals/${id}/decision`, headers: as(token), payload: payload as never });

  it("lists pending approvals only for the owner", async () => {
    const { approvalId } = await pendingApproval();
    const mine = (await app.inject({ url: "/approvals", headers: as(ALICE) })).json().approvals as Array<{ id: string; context: unknown }>;
    expect(mine.find((a) => a.id === approvalId)?.context).toEqual({ target: { name: "Subscribe" } });
    const theirs = (await app.inject({ url: "/approvals", headers: as(BOB) })).json().approvals as Array<{ id: string }>;
    expect(theirs.some((a) => a.id === approvalId)).toBe(false);
  });

  it("only the owner can decide; a decision resumes the task and schedules a run", async () => {
    const { taskId, approvalId } = await pendingApproval();
    expect((await decide(BOB, approvalId, { decision: "approved" })).statusCode).toBe(404);
    expect((await store.getTask(taskId)).status).toBe("awaiting_approval");

    const before = enqueued.filter((x) => x === taskId).length;
    expect((await decide(ALICE, approvalId, { decision: "approved" })).statusCode).toBe(204);
    expect((await store.getTask(taskId)).status).toBe("running");
    expect(enqueued.filter((x) => x === taskId).length).toBe(before + 1);
    expect((await decide(ALICE, approvalId, { decision: "rejected" })).statusCode).toBe(409);
  });

  it("validates the decision body and unknown approvals", async () => {
    const { approvalId } = await pendingApproval();
    expect((await decide(ALICE, approvalId, { decision: "maybe" })).statusCode).toBe(400);
    expect((await decide(ALICE, approvalId, { decision: "approved", extra: 1 })).statusCode).toBe(400);
    expect((await decide(ALICE, "00000000-0000-4000-8000-000000000000", { decision: "approved" })).statusCode).toBe(404);
  });
});

describe("POST /notify", () => {
  const queued: Array<{ owner: string; subject: string; dedupeKey: string }> = [];
  let withNotices: ReturnType<typeof buildApi>;
  beforeAll(async () => {
    withNotices = buildApi({
      service: svc,
      tokenOwners: new Map([[hashToken(ALICE), "alice"]]),
      notices: {
        enqueue: async (owner, n) => {
          queued.push({ owner, subject: n.subject, dedupeKey: n.dedupeKey });
          return n.dedupeKey === "again" ? "duplicate" : n.dedupeKey === "over" ? "limit" : "queued";
        },
      },
    });
    await withNotices.ready();
  });
  afterAll(async () => withNotices.close());

  const post = (a: ReturnType<typeof buildApi>, payload: unknown, token: string | null = ALICE) =>
    a.inject({ method: "POST", url: "/notify", headers: token ? as(token) : {}, payload: payload as never });
  const ok = { subject: "[news] held", body: "details", dedupeKey: "public-post:held:2026-10-16" };

  it("needs a token and answers 503 when email is not configured", async () => {
    expect((await post(withNotices, ok, null)).statusCode).toBe(401);
    expect((await post(app, ok)).statusCode).toBe(503);
  });

  it("queues for the caller only, and reports duplicates and the daily limit", async () => {
    const r = await post(withNotices, ok);
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ status: "queued" });
    expect(queued.at(-1)).toMatchObject({ owner: "alice", subject: "[news] held" });
    expect((await post(withNotices, { ...ok, dedupeKey: "again" })).json()).toEqual({ status: "duplicate" });
    const over = await post(withNotices, { ...ok, dedupeKey: "over" });
    expect(over.statusCode).toBe(429);
  });

  it("rejects a missing subject, an oversized body and an odd key", async () => {
    expect((await post(withNotices, { ...ok, subject: "  " })).statusCode).toBe(400);
    expect((await post(withNotices, { ...ok, body: "x".repeat(2001) })).statusCode).toBe(400);
    expect((await post(withNotices, { ...ok, dedupeKey: "has space" })).statusCode).toBe(400);
  });
});
