import pg from "pg";
import { buildApi } from "./api/server.js";
import { PostgresArtifactStore } from "./artifacts/artifact-store.js";
import { parseKey } from "./vault/crypto.js";
import { OneTimeSecretStore } from "./vault/one-time.js";
import { SecretStore } from "./vault/secret-store.js";
import { PlaywrightBrowser } from "./execution/playwright-browser.js";
import type { ModelAdapter } from "./model/types.js";
import { ClaudeAdapter, createAnthropicClient } from "./model/claude-adapter.js";
import { ClaudeCodeAdapter, claudeCodeLoginStatus } from "./model/claude-code-adapter.js";
import { JevAssistedModel } from "./model/jev-assisted.js";
import { JevFirstModel } from "./model/jev-first.js";
import { JevClient } from "./model/jev-client.js";
import { migrate } from "./persistence/migrate.js";
import { ApprovalStore } from "./persistence/approval-store.js";
import { TaskStore } from "./persistence/task-store.js";
import { UserStore } from "./persistence/user-store.js";
import { QuotaService } from "./runtime/quota.js";
import { ScheduleStore } from "./persistence/schedule-store.js";
import { Scheduler } from "./runtime/scheduler.js";
import { accessFor, createModelRouter } from "./runtime/model-router.js";
import { ApiKeyStore } from "./vault/api-key-store.js";
import { LoginStateStore } from "./vault/login-state-store.js";
import { NotificationDispatcher } from "./notifications/dispatcher.js";
import { createSmtpSender } from "./notifications/email.js";
import { enqueueNotice, notificationOutbox } from "./notifications/outbox.js";
import { Redactor } from "./security/redact.js";
import { BrowserSessions } from "./runtime/browser-sessions.js";
import { createTranslator } from "./i18n/messages.js";
import { loadConfig } from "./runtime/config.js";
import { TaskQueue } from "./runtime/queue.js";
import { TaskRunner } from "./runtime/task-runner.js";
import { TaskService } from "./runtime/task-service.js";

try {
  process.loadEnvFile(".env");
} catch {
  /* configuration may come from the real environment */
}

const config = loadConfig(process.env);
const t = createTranslator(config.locale);

// Secrets must never reach logs, events, or approvals, even in formats the patterns miss.
const redactor = new Redactor();
if (config.model.provider === "api") redactor.addSecret(config.model.apiKey);
for (const entry of (process.env.CORBITS_API_TOKENS ?? "").split(",")) redactor.addSecret(entry.slice(entry.indexOf(":") + 1).trim());
redactor.addSecret(config.notifications?.smtp.pass);
redactor.addSecret(process.env.CLAUDE_CODE_OAUTH_TOKEN);
redactor.addSecret(config.jev?.apiKey);
if (config.browser.mode === "docker") redactor.addSecret(config.browser.secret);

const pool = new pg.Pool({ connectionString: config.databaseUrl });
await migrate(pool);

// Outbox rows are written even when email is not configured; they are sent once it is.
const store = new TaskStore(pool, redactor, notificationOutbox);
const approvals = new ApprovalStore(pool, redactor);
const artifacts = new PostgresArtifactStore(pool, config.artifacts.limits);
// The credential vault is off unless a key is configured.
const vaultKey = config.secretsKey ? parseKey(config.secretsKey) : undefined;
const vault = vaultKey ? new SecretStore(pool, vaultKey) : undefined;
const oneTime = vaultKey ? new OneTimeSecretStore(pool, vaultKey) : undefined;
if (config.secretsKey) redactor.addSecret(config.secretsKey);
if (!vault) console.warn("[vault] CORBITS_SECRETS_KEY is not set: saved credentials are disabled");
const queue = new TaskQueue({ connectionString: config.databaseUrl, schema: config.queueSchema, maxRunSeconds: config.limits.maximums.maxRuntimeMs / 1000 });
const browserOptions = {
  ...(config.allowedOrigins ? { allowedOrigins: config.allowedOrigins } : {}),
  allowPrivateNetwork: config.allowPrivateNetwork,
};
if (config.browser.mode === "local") {
  console.warn("[browser] running Chromium on this machine WITHOUT container isolation. Set CORBITS_BROWSER_WS_SECRET and run `pnpm docker:up` for the sandbox.");
}
const browser = config.browser;
if (browser.mode === "chrome") {
  console.warn(
    `[browser] using YOUR Chrome at ${browser.cdpUrl}: no container, no egress proxy. The agent works in its own tab with that profile's logins, ${config.allowedOrigins ? `limited to CORBITS_ALLOWED_ORIGINS (${config.allowedOrigins.join(", ")})` : "allowed to visit ANY public site (CORBITS_ALLOW_ANY_ORIGIN); private addresses stay blocked"}. Local use only.`,
  );
  // Fail now, with the fix, instead of on the first task.
  try {
    await (await PlaywrightBrowser.attach({ ...browserOptions, cdpUrl: browser.cdpUrl })).close();
  } catch (err) {
    console.error(`Cannot reach Chrome at ${browser.cdpUrl}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}\nStart it with \`pnpm chrome\` (a separate profile with remote debugging), then restart Corbits.`);
    process.exit(1);
  }
}
if (config.ownChrome && browser.mode !== "chrome") {
  // The sandbox stays the default; your Chrome is offered per task to admins. Not having it running is not fatal.
  console.warn(`[browser] your own Chrome at ${config.ownChrome.cdpUrl} is also available per task (admins, \"My Chrome\" on the new-task form); start it with \`pnpm chrome\`.`);
}
const sessions = new BrowserSessions(
  ({ storageState, target }) =>
    target === "chrome" && config.ownChrome
      ? PlaywrightBrowser.attach({ ...browserOptions, cdpUrl: config.ownChrome.cdpUrl })
      : browser.mode === "docker"
      ? PlaywrightBrowser.connect({ ...browserOptions, ...(storageState ? { storageState } : {}), wsEndpoint: browser.wsEndpoint })
      : browser.mode === "chrome"
        ? // Your own Chrome keeps its own logins; saved ones are never loaded into it (that would change your real cookies).
          PlaywrightBrowser.attach({ ...browserOptions, cdpUrl: browser.cdpUrl })
        : PlaywrightBrowser.launch({ ...browserOptions, ...(storageState ? { storageState } : {}) }),
  config.sessionIdleMs,
);
let model;
if (config.model.provider === "claude-code") {
  // Fail at startup, with a clear message, rather than on the first task.
  const login = await claudeCodeLoginStatus(config.model.bin);
  const hasSetupToken = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  if (!login.loggedIn && !hasSetupToken) {
    console.error(`Claude Code is not logged in (CLI: "${config.model.bin}"). Run \`claude auth login\` as the user that runs Corbits, set CLAUDE_CODE_OAUTH_TOKEN (from \`claude setup-token\`), or set CORBITS_MODEL_PROVIDER=api with an API key.`);
    process.exit(1);
  }
  // `auth status` may not report a setup-token login; a real failure then shows on the first task.
  console.log(`[model] Claude Code ${login.loggedIn ? `login (${login.authMethod})` : "setup-token (login status not reported)"}, model ${config.claudeModel}; no API key is used`);
  model = new ClaudeCodeAdapter({ model: config.claudeModel, bin: config.model.bin });
} else {
  console.log(`[model] Anthropic API key, model ${config.claudeModel}`);
  model = new ClaudeAdapter({ model: config.claudeModel, client: createAnthropicClient({ apiKey: config.model.apiKey }) });
}
// Jev either makes the plain "which link next" steps for whichever model runs a task (assist), or drives
// the browser steps itself and calls that model only for planning, finishing and risky or hard steps (first).
const jevClient = config.jev ? new JevClient({ apiKey: config.jev.apiKey }) : undefined;
// In first mode Jev also stands in for the planning call when the task carries its own criteria, never offers
// ESCALATE (code decides hand-overs; the extra option only lowered Jev's confidence in clear steps, see
// docs/eval-jev-comparison.md), and an optional cheaper model writes the final summary.
// With no summary model configured, Jev saying "done" ends the run with a finish built from the page (no model call).
const templateSummary = !config.summaryModel || config.summaryModel === "template";
const withJev = (inner: ModelAdapter, summarizer?: ModelAdapter, fallback?: ModelAdapter, choice: "first" | "only" | "summary" | "assist" = config.jev?.mode ?? "first"): ModelAdapter =>
  config.jev && jevClient
    ? choice === "only" || choice === "summary"
      // Jev alone ("summary": plus one tools-free model call that writes only the final summary): no planning, step or fallback call, and the best-supported answer is taken whatever its confidence.
      ? new JevFirstModel({ inner, jev: jevClient, minConfidence: 0, offerEscalate: false, skipPlan: true, templateSummary: true, only: true, checkpointEvery: Infinity, ...(choice === "summary" ? { summarizer: summarizer ?? inner } : {}) })
      : choice === "first"
      ? new JevFirstModel({ inner, jev: jevClient, minConfidence: config.jev.thresholds.first, offerEscalate: false, skipPlan: true, templateSummary, consensus: config.jev.consensus, planGate: config.jev.planGate, ...(summarizer ? { summarizer } : {}), ...(fallback ? { fallback } : {}) })
      : new JevAssistedModel({ inner, jev: jevClient, minConfidence: config.jev.thresholds.assist })
    : inner;
if (config.jev?.mode === "first") console.log(`[jev] first: Jev decides browser steps (acts at confidence >= ${config.jev.minConfidence}); the main model plans, finishes, writes text and handles risky or unclear steps.`);
else if (config.jev) console.log(`[jev] on: Jev makes plain link-following steps (acts at confidence >= ${config.jev.minConfidence}); the main model decides everything else.`);
else console.log("[jev] off (set TYPESAFE_API_KEY to use it)");
// The summary model uses the same provider and credentials as the model it stands next to.
const summaryDefault: ModelAdapter | undefined = !config.summaryModel || templateSummary
  ? undefined
  : config.model.provider === "claude-code"
    ? new ClaudeCodeAdapter({ model: config.summaryModel, bin: config.model.bin })
    : new ClaudeAdapter({ model: config.summaryModel, client: createAnthropicClient({ apiKey: config.model.apiKey }) });
if (config.jev?.mode === "first") console.log(templateSummary ? "[jev] final summaries are built from the last page, with no model call" : `[jev] final summaries are written by ${config.summaryModel}`);
// A cheaper model can also take the steps Jev hands over, in place of the main model.
const fallbackDefault: ModelAdapter | undefined = !config.fallbackModel
  ? undefined
  : config.model.provider === "claude-code"
    ? new ClaudeCodeAdapter({ model: config.fallbackModel, bin: config.model.bin })
    : new ClaudeAdapter({ model: config.fallbackModel, client: createAnthropicClient({ apiKey: config.model.apiKey }) });
if (config.fallbackModel && config.jev?.mode === "first") console.log(`[jev] steps Jev hands over are taken by ${config.fallbackModel}; ${config.claudeModel} only plans tasks that have no criteria`);
const baseModel = model; // without Jev; tasks that pick a mode wrap it themselves
model = withJev(model, summaryDefault, fallbackDefault);

// People added through the dashboard. The tokens in .env stay admins, and their names are reserved.
const envOwners = new Set(config.tokenOwners.values());
const users = new UserStore(pool, envOwners);
// Each person may bring their own Anthropic API key; it needs the secrets key to be stored encrypted.
const apiKeys = vaultKey ? new ApiKeyStore(pool, vaultKey) : undefined;
// Saved browser logins (cookies for one site, encrypted) so a task can start signed in; same key requirement.
const logins = vaultKey ? new LoginStateStore(pool, vaultKey) : undefined;
// The server's model is only lendable to other people if it is an API key, never the owner's personal Claude login.
const serverModelIsShareable = config.model.provider === "api";
const isAdmin = async (owner: string) => envOwners.has(owner) || (await users.get(owner))?.role === "admin";
const modelFor = createModelRouter({
  defaultModel: model,
  isAdmin,
  ownKey: async (owner) => (apiKeys ? apiKeys.reveal(owner) : null),
  serverModelIsShareable,
  // A task that picked its own Jev mode on the dashboard (the server's own login/key model, wrapped accordingly).
  defaultFor: (choice) => withJev(baseModel, summaryDefault, fallbackDefault, choice),
  forKey: (apiKey, choice) => {
    const client = createAnthropicClient({ apiKey, maxRetries: 1 });
    return withJev(
      new ClaudeAdapter({ model: config.claudeModel, client }),
      config.summaryModel && !templateSummary ? new ClaudeAdapter({ model: config.summaryModel, client }) : undefined,
      config.fallbackModel ? new ClaudeAdapter({ model: config.fallbackModel, client }) : undefined,
      choice,
    );
  },
  onKey: (apiKey) => redactor.addSecret(apiKey),
});
const quota = new QuotaService(pool, config.userDefaults, async (owner) => {
  const ownKey = apiKeys ? await apiKeys.has(owner) : false;
  if (envOwners.has(owner)) return { unlimited: true, maxConcurrent: null, dailySpendUsd: null };
  const u = await users.get(owner);
  if (!u) return undefined;
  return { unlimited: u.role === "admin", maxConcurrent: u.maxConcurrent, dailySpendUsd: u.dailySpendUsd, ownKey };
}, t);
const runner = new TaskRunner({ store, approvals, model, modelFor, sessions, limits: config.limits, artifacts, redactor, ...(logins ? { logins } : {}), ...(vault ? { vault } : {}), ...(oneTime ? { oneTime } : {}) });
const service = new TaskService({ store, approvals, queue, limits: config.limits, artifacts, t, ...(oneTime ? { oneTime } : {}), ...(vault ? { vault } : {}), abortRun: (id) => runner.abort(id), quota, ...(logins ? { logins } : {}), human: { browser: (id) => sessions.peek(id), isRunActive: (id) => runner.isActive(id), touch: (id) => sessions.keep(id) } });

await queue.start();
await queue.startWorker(async (taskId, ctx) => void (await runner.run(taskId, ctx.signal)), {
  concurrency: config.workerConcurrency,
  onFinalFailure: (taskId, err) => runner.failTask(taskId, "worker_error", redactor.redactString(err instanceof Error ? err.message : String(err))),
});

const dispatcher = config.notifications
  ? new NotificationDispatcher({
      pool,
      store,
      approvals,
      sender: createSmtpSender(config.notifications.smtp),
      ownerEmails: async (owner) => config.notifications!.ownerEmails.get(owner) ?? (await users.get(owner))?.email ?? undefined,
      ...(config.notifications.publicUrl ? { publicUrl: config.notifications.publicUrl } : {}),
      redactor,
      t,
    })
  : null;
if (dispatcher) dispatcher.start();
else console.warn("[notifications] email is not configured; notifications will queue but not be sent");

// Screenshots may show sensitive pages, so they are deleted after the retention period.
const purgeArtifacts = async () => {
  try {
    const n = await artifacts.purgeOlderThan(new Date(Date.now() - config.artifacts.retentionDays * 86_400_000));
    if (n > 0) console.log(`[artifacts] purged ${n} artifact(s) older than ${config.artifacts.retentionDays} days`);
  } catch (err) {
    console.error("[artifacts] purge failed:", redactor.redactString(String((err as Error)?.message ?? err)));
  }
};
await purgeArtifacts();
const purgeTimer = setInterval(() => void purgeArtifacts(), 60 * 60 * 1000);
purgeTimer.unref();
// A password entered with an approval is deleted when used; any that never were are removed after 30 minutes.
const purgeOneTime = () => void oneTime?.purgeOlderThan(new Date(Date.now() - 30 * 60_000)).catch(() => {});
const oneTimeTimer = setInterval(purgeOneTime, 5 * 60_000);
oneTimeTimer.unref();
purgeOneTime();

const modelAccess = async (owner: string, role: "admin" | "user") =>
  accessFor({ admin: role === "admin", hasOwnKey: apiKeys ? await apiKeys.has(owner) : false, serverModelIsShareable });
// Tasks that start themselves: each moment that comes due creates an ordinary task for its owner (same limits,
// approvals and quotas), unless that owner is disabled, has no model they may use, or the last run is still going.
const scheduleStore = new ScheduleStore(pool);
const scheduler = new Scheduler({
  store: scheduleStore,
  tasks: service,
  isActive: async (owner) => envOwners.has(owner) || (await users.get(owner))?.disabled === false,
  canStart: async (owner) => (await modelAccess(owner, (await isAdmin(owner)) ? "admin" : "user")) !== "blocked",
  existingLogins: async (owner, names) => (logins ? logins.existing(owner, names) : new Set<string>()),
  log: (line) => console.log(line),
});
const app = buildApi({ service, ...(config.ownChrome ? { ownChrome: true } : {}), ...(config.jev ? { jevDefault: config.jev.mode } : {}), tokenOwners: config.tokenOwners, users, quota, modelAccess, ...(dispatcher ? { notices: { enqueue: (owner: string, n: Parameters<typeof enqueueNotice>[2]) => enqueueNotice(pool, owner, n) } } : {}), schedules: scheduleStore, scheduler, ...(apiKeys ? { apiKeys } : {}), locale: config.locale, ...(vault ? { vault } : {}), logger: true });
await app.listen({ host: config.host, port: config.port });
if (config.scheduler) scheduler.start();
else console.log("[scheduler] off (CORBITS_SCHEDULER=0): scheduled tasks will not start");

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, "shutting down");
  await app.close(); // stop taking requests
  await queue.stop(); // let running jobs finish; they are interrupted via their abort signals on timeout
  scheduler.stop();
  await dispatcher?.stop();
  await sessions.closeAll();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
