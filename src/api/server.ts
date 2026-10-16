import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { createTranslator, uiMessages, type Locale } from "../i18n/messages.js";
import { hashToken } from "../runtime/config.js";
import { InvalidSecretError, type SecretStore } from "../vault/secret-store.js";
import { NewUserSchema, OwnerTakenError, UserNotFoundError, UserPatchSchema, type User, type UserStore } from "../persistence/user-store.js";
import { QuotaExceededError, type QuotaService } from "../runtime/quota.js";
import { checkAnthropicKey, type KeyCheck } from "../model/anthropic-key-check.js";
import { ApiKeyStore, InvalidApiKeyError } from "../vault/api-key-store.js";
import type { ModelAccess } from "../runtime/model-router.js";
import { NewScheduleSchema, SchedulePatchSchema, ScheduleLimitError, ScheduleNotFoundError, type Schedule, type ScheduleStore } from "../persistence/schedule-store.js";
import type { Scheduler } from "../runtime/scheduler.js";
import { LoginSessions } from "./login-sessions.js";
import { NOTICE_BODY_MAX, NOTICE_SUBJECT_MAX, type NoticeInput, type NoticeResult } from "../notifications/outbox.js";
import { HumanInputSchema } from "../execution/human-input.js";
import { ConflictError, SaveLoginRequestSchema, ContinueTaskRequestSchema, CreateTaskRequestSchema, InvalidRequestError, NotFoundError, ReleaseControlRequestSchema, VaultDisabledError, type TaskService } from "../runtime/task-service.js";

declare module "fastify" {
  interface FastifyRequest {
    owner: string;
    /** True when the caller signed in with a dashboard session rather than an API token. */
    viaSession: boolean;
    /** admin: may manage users. The tokens in .env are admins. */
    role: "admin" | "user";
  }
}

export interface ApiDeps {
  service: TaskService;
  /** sha256(token) -> owner */
  tokenOwners: ReadonlyMap<string, string>;
  /** Dashboard language. Defaults to English. */
  locale?: Locale;
  /** The credential vault. Without it the /secrets routes answer 503. */
  vault?: SecretStore;
  logger?: boolean;
  /** People added through the dashboard. Without it only the tokens in .env can sign in. */
  users?: UserStore;
  /** Limits on how much each user may start; shown to them on /me. */
  quota?: QuotaService;
  /**
   * Whose model a person's tasks would run on. "blocked" means there is none they may use: the server runs
   * on its owner's personal Claude login, which is not something to share, and they have no key of their own.
   */
  modelAccess?: (owner: string, role: "admin" | "user") => Promise<ModelAccess>;
  /** Set when Jev is on: the mode tasks use unless they pick another. The dashboard shows the choice only then. */
  jevDefault?: "first" | "assist";
  /** Set when the server can open tasks in the owner's own Chrome. Admins only; the dashboard offers it then. */
  ownChrome?: boolean;
  /** People's own Anthropic API keys (bring your own key). Without it the /me/api-key routes answer 503. */
  apiKeys?: ApiKeyStore;
  /** Tasks that start themselves on a schedule. Without these the /schedules routes answer 503. */
  schedules?: ScheduleStore;
  scheduler?: Scheduler;
  /** Checks a key with Anthropic before saving it. Defaults to the real check. */
  verifyApiKey?: (apiKey: string) => Promise<KeyCheck>;
  /** Queues a plain email to the caller (POST /notify). Without it the route answers 503. */
  notices?: { enqueue(owner: string, n: NoticeInput): Promise<NoticeResult> };
  /** One-time dashboard sign-in codes and the sessions they create. A fresh in-memory store by default. */
  sessions?: LoginSessions;
}

// The dashboard is three fixed files served from this process. Only these paths are served,
// so there is no filesystem lookup driven by the request.
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
const WEB_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/assets/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/assets/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

// No inline script or style, no third-party origins, no framing: a page that renders text
// scraped from the web must not be able to run anything it scraped.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' blob: data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const Uuid = z.uuid();
const NoticeBody = z.object({
  subject: z.string().trim().min(1).max(NOTICE_SUBJECT_MAX),
  body: z.string().min(1).max(NOTICE_BODY_MAX),
  dedupeKey: z.string().min(1).max(120).regex(/^[A-Za-z0-9:._-]+$/),
});
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.iso.datetime().optional(),
});
const EventsQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
const SecretBody = z.object({ name: z.string().min(1).max(64), origin: z.string().min(1).max(300), value: z.string().min(1).max(1024) }).strict();
const DecisionBody = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    /** For password requests: the password, typed into the approval card. Never echoed back. */
    secret: z.string().min(1).max(1024).optional(),
    /** Also save the password under this name for the page's site. */
    saveAs: z.string().min(1).max(64).optional(),
  })
  .strict();

/** A feature this server was not set up for (answered with 503, not as a bug). */
class FeatureDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeatureDisabledError";
  }
}

export function buildApi(deps: ApiDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ? { redact: ["req.headers.authorization"] } : false,
    bodyLimit: 64 * 1024,
  });

  app.decorateRequest("owner", "");
  app.decorateRequest("viaSession", false);
  app.decorateRequest("role", "user");
  const envOwners = new Set(deps.tokenOwners.values());
  const sessions = deps.sessions ?? new LoginSessions();

  // Accept an empty JSON body (clients often send the header on bodiless POSTs such as cancel);
  // malformed JSON is still a 400.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "") return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error("Malformed JSON body"), { statusCode: 400 }), undefined);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "invalid_request",
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    if (err instanceof InvalidApiKeyError) {
      return reply.code(400).send({ error: "invalid_request", issues: [{ path: "apiKey", message: err.message }] });
    }
    if (err instanceof InvalidSecretError) {
      return reply.code(400).send({ error: "invalid_request", issues: [{ path: "", message: err.message }] });
    }
    if (err instanceof InvalidRequestError) return reply.code(400).send({ error: "invalid_request", issues: [{ path: err.field, message: err.message }] });
    if (err instanceof VaultDisabledError) return reply.code(503).send({ error: "vault_disabled" });
    if (err instanceof FeatureDisabledError) return reply.code(503).send({ error: "disabled", message: err.message });
    if (err instanceof ScheduleNotFoundError) return reply.code(404).send({ error: "not_found" });
    if (err instanceof ScheduleLimitError) return reply.code(409).send({ error: "conflict", message: err.message });
    if (err instanceof NotFoundError || err instanceof UserNotFoundError) return reply.code(404).send({ error: "not_found" });
    if (err instanceof QuotaExceededError) return reply.code(429).send({ error: "quota_exceeded", reason: err.reason, message: err.message });
    if (err instanceof OwnerTakenError) return reply.code(409).send({ error: "conflict", message: err.message });
    if (err instanceof ConflictError) return reply.code(409).send({ error: "conflict", message: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: "bad_request", message: (err as Error).message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "internal_error" });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not_found" }));

  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
  });

  app.get("/healthz", async () => ({ ok: true }));

  // The dashboard gets its text from one catalog: the server renders the active language into a
  // small script, so server-written text and page text can never disagree.
  const locale = deps.locale ?? "en";
  const escapeHtml = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  // String.raw keeps the backslashes in the regular expression intact in the generated script.
  const i18nScript = [
    `export const locale = ${JSON.stringify(locale)};`,
    `const messages = ${JSON.stringify(uiMessages(locale))};`,
    "export function t(key, params) {",
    "  const s = messages[key] ?? key;",
    String.raw`  return params ? s.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : "{" + k + "}")) : s;`,
    "}",
    "",
  ].join("\n");
  app.get("/assets/i18n.js", async (_req, reply) => {
    reply.header("content-type", "text/javascript; charset=utf-8").header("content-security-policy", CSP);
    return reply.send(i18nScript);
  });

  for (const [route, { file, type }] of Object.entries(WEB_FILES)) {
    let body: Buffer | string = readFileSync(path.join(WEB_DIR, file));
    if (file === "index.html") {
      body = body.toString("utf8").replace("{{LANG}}", locale).replace("{{NOSCRIPT}}", escapeHtml(createTranslator(locale)("ui.noscript")));
    }
    app.get(route, async (_req, reply) => {
      reply.header("content-type", type).header("content-security-policy", CSP).header("x-frame-options", "DENY");
      return reply.send(body);
    });
  }

  /**
   * Who a token belongs to. The tokens in .env are admins; people added through the dashboard have
   * their own token and role; a session (from a one-time code) is the same person as the code's owner.
   * A disabled user is nobody, whichever way they sign in.
   */
  async function authenticate(token: string): Promise<{ owner: string; role: "admin" | "user"; viaSession: boolean } | undefined> {
    const envOwner = deps.tokenOwners.get(hashToken(token));
    if (envOwner) return { owner: envOwner, role: "admin", viaSession: false };
    const sessionOwner = sessions.ownerOf(token);
    if (sessionOwner) {
      if (envOwners.has(sessionOwner)) return { owner: sessionOwner, role: "admin", viaSession: true };
      const u = await deps.users?.get(sessionOwner);
      return u && !u.disabled ? { owner: u.owner, role: u.role, viaSession: true } : undefined;
    }
    const u = await deps.users?.findByToken(token);
    if (!u || u.disabled) return undefined;
    void deps.users!.touch(u.owner).catch(() => {});
    return { owner: u.owner, role: u.role, viaSession: false };
  }

  // Trade a one-time code (made with POST /auth/code) for a session token. Unauthenticated by design:
  // the code is the credential, it is random, single-use and lives for a minute.
  app.post("/auth/redeem", async (req, reply) => {
    const { code } = z.object({ code: z.string().regex(/^[0-9a-f]{32}$/) }).strict().parse(req.body);
    const session = sessions.redeem(code);
    if (!session) return reply.code(401).send({ error: "invalid_code" });
    return session;
  });

  // Everything below requires a bearer token.
  app.register(async (api) => {
    api.addHook("onRequest", async (req, reply) => {
      const header = req.headers.authorization ?? "";
      const m = /^Bearer (\S+)$/.exec(header);
      const who = m ? await authenticate(m[1]!) : undefined;
      if (!who) return reply.code(401).header("www-authenticate", "Bearer").send({ error: "unauthorized" });
      req.owner = who.owner;
      req.role = who.role;
      req.viaSession = who.viaSession;
    });

    // Only a real API token can mint a sign-in code, so a session can never renew itself.
    api.post("/auth/code", async (req, reply) => {
      if (req.viaSession) return reply.code(403).send({ error: "forbidden" });
      return sessions.issueCode(req.owner);
    });

    // A message to the caller's own inbox from another system (e.g. a job that needs a look). Never to
    // anyone else, idempotent per dedupeKey, and capped per day.
    api.post("/notify", async (req, reply) => {
      if (!deps.notices) return reply.code(503).send({ error: "notifications_not_configured" });
      const body = NoticeBody.parse(req.body);
      const status = await deps.notices.enqueue(req.owner, body);
      return reply.code(status === "limit" ? 429 : 202).send({ status });
    });

    api.get("/me", async (req) => ({
      owner: req.owner,
      role: req.role,
      // What this person may use and has used, so the dashboard can say so before a limit is hit.
      ...(deps.quota ? { limits: await deps.quota.limitsFor(req.owner), usage: await deps.quota.usage(req.owner) } : {}),
      ...(deps.ownChrome && req.role === "admin" ? { ownChrome: true } : {}),
      ...(deps.jevDefault ? { jev: { default: deps.jevDefault } } : {}),
      ...(deps.apiKeys ? { byok: true, apiKey: await deps.apiKeys.status(req.owner) } : { byok: false }),
      ...((await deps.modelAccess?.(req.owner, req.role)) === "blocked" ? { blocked: "needs_api_key" } : {}),
    }));

    // Your own Anthropic key: checked, stored encrypted, never shown again.
    api.put("/me/api-key", async (req) => {
      if (!deps.apiKeys) throw new VaultDisabledError();
      const { apiKey } = z.object({ apiKey: z.string().min(1).max(400) }).strict().parse(req.body);
      const key = ApiKeyStore.check(apiKey);
      if ((await (deps.verifyApiKey ?? checkAnthropicKey)(key)) === "invalid") {
        throw new InvalidRequestError("apiKey", "Anthropic did not accept that key. Check that it is correct and still active.");
      }
      return { apiKey: await deps.apiKeys.put(req.owner, key) };
    });
    api.delete("/me/api-key", async (req, reply) => {
      if (!deps.apiKeys) throw new VaultDisabledError();
      await deps.apiKeys.delete(req.owner);
      return reply.code(204).send();
    });

    // Starting work is refused when there is no model this person may use (see modelAccess).
    const requireModelAccess = async (req: { owner: string; role: "admin" | "user" }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
      (await deps.modelAccess?.(req.owner, req.role)) === "blocked"
        ? reply.code(403).send({ error: "needs_api_key", message: createTranslator(deps.locale ?? "en")("error.needsApiKey") })
        : undefined;

    // ---- user management (admins only) ---------------------------------------------------------
    const requireAdmin = (req: { role: string }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
      req.role === "admin" ? undefined : reply.code(403).send({ error: "forbidden" });
    const userView = async (u: User) => ({
      owner: u.owner,
      displayName: u.displayName,
      email: u.email,
      role: u.role,
      disabled: u.disabled,
      maxConcurrent: u.maxConcurrent,
      dailySpendUsd: u.dailySpendUsd,
      createdAt: u.createdAt.toISOString(),
      lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
      ...(deps.quota ? { usage: await deps.quota.usage(u.owner), limits: await deps.quota.limitsFor(u.owner) } : {}),
    });
    const users = () => {
      if (!deps.users) throw new ConflictError("User management is not enabled on this server");
      return deps.users;
    };

    // ---- schedules: tasks that start themselves ------------------------------------------------
    const schedulesOr503 = () => {
      if (!deps.schedules || !deps.scheduler) throw new FeatureDisabledError("Schedules are not enabled on this server");
      return { store: deps.schedules, scheduler: deps.scheduler };
    };
    const scheduleView = async (s: Schedule) => {
      const [last] = await schedulesOr503().store.runs(s.id, 1);
      return {
        id: s.id,
        name: s.name,
        goal: s.goal,
        schedule: s.spec,
        timezone: s.timezone,
        enabled: s.enabled,
        pausedReason: s.pausedReason,
        nextRunAt: s.nextRunAt?.toISOString() ?? null,
        logins: s.logins,
        limits: s.limits,
        completionCriteria: s.completionCriteria,
        createdAt: s.createdAt.toISOString(),
        lastRun: last ? { outcome: last.outcome, ranAt: last.ranAt.toISOString(), taskId: last.taskId, taskStatus: last.taskStatus, detail: last.detail } : null,
      };
    };
    api.get("/schedules", async (req) => {
      const { store } = schedulesOr503();
      return { schedules: await Promise.all((await store.list(req.owner)).map(scheduleView)) };
    });
    api.post("/schedules", async (req, reply) => {
      const { store } = schedulesOr503();
      const input = NewScheduleSchema.parse(req.body);
      await deps.service.checkLogins(req.owner, input.logins); // only logins this person really saved
      return reply.code(201).send(await scheduleView(await store.create(req.owner, input)));
    });
    api.patch("/schedules/:id", async (req) => {
      const { store } = schedulesOr503();
      return scheduleView(await store.update(req.owner, Uuid.parse((req.params as { id: string }).id), SchedulePatchSchema.parse(req.body)));
    });
    api.delete("/schedules/:id", async (req, reply) => {
      await schedulesOr503().store.delete(req.owner, Uuid.parse((req.params as { id: string }).id));
      return reply.code(204).send();
    });
    api.get("/schedules/:id/runs", async (req) => {
      const { store } = schedulesOr503();
      const id = Uuid.parse((req.params as { id: string }).id);
      await store.get(req.owner, id); // 404 for someone else's
      return { runs: (await store.runs(id, 20)).map((r) => ({ outcome: r.outcome, dueAt: r.dueAt.toISOString(), ranAt: r.ranAt.toISOString(), taskId: r.taskId, taskStatus: r.taskStatus, detail: r.detail })) };
    });
    api.post("/schedules/:id/run", async (req, reply) => {
      const { scheduler } = schedulesOr503();
      const result = await scheduler.runNow(req.owner, Uuid.parse((req.params as { id: string }).id));
      return reply.code(result.outcome === "started" ? 201 : 200).send(result);
    });

    // Saved browser logins: listed by name and site, never shown, deleted by name.
    api.get("/logins", async (req) => ({ logins: await deps.service.listLogins(req.owner) }));
    api.delete("/logins/:name", async (req, reply) => {
      await deps.service.deleteLogin(req.owner, String((req.params as { name: string }).name));
      return reply.code(204).send();
    });

    api.get("/admin/users", async (req, reply) => {
      if (requireAdmin(req, reply)) return;
      const list = await users().list();
      return { users: await Promise.all(list.map(userView)), envAdmins: [...envOwners] };
    });
    api.post("/admin/users", async (req, reply) => {
      if (requireAdmin(req, reply)) return;
      const { user, token } = await users().create(NewUserSchema.parse(req.body));
      // The token is shown here and never again: only its hash is stored.
      return reply.code(201).send({ user: await userView(user), token });
    });
    api.post("/admin/users/:owner/token", async (req, reply) => {
      if (requireAdmin(req, reply)) return;
      const owner = String((req.params as { owner: string }).owner);
      return { token: await users().rotateToken(owner) };
    });
    api.patch("/admin/users/:owner", async (req, reply) => {
      if (requireAdmin(req, reply)) return;
      const owner = String((req.params as { owner: string }).owner);
      const patch = UserPatchSchema.parse(req.body);
      if (owner === req.owner && (patch.disabled === true || patch.role === "user")) {
        throw new ConflictError("You cannot disable or demote yourself: no one could undo it");
      }
      return { user: await userView(await users().update(owner, patch)) };
    });

    api.post("/tasks", async (req, reply) => {
      if (await requireModelAccess(req, reply)) return;
      const body = CreateTaskRequestSchema.parse(req.body);
      if (body.browser === "chrome") {
        // Your own Chrome holds your real logins, so only admins may point a task at it.
        if (req.role !== "admin") return reply.code(403).send({ error: "forbidden" });
        if (!deps.ownChrome) throw new ConflictError("This server is not set up to use your own Chrome (CORBITS_BROWSER_CDP_URL)");
      }
      return reply.code(201).send(await deps.service.createTask(req.owner, body));
    });

    api.get("/tasks", async (req) => {
      const q = ListQuery.parse(req.query);
      const tasks = await deps.service.listTasks(req.owner, { limit: q.limit, ...(q.before ? { before: new Date(q.before) } : {}) });
      return { tasks };
    });

    api.get("/tasks/:id", async (req) => deps.service.getTask(req.owner, Uuid.parse((req.params as { id: string }).id)));

    api.get("/tasks/:id/events", async (req) => {
      const id = Uuid.parse((req.params as { id: string }).id);
      const q = EventsQuery.parse(req.query);
      const events = await deps.service.getEvents(req.owner, id, { afterSeq: q.after, limit: q.limit });
      return {
        events: events.map((e) => ({ seq: e.seq, type: e.type, payload: e.payload, createdAt: e.createdAt.toISOString() })),
      };
    });

    api.get("/tasks/:id/timeline", async (req) => deps.service.getTimeline(req.owner, Uuid.parse((req.params as { id: string }).id)));

    api.get("/tasks/:id/artifacts", async (req) => ({ artifacts: await deps.service.listArtifacts(req.owner, Uuid.parse((req.params as { id: string }).id)) }));

    // Task output files. Served with a locked-down CSP and nosniff so nothing in them can run.
    api.get("/artifacts/:id", async (req, reply) => {
      const art = await deps.service.getArtifact(req.owner, Uuid.parse((req.params as { id: string }).id));
      const isText = art.mime === "text/plain";
      reply
        .header("content-type", isText ? "text/plain; charset=utf-8" : art.mime)
        .header("content-disposition", isText ? `attachment; filename="page-text-${art.id.slice(0, 8)}.txt"` : "inline")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .header("content-length", String(art.data.length));
      return reply.send(art.data);
    });

    api.delete("/artifacts/:id", async (req, reply) => {
      await deps.service.deleteArtifact(req.owner, Uuid.parse((req.params as { id: string }).id));
      return reply.code(204).send();
    });

    api.post("/tasks/:id/continue", async (req, reply) => {
      if (await requireModelAccess(req, reply)) return;
      const id = Uuid.parse((req.params as { id: string }).id);
      const body = ContinueTaskRequestSchema.parse(req.body ?? {});
      return reply.code(201).send(await deps.service.continueTask(req.owner, id, body, { ownChrome: Boolean(deps.ownChrome) && req.role === "admin" }));
    });

    // Saved credentials. Values are write-only: no route returns one, and the AI only ever sees names.
    const meta = (m: { name: string; origin: string; createdAt: Date; updatedAt: Date; lastUsedAt: Date | null }) => ({
      name: m.name,
      origin: m.origin,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
      lastUsedAt: m.lastUsedAt?.toISOString() ?? null,
    });
    const vaultOrOff = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
      if (deps.vault) return deps.vault;
      reply.code(503).send({ error: "vault_disabled" });
      return null;
    };

    api.get("/secrets", async (req, reply) => {
      const vault = vaultOrOff(reply);
      if (!vault) return reply;
      return { secrets: (await vault.list(req.owner)).map(meta) };
    });

    api.post("/secrets", async (req, reply) => {
      const vault = vaultOrOff(reply);
      if (!vault) return reply;
      const body = SecretBody.parse(req.body);
      return reply.code(201).send(meta(await vault.put(req.owner, body)));
    });

    api.delete("/secrets/:name", async (req, reply) => {
      const vault = vaultOrOff(reply);
      if (!vault) return reply;
      const ok = await vault.delete(req.owner, String((req.params as { name: string }).name));
      if (!ok) throw new NotFoundError("Secret not found");
      return reply.code(204).send();
    });

    // Live view and takeover of the sandboxed browser.
    api.get("/tasks/:id/live", async (req, reply) => {
      const frame = await deps.service.liveFrame(req.owner, Uuid.parse((req.params as { id: string }).id));
      return reply
        .header("content-type", frame.mime)
        .header("cache-control", "no-store")
        .header("x-frame-width", String(frame.width))
        .header("x-frame-height", String(frame.height))
        .send(frame.data);
    });
    api.post("/tasks/:id/control/take", async (req) => deps.service.takeControl(req.owner, Uuid.parse((req.params as { id: string }).id)));
    api.post("/tasks/:id/control/input", async (req, reply) => {
      await deps.service.humanInput(req.owner, Uuid.parse((req.params as { id: string }).id), HumanInputSchema.parse(req.body));
      return reply.code(204).send();
    });
    // Keep the login the owner just made by hand (only the open page's own site is saved).
    api.post("/tasks/:id/control/save-login", async (req, reply) =>
      reply.code(201).send(await deps.service.saveLogin(req.owner, Uuid.parse((req.params as { id: string }).id), SaveLoginRequestSchema.parse(req.body))),
    );
    api.post("/tasks/:id/control/release", async (req) =>
      deps.service.releaseControl(req.owner, Uuid.parse((req.params as { id: string }).id), ReleaseControlRequestSchema.parse(req.body ?? {})),
    );

    api.post("/tasks/:id/acknowledge", async (req) => deps.service.acknowledge(req.owner, Uuid.parse((req.params as { id: string }).id)));

    api.post("/tasks/:id/cancel", async (req) => deps.service.cancel(req.owner, Uuid.parse((req.params as { id: string }).id)));

    api.get("/approvals", async (req) => ({ approvals: await deps.service.listPendingApprovals(req.owner) }));

    api.post("/approvals/:id/decision", async (req, reply) => {
      const id = Uuid.parse((req.params as { id: string }).id);
      const body = DecisionBody.parse(req.body);
      await deps.service.decideApproval(req.owner, id, body.decision, { secret: body.secret, saveAs: body.saveAs });
      return reply.code(204).send();
    });
  });

  return app;
}
