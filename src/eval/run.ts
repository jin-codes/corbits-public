// Runs the evaluation tasks against your real model and prints a report.
//   pnpm eval                        every case, once
//   pnpm eval --list                 show the cases
//   pnpm eval --cases read-price,impossible --repeat 3 --recovery 0 --label no-recovery
//   pnpm eval --tier hard                          only the harder cases (look-alike links, paging, dead ends); --tier basic for the rest
//   pnpm eval --jev --label jev                    let Jev make plain link-following steps (needs TYPESAFE_API_KEY)
//   pnpm eval --jev-first --label jev-first        Jev drives the browser steps; the main model plans, finishes and takes risky or hard steps
//   pnpm eval --jev-first --consensus               every Jev question asked twice in opposite option orders; act only when both agree
//   pnpm eval --jev-first --plan-gate                Jev decides whether a task with no criteria needs a planning call ("no plan" ends it unverified)
//   pnpm eval --jev-first --escalate-option         same, with ESCALATE among the operations Jev can choose (off by default)
//   pnpm eval --jev-first --summary-model <id> --max-spend 0.10   a cheaper model writes the final summary; per-task cap in dollars (default 0.50)
//   pnpm eval --jev-only --label jev-only            Jev decides every step; no main-model step (plan only when a case has no criteria); stops when Jev cannot continue
//   pnpm eval --jev-first --fallback-model <id>      a cheaper model takes the steps Jev hands over (the main model only plans)
//   pnpm eval --full-history --label full-history  send every older page snapshot (to measure the saving from trimming)
// Uses your Claude Code login by default (CORBITS_MODEL_PROVIDER=api to use ANTHROPIC_API_KEY).
// Needs the local Postgres (pnpm db:up) and Chromium. Results are also saved in eval-results/.
import { mkdirSync, writeFileSync } from "node:fs";
import { ClaudeAdapter, createAnthropicClient } from "../model/claude-adapter.js";
import { ClaudeCodeAdapter, claudeCodeLoginStatus } from "../model/claude-code-adapter.js";
import { JevAssistedModel } from "../model/jev-assisted.js";
import { JevFirstModel } from "../model/jev-first.js";
import { JevClient } from "../model/jev-client.js";
import type { ModelAdapter } from "../model/types.js";
import { CASES } from "./cases.js";
import { renderMarkdown, type EvalMeta } from "./report.js";
import { runEval } from "./runner.js";

try {
  process.loadEnvFile(".env");
} catch {
  /* rely on the process environment */
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("--list")) {
  for (const c of CASES) console.log(`${c.id.padEnd(20)} ${(c.tier ?? "basic").padEnd(6)} ${c.title}`);
  process.exit(0);
}

const wanted = flag("cases")?.split(",").map((s) => s.trim()).filter(Boolean);
const tier = flag("tier"); // basic | hard | (all)
const inTier = (c: (typeof CASES)[number]) => !tier || (tier === "hard" ? c.tier === "hard" : c.tier !== "hard");
const cases = (wanted ? CASES.filter((c) => wanted.includes(c.id)) : CASES).filter(inTier);
const unknown = (wanted ?? []).filter((id) => !CASES.some((c) => c.id === id));
if (unknown.length || cases.length === 0) {
  console.error(`Unknown case(s): ${unknown.join(", ") || "(none given)"}. Run with --list.`);
  process.exit(2);
}
const repeat = Math.max(1, Number(flag("repeat") ?? 1));
const recoveryAttempts = Math.max(0, Number(flag("recovery") ?? 1));
const label = flag("label") ?? "baseline";
const modelId = process.env.CORBITS_CLAUDE_MODEL ?? "claude-sonnet-5-5";
const provider = process.env.CORBITS_MODEL_PROVIDER === "api" ? "api" : "claude-code";

let makeModel: () => ModelAdapter;
if (provider === "api") {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error("CORBITS_MODEL_PROVIDER=api needs ANTHROPIC_API_KEY.");
    process.exit(1);
  }
  makeModel = () => new ClaudeAdapter({ model: modelId, client: createAnthropicClient({ apiKey: key, maxRetries: 1 }) });
} else {
  const login = await claudeCodeLoginStatus();
  if (!login.loggedIn && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error("Claude Code is not logged in. Run `claude auth login`, or set CORBITS_MODEL_PROVIDER=api.");
    process.exit(1);
  }
  makeModel = () => new ClaudeCodeAdapter({ model: modelId });
}

const jevOnly = process.argv.includes("--jev-only"); // Jev-first with no main-model steps at all: measures what Jev can do alone
const jevFirst = process.argv.includes("--jev-first") || jevOnly; // Jev drives; the main model only plans, finishes and handles hard steps
const useJev = process.argv.includes("--jev") || jevFirst;
const planGate = process.argv.includes("--plan-gate"); // Jev-first: Jev decides whether a task with no criteria needs a planning call
const consensus = process.argv.includes("--consensus"); // Jev-first: every question twice in opposite option orders, act only when both agree
const fullHistory = process.argv.includes("--full-history");
if (fullHistory) process.env.CORBITS_FULL_HISTORY = "1";
const jevStats: JevAssistedModel[] = [];
const jevFirstStats: JevFirstModel[] = [];
if (useJev) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) {
    console.error("--jev needs TYPESAFE_API_KEY in .env.");
    process.exit(1);
  }
  const jev = new JevClient({ apiKey: key });
  const minConfidence = Number(flag("min-confidence") ?? (jevFirst ? 0.6 : 0.9)); // the defaults of the two modes in config
const offerEscalate = process.argv.includes("--escalate-option"); // Jev-first: off by default, as in main.ts
  const fallbackModel = flag("fallback-model"); // Jev-first: a cheaper model takes the steps Jev hands over
  const summaryModel = flag("summary-model"); // Jev-first: a cheaper model writes the final summary (same provider and credentials)
  const base = makeModel;
  makeModel = () => {
    if (jevFirst) {
      const templateSummary = summaryModel === "template";
      const summarizer = !summaryModel || templateSummary ? undefined : provider === "api" ? new ClaudeAdapter({ model: summaryModel, client: createAnthropicClient({ apiKey: process.env.ANTHROPIC_API_KEY!, maxRetries: 1 }) }) : new ClaudeCodeAdapter({ model: summaryModel });
      const fallback = !fallbackModel ? undefined : provider === "api" ? new ClaudeAdapter({ model: fallbackModel, client: createAnthropicClient({ apiKey: process.env.ANTHROPIC_API_KEY!, maxRetries: 1 }) }) : new ClaudeCodeAdapter({ model: fallbackModel });
      const m = new JevFirstModel({ inner: base(), jev, minConfidence, offerEscalate, consensus, planGate, ...(fallback ? { fallback } : {}), skipPlan: true, templateSummary: templateSummary || jevOnly, only: jevOnly, ...(summarizer ? { summarizer } : {}) });
      jevFirstStats.push(m);
      return m;
    }
    const m = new JevAssistedModel({ inner: base(), jev, minConfidence });
    jevStats.push(m);
    return m;
  };
}

const total = cases.length * repeat;
console.log(`Evaluating ${total} task(s) with ${provider}:${modelId} (recovery attempts: ${recoveryAttempts}). Each task is capped at $${Number(flag("max-spend") ?? 0.5)} of estimated usage.\n`);

const maxSpend = Number(flag("max-spend") ?? 0.5);
const { results, summary } = await runEval({ cases, makeModel, recoveryAttempts, repeat, limits: { maxToolCalls: 25, maxRuntimeMs: 5 * 60_000, maxSpendUsd: maxSpend, maxSteps: 35 }, log: (l) => console.log(l) });
const meta: EvalMeta = { label, model: modelId, provider, recoveryAttempts, repeat, jev: useJev, fullHistory, startedAt: new Date().toISOString() };
const markdown = renderMarkdown(meta, results, summary);
console.log(`\n${markdown}`);
if (jevFirst) {
  const t = jevFirstStats.reduce((a, m) => ({ asked: a.asked + m.stats.asked, used: a.used + m.stats.used, escalated: a.escalated + Object.values(m.stats.escalated).reduce((x, y) => x + (y ?? 0), 0) }), { asked: 0, used: 0, escalated: 0 });
  const reasons: Record<string, number> = {};
  for (const m of jevFirstStats) for (const [k, v] of Object.entries(m.stats.escalated)) reasons[k] = (reasons[k] ?? 0) + (v ?? 0);
  const gaveUp = jevFirstStats.reduce((n, m) => n + (m.stats.gaveUp ?? 0), 0);
  const disagreed = jevFirstStats.reduce((n, m) => n + (m.stats.disagreed ?? 0), 0);
  if (consensus) console.log(`\nConsensus: the two option orders disagreed ${disagreed} times (those steps went to the main model).`);
  console.log(`\nJev ${jevOnly ? "only" : "first"}: asked ${t.asked} times; decided ${t.used} steps itself; ${jevOnly ? `stopped ${gaveUp} tasks (no main model)` : `main model took ${t.escalated} steps`} (${JSON.stringify(reasons)}).`);
} else if (useJev) {
  const t = jevStats.reduce((a, m) => ({ asked: a.asked + m.stats.asked, used: a.used + m.stats.used, deferred: a.deferred + m.stats.deferred, failed: a.failed + m.stats.failed }), { asked: 0, used: 0, deferred: 0, failed: 0 });
  console.log(`\nJev: asked ${t.asked} times; acted ${t.used}; deferred to the main model ${t.deferred}; unreachable or invalid ${t.failed}.`);
}

mkdirSync("eval-results", { recursive: true });
const stamp = meta.startedAt.replace(/[:.]/g, "-");
writeFileSync(`eval-results/${stamp}-${label}.json`, JSON.stringify({ meta, summary, results }, null, 2));
writeFileSync(`eval-results/${stamp}-${label}.md`, markdown);
console.log(`\nSaved eval-results/${stamp}-${label}.{json,md}`);
