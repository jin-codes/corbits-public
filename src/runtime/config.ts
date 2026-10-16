import { createHash } from "node:crypto";
import { z } from "zod";
import type { Locale } from "../i18n/messages.js";
import { DEFAULT_ARTIFACT_LIMITS, type ArtifactLimits } from "../artifacts/artifact-store.js";
import type { SmtpConfig } from "../notifications/email.js";
import type { LimitPolicy } from "./limits.js";

const Bool = z.enum(["true", "false"]).default("false").transform((v) => v === "true");

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  /**
   * "claude-code" (default): decisions come from the locally installed, logged-in Claude Code CLI,
   * billed to your Claude subscription. "api": the Anthropic API with ANTHROPIC_API_KEY.
   */
  CORBITS_MODEL_PROVIDER: z.enum(["claude-code", "api"]).default("claude-code"),
  /** Only used (and required) when CORBITS_MODEL_PROVIDER=api. Never passed to Claude Code. */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  CORBITS_CLAUDE_BIN: z.string().min(1).default("claude"),
  CORBITS_CLAUDE_MODEL: z.string().min(1),
  /** Optional cheaper model that only writes the final summary when Jev-first mode decides a task is done (same provider and credentials as the main model), or "template" to build it from the last page with no model call. */
  CORBITS_SUMMARY_MODEL: z.string().min(1).optional(),
  /** Optional cheaper model that takes the steps Jev hands over (unsure, risky, no progress...) in place of the main model, in Jev-first mode. Same provider and credentials as the main model. The main model still plans when a task has no criteria. */
  CORBITS_FALLBACK_MODEL: z.string().min(1).optional(),
  /** `owner:token` pairs, comma separated. Tokens must be at least 32 characters. */
  CORBITS_API_TOKENS: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default("127.0.0.1"),
  /**
   * Name of the pg-boss schema holding the job queue. Servers sharing a database and schema share
   * jobs, so give a test or staging instance its own to keep it from picking up another's work.
   */
  CORBITS_QUEUE_SCHEMA: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, "lowercase letters, digits and _ only").default("pgboss"),
  CORBITS_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  CORBITS_ALLOWED_ORIGINS: z.string().optional(),
  /** Own-Chrome mode only: let the agent visit any public site instead of a list. Private addresses stay blocked. */
  CORBITS_ALLOW_ANY_ORIGIN: Bool,
  CORBITS_ALLOW_PRIVATE_NETWORK: Bool,
  CORBITS_SESSION_IDLE_MINUTES: z.coerce.number().positive().default(30),
  CORBITS_MAX_TOOL_CALLS: z.coerce.number().int().positive().default(60),
  CORBITS_MAX_RUNTIME_MINUTES: z.coerce.number().positive().default(30),
  CORBITS_MAX_SPEND_USD: z.coerce.number().positive().default(2),
  CORBITS_MAX_RECOVERY_ATTEMPTS: z.coerce.number().int().min(0).default(2),
  /** `owner:email` pairs, comma separated. Notifications go to the task owner's address. */
  CORBITS_OWNER_EMAILS: z.string().optional(),
  CORBITS_SMTP_HOST: z.string().default("smtp.gmail.com"),
  CORBITS_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
  CORBITS_SMTP_USER: z.string().optional(),
  CORBITS_SMTP_PASS: z.string().optional(),
  CORBITS_SMTP_FROM: z.string().optional(),
  /** Enables the credential vault: 64 hex characters (32 bytes). Losing it makes saved credentials unrecoverable. */
  CORBITS_SECRETS_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 64 hexadecimal characters").optional(),
  /** Language of the dashboard, history text, and emails. */
  CORBITS_LOCALE: z.enum(["ko", "en"]).default("ko"),
  /** Screenshots can contain sensitive page content, so they expire. */
  CORBITS_ARTIFACT_RETENTION_DAYS: z.coerce.number().positive().default(30),
  CORBITS_ARTIFACT_MAX_PER_TASK: z.coerce.number().int().positive().default(DEFAULT_ARTIFACT_LIMITS.maxPerTask),
  /** Tasks that start themselves on a schedule. On unless set to 0 (for example on a machine that is often asleep). */
  CORBITS_SCHEDULER: z.enum(["0", "1", "false", "true"]).optional(),
  CORBITS_ARTIFACT_MAX_MB_PER_TASK: z.coerce.number().positive().default(DEFAULT_ARTIFACT_LIMITS.maxBytesPerTask / (1024 * 1024)),
  /** Enables the Docker browser sandbox. Must match the value `docker compose` was started with. */
  CORBITS_BROWSER_WS_SECRET: z.string().min(24).optional(),
  CORBITS_BROWSER_HOST: z.string().default("127.0.0.1"),
  CORBITS_BROWSER_PORT: z.coerce.number().int().min(1).max(65535).default(9222),
  /**
   * Attach to your own Chrome instead of the sandbox (local use only; see README). Must point at
   * this machine, and CORBITS_ALLOWED_ORIGINS must be set so the agent can only visit sites you list.
   */
  CORBITS_BROWSER_CDP_URL: z.string().optional(),
  /** What each non-admin user may use unless the admin sets something else for them. */
  CORBITS_USER_MAX_CONCURRENT: z.coerce.number().int().min(1).max(50).default(2),
  CORBITS_USER_DAILY_SPEND_USD: z.coerce.number().min(0).max(1000).default(2),
  CORBITS_USER_MAX_TASKS_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(30),
  TYPESAFE_API_KEY: z.string().min(10).optional(),
  /** Act on Jev's pick only at or above this confidence; never below 0.6 (the owner lowered the floor from 0.75 on 2026-10-11; see docs/eval-jev-comparison.md). Default: 0.75 in assist mode (the owner lowered it from 0.9 on 2026-10-11; the evaluation was measured at 0.9), 0.6 in first mode (the default mode since 2026-10-11). */
  CORBITS_JEV_MIN_CONFIDENCE: z.coerce.number().min(0.6).max(1).optional(),
  /** "assist": the main model drives and Jev picks plain links. "first": Jev drives and the main model is called only for planning, finishing and risky or hard steps. */
  CORBITS_JEV_MODE: z.enum(["assist", "first"]).default("first"),
  /** Jev-first: ask every question twice with the options in opposite orders and act only when both agree (hands over otherwise). More Jev tokens per step; off until `pnpm eval --jev-first --consensus` shows it pays. */
  CORBITS_JEV_CONSENSUS: z.enum(["1", "true", "0", "false"]).optional(),
  /** Jev-first: for a new task with no criteria, let Jev decide whether a planning call is needed. "No plan" ends such a task `unverified`, since the plan call is where criteria are proposed. Off until `pnpm eval --jev-first --plan-gate` shows it pays. */
  CORBITS_JEV_PLAN_GATE: z.enum(["1", "true", "0", "false"]).optional(),
  /** Base URL used for links in emails, e.g. the dashboard address. */
  CORBITS_PUBLIC_URL: z.url().optional(),
});

export interface RuntimeConfig {
  databaseUrl: string;
  claudeModel: string;
  summaryModel?: string;
  fallbackModel?: string;
  model: { provider: "claude-code"; bin: string } | { provider: "api"; apiKey: string };
  /** sha256(token) -> owner. Plaintext tokens are not kept after startup. */
  tokenOwners: ReadonlyMap<string, string>;
  port: number;
  host: string;
  workerConcurrency: number;
  queueSchema: string;
  allowedOrigins: readonly string[] | undefined;
  allowPrivateNetwork: boolean;
  sessionIdleMs: number;
  limits: LimitPolicy;
  locale: Locale;
  /** Present only when the credential vault is enabled. */
  secretsKey: string | undefined;
  artifacts: { retentionDays: number; limits: ArtifactLimits };
  /** Whether this process starts scheduled tasks. */
  scheduler: boolean;
  /** "docker": attach to the sandboxed browser container. "local": launch Chromium on this machine (development only). */
  /** Your own Chrome, offered per task (admins only) when CORBITS_BROWSER_CDP_URL is set. It is the default browser only when no sandbox is configured. */
  ownChrome: { cdpUrl: string } | undefined;
  browser: { mode: "docker"; wsEndpoint: string; secret: string } | { mode: "chrome"; cdpUrl: string } | { mode: "local" };
  /** Limits for users other than admins (the tokens in .env are admins). */
  userDefaults: { maxConcurrent: number; dailySpendUsd: number; maxTasksPerHour: number };
  /** Present only when Jev assistance is switched on and configured. */
  jev: { apiKey: string; minConfidence: number; mode: "assist" | "first"; consensus: boolean; planGate: boolean; /** The threshold each mode uses, for tasks that pick their own mode. */ thresholds: { first: number; assist: number } } | undefined;
  /** Present only when SMTP and recipient addresses are fully configured. */
  notifications: { smtp: SmtpConfig; ownerEmails: ReadonlyMap<string, string>; publicUrl: string | undefined } | undefined;
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function parseApiTokens(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const i = entry.indexOf(":");
    const owner = entry.slice(0, i);
    const token = entry.slice(i + 1);
    if (i <= 0 || !owner) throw new Error("CORBITS_API_TOKENS entries must look like owner:token");
    if (token.length < 32) throw new Error(`API token for "${owner}" is too short (minimum 32 characters)`);
    const h = hashToken(token);
    if (map.has(h)) throw new Error("Duplicate API token in CORBITS_API_TOKENS");
    map.set(h, owner);
  }
  if (map.size === 0) throw new Error("CORBITS_API_TOKENS is empty");
  return map;
}

const EmailSchema = z.email();

export function parseOwnerEmails(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const i = entry.indexOf(":");
    const owner = entry.slice(0, i);
    const email = entry.slice(i + 1);
    if (i <= 0 || !owner) throw new Error("CORBITS_OWNER_EMAILS entries must look like owner:email");
    if (!EmailSchema.safeParse(email).success) throw new Error(`Invalid email address for owner "${owner}" in CORBITS_OWNER_EMAILS`);
    map.set(owner, email);
  }
  return map;
}

function notificationConfig(e: z.infer<typeof EnvSchema>): RuntimeConfig["notifications"] {
  const parts = { CORBITS_SMTP_USER: e.CORBITS_SMTP_USER, CORBITS_SMTP_PASS: e.CORBITS_SMTP_PASS, CORBITS_OWNER_EMAILS: e.CORBITS_OWNER_EMAILS };
  const missing = Object.entries(parts).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length === Object.keys(parts).length) return undefined; // notifications not configured
  if (missing.length > 0) throw new Error(`Incomplete email configuration, missing: ${missing.join(", ")}`);
  return {
    smtp: {
      host: e.CORBITS_SMTP_HOST,
      port: e.CORBITS_SMTP_PORT,
      user: e.CORBITS_SMTP_USER!,
      pass: e.CORBITS_SMTP_PASS!,
      from: e.CORBITS_SMTP_FROM ?? e.CORBITS_SMTP_USER!,
    },
    ownerEmails: parseOwnerEmails(e.CORBITS_OWNER_EMAILS!),
    publicUrl: e.CORBITS_PUBLIC_URL,
  };
}

/** Only an address on this machine: a debugging port reachable from elsewhere would hand over the whole browser. */
export function isLoopbackHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv): RuntimeConfig {
  // A blank `NAME=` line (as in .env.example) means "not set", not an empty value.
  const env = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Name the variables but never echo their values.
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
    throw new Error(`Invalid configuration: ${names.join(", ")}`);
  }
  const e = parsed.data;
  if (e.CORBITS_MODEL_PROVIDER === "api" && !e.ANTHROPIC_API_KEY) {
    throw new Error("Invalid configuration: ANTHROPIC_API_KEY (required when CORBITS_MODEL_PROVIDER=api)");
  }
  // Jev is on whenever its key is set; there is no switch to turn it off (without the key the main model does everything).
  const jevOn = Boolean(e.TYPESAFE_API_KEY);
  if (e.CORBITS_BROWSER_CDP_URL) {
    // Driving your own Chrome is a deliberate, local-only choice with fewer protections than the sandbox.
    if (!isLoopbackHttpUrl(e.CORBITS_BROWSER_CDP_URL)) {
      throw new Error("Invalid configuration: CORBITS_BROWSER_CDP_URL (must be http://127.0.0.1:PORT or http://localhost:PORT)");
    }
    const listed = Boolean(e.CORBITS_ALLOWED_ORIGINS?.split(",").some((o) => o.trim()));
    if (e.CORBITS_ALLOW_ANY_ORIGIN) {
      // A deliberate weakening: no site list, so a page's injected text can send the agent to any public site.
      if (listed) throw new Error("Invalid configuration: CORBITS_ALLOW_ANY_ORIGIN and CORBITS_ALLOWED_ORIGINS (choose one)");
      if (e.CORBITS_ALLOW_PRIVATE_NETWORK) {
        throw new Error("Invalid configuration: CORBITS_ALLOW_ANY_ORIGIN and CORBITS_ALLOW_PRIVATE_NETWORK (private addresses must stay blocked when any site is allowed)");
      }
    } else if (!listed) {
      throw new Error("Invalid configuration: CORBITS_ALLOWED_ORIGINS (required with CORBITS_BROWSER_CDP_URL: list the sites the agent may visit, or set CORBITS_ALLOW_ANY_ORIGIN=true)");
    }
  } else if (e.CORBITS_ALLOW_ANY_ORIGIN) {
    throw new Error("Invalid configuration: CORBITS_ALLOW_ANY_ORIGIN (only valid with CORBITS_BROWSER_CDP_URL)");
  }
  const maximums = {
    maxToolCalls: e.CORBITS_MAX_TOOL_CALLS,
    maxRuntimeMs: e.CORBITS_MAX_RUNTIME_MINUTES * 60_000,
    maxSpendUsd: e.CORBITS_MAX_SPEND_USD,
    maxSteps: e.CORBITS_MAX_TOOL_CALLS + 10,
    maxRecoveryAttempts: e.CORBITS_MAX_RECOVERY_ATTEMPTS,
  };
  const defaults = {
    maxToolCalls: Math.min(30, maximums.maxToolCalls),
    maxRuntimeMs: Math.min(10 * 60_000, maximums.maxRuntimeMs),
    maxSpendUsd: Math.min(0.1, maximums.maxSpendUsd), // per task; a request may ask for more, up to CORBITS_MAX_SPEND_USD
    maxSteps: Math.min(40, maximums.maxSteps),
    maxRecoveryAttempts: Math.min(1, maximums.maxRecoveryAttempts),
  };
  return {
    databaseUrl: e.DATABASE_URL,
    claudeModel: e.CORBITS_CLAUDE_MODEL,
    ...(e.CORBITS_SUMMARY_MODEL ? { summaryModel: e.CORBITS_SUMMARY_MODEL } : {}),
    ...(e.CORBITS_FALLBACK_MODEL ? { fallbackModel: e.CORBITS_FALLBACK_MODEL } : {}),
    model:
      e.CORBITS_MODEL_PROVIDER === "api"
        ? { provider: "api", apiKey: e.ANTHROPIC_API_KEY! }
        : { provider: "claude-code", bin: e.CORBITS_CLAUDE_BIN },
    tokenOwners: parseApiTokens(e.CORBITS_API_TOKENS),
    port: e.PORT,
    host: e.HOST,
    workerConcurrency: e.CORBITS_WORKER_CONCURRENCY,
    queueSchema: e.CORBITS_QUEUE_SCHEMA,
    allowedOrigins: e.CORBITS_ALLOWED_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean),
    allowPrivateNetwork: e.CORBITS_ALLOW_PRIVATE_NETWORK,
    sessionIdleMs: e.CORBITS_SESSION_IDLE_MINUTES * 60_000,
    limits: { defaults, maximums },
    locale: e.CORBITS_LOCALE,
    secretsKey: e.CORBITS_SECRETS_KEY,
    scheduler: e.CORBITS_SCHEDULER !== "0" && e.CORBITS_SCHEDULER !== "false",
    artifacts: {
      retentionDays: e.CORBITS_ARTIFACT_RETENTION_DAYS,
      limits: {
        maxBytesEach: DEFAULT_ARTIFACT_LIMITS.maxBytesEach,
        maxPerTask: e.CORBITS_ARTIFACT_MAX_PER_TASK,
        maxBytesPerTask: Math.round(e.CORBITS_ARTIFACT_MAX_MB_PER_TASK * 1024 * 1024),
      },
    },
    ownChrome: e.CORBITS_BROWSER_CDP_URL ? { cdpUrl: e.CORBITS_BROWSER_CDP_URL } : undefined,
    browser: e.CORBITS_BROWSER_WS_SECRET
      ? {
          mode: "docker",
          wsEndpoint: `ws://${e.CORBITS_BROWSER_HOST}:${e.CORBITS_BROWSER_PORT}/${e.CORBITS_BROWSER_WS_SECRET}`,
          secret: e.CORBITS_BROWSER_WS_SECRET,
        }
      : e.CORBITS_BROWSER_CDP_URL
      ? { mode: "chrome", cdpUrl: e.CORBITS_BROWSER_CDP_URL }
      : { mode: "local" },
    userDefaults: { maxConcurrent: e.CORBITS_USER_MAX_CONCURRENT, dailySpendUsd: e.CORBITS_USER_DAILY_SPEND_USD, maxTasksPerHour: e.CORBITS_USER_MAX_TASKS_PER_HOUR },
    jev: jevOn
      ? (() => {
          const thresholds = { first: e.CORBITS_JEV_MIN_CONFIDENCE ?? 0.6, assist: e.CORBITS_JEV_MIN_CONFIDENCE ?? 0.75 };
          return { apiKey: e.TYPESAFE_API_KEY!, minConfidence: thresholds[e.CORBITS_JEV_MODE], mode: e.CORBITS_JEV_MODE, consensus: e.CORBITS_JEV_CONSENSUS === "1" || e.CORBITS_JEV_CONSENSUS === "true", planGate: e.CORBITS_JEV_PLAN_GATE === "1" || e.CORBITS_JEV_PLAN_GATE === "true", thresholds };
        })()
      : undefined,
    notifications: notificationConfig(e),
  };
}
