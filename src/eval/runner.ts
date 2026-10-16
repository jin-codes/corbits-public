import { PlaywrightBrowser } from "../execution/playwright-browser.js";
import type { ModelAdapter } from "../model/types.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { ApprovalStore } from "../persistence/approval-store.js";
import { TaskStore, type TaskEvent } from "../persistence/task-store.js";
import { PolicyEngine } from "../policy/policy-engine.js";
import { DEFAULT_PERMISSIONS } from "../runtime/task-runner.js";
import { createTestDb } from "../testing/test-db.js";
import { createBrowserTools } from "../tools/browser-tools.js";
import { ToolRegistry } from "../tools/registry.js";
import { BrowserStateVerifier } from "../verification/verifier.js";
import type { EvalCase } from "./cases.js";
import { judge, summarize, type CaseResult, type Summary } from "./report.js";
import { startSite } from "./site.js";

export interface EvalOptions {
  cases: readonly EvalCase[];
  /** A fresh model per task, so nothing carries over between cases. */
  makeModel: () => ModelAdapter;
  recoveryAttempts: number;
  repeat: number;
  log?: (line: string) => void;
  /** Per-task safety limits. Defaults keep one task small. */
  limits?: { maxToolCalls: number; maxRuntimeMs: number; maxSpendUsd: number; maxSteps: number };
}

const DEFAULT_LIMITS = { maxToolCalls: 25, maxRuntimeMs: 5 * 60_000, maxSpendUsd: 0.5, maxSteps: 35 };
const MAX_ROUNDS = 12; // pauses (approval or help) one task may go through before the harness gives up

const count = (events: readonly TaskEvent[], type: string) => events.filter((e) => e.type === type).length;

/**
 * Runs each case against a local test site with a real browser and the given model, then compares
 * what Corbits concluded with what the site's own records say actually happened. The harness plays
 * the owner: it approves or rejects as the case says and, when the agent asks for a person, does the
 * step the agent could not.
 */
export async function runEval(opts: EvalOptions): Promise<{ results: CaseResult[]; summary: Summary }> {
  const log = opts.log ?? (() => {});
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const db = await createTestDb();
  await checkClocks(db);
  const site = await startSite();
  const results: CaseResult[] = [];
  try {
    for (const c of opts.cases) {
      for (let run = 1; run <= opts.repeat; run++) {
        log(`▶ ${c.title}${opts.repeat > 1 ? ` (run ${run}/${opts.repeat})` : ""}`);
        const result = await runCase(c, run);
        results.push(result);
        log(`  ${result.status}${result.correct ? " ✓" : " ✗"} · $${result.costUsd.toFixed(3)} · ${(result.durationMs / 1000).toFixed(0)}s · ${result.note}`);
      }
    }
  } finally {
    await site.stop();
    await db.cleanup();
  }
  return { results, summary: summarize(results) };

  async function runCase(c: EvalCase, run: number): Promise<CaseResult> {
    site.reset();
    const started = Date.now();
    const base = { caseId: c.id, title: c.title, run, shouldNotComplete: c.shouldNotComplete ?? false, expectHelp: c.expectHelp ?? false };
    let browser: PlaywrightBrowser | undefined;
    try {
      browser = await PlaywrightBrowser.launch({ allowPrivateNetwork: true, allowedOrigins: [site.origin] });
      const pool = db.connect();
      const store = new TaskStore(pool);
      const approvals = new ApprovalStore(pool);
      const registry = new ToolRegistry();
      for (const t of createBrowserTools(browser)) registry.register(t);
      const orch = new Orchestrator({
        store,
        approvals,
        registry,
        policy: new PolicyEngine(registry),
        model: opts.makeModel(),
        verifier: new BrowserStateVerifier(browser),
        config: {
          limits: { maxToolCalls: limits.maxToolCalls, maxRuntimeMs: limits.maxRuntimeMs, maxSpendUsd: limits.maxSpendUsd },
          maxSteps: limits.maxSteps,
          maxRecoveryAttempts: opts.recoveryAttempts,
          grantedPermissions: DEFAULT_PERMISSIONS,
        },
        actionContext: async () => ({ url: browser!.currentUrl() }),
      });
      const task = await store.createTask({ owner: "eval", goal: c.goal(site), completionCriteria: c.criteria });

      const abort = new AbortController();
      const watchdog = setTimeout(() => abort.abort(), limits.maxRuntimeMs + 60_000);
      let status: CaseResult["status"] = "failed";
      let stoppedIn = ""; // the state the orchestrator was in when the harness gave up, for the report
      try {
        for (let round = 0; ; round++) {
          const r = await orch.run(task.id, { signal: abort.signal });
          if (r.status === "completed" || r.status === "unverified" || r.status === "failed" || r.status === "cancelled") {
            status = r.status;
            break;
          }
          if (r.status === "awaiting_approval") {
            for (const a of await approvals.listPending(task.id)) {
              await orch.decideApproval(a.id, c.approval === "reject" ? "rejected" : "approved", "eval");
            }
          } else if (r.status === "human_control") {
            if (!c.human) {
              await store.transition(task.id, "cancelled", { payload: { reason: "no_person_available" } });
              status = "stuck";
              break;
            }
            await c.human(site, browser);
            await store.appendEvent(task.id, "human.control_ended", { by: "eval", inputs: null, durationMs: null });
            await store.transition(task.id, "running", { payload: { reason: "human_released" } });
          } else {
            stoppedIn = r.status;
            status = "stuck";
            break;
          }
          if (round >= MAX_ROUNDS || abort.signal.aborted) {
            await store.transition(task.id, "cancelled", { payload: { reason: "harness_gave_up" } }).catch(() => {});
            stoppedIn = `${r.status} after ${round + 1} rounds`;
            status = "stuck";
            break;
          }
        }
      } finally {
        clearTimeout(watchdog);
      }

      const events = await store.listEvents(task.id, { limit: 5000 });
      const last = await store.lastTransition(task.id);
      const finalUrl = new URL(browser.currentUrl() === "" ? "about:blank" : browser.currentUrl());
      const attackApprovals = c.approvalMeansAttack ? count(events, "approval.requested") : 0;
      const trapAttempts =
        events.filter((e) => (e.type === "tool.started" || e.type === "tool.denied") && JSON.stringify(e.payload.input ?? "").includes(site.trapOrigin)).length + attackApprovals;
      const truth = c.truth({ site, finalUrl, trapAttempts });
      const verdict = judge({ status, intended: truth.intended, forbidden: truth.forbidden, shouldNotComplete: c.shouldNotComplete ?? false });
      return {
        ...base,
        status,
        ...verdict,
        intended: truth.intended,
        forbidden: truth.forbidden,
        recoveryAttempted: count(events, "recovery.started") > 0,
        costUsd: events.filter((e) => e.type === "model.usage").reduce((s, e) => s + Number(e.payload.costUsd ?? 0), 0),
        durationMs: Date.now() - started,
        modelCalls: count(events, "model.usage"),
        ...tokenFigures(events),
        toolCalls: count(events, "tool.started"),
        approvalsRequested: count(events, "approval.requested"),
        helpRequests: count(events, "help.requested"),
        trapAttempts,
        note: noteFor(status, last, truth, site.state.gateAttempts.length, stoppedIn, modelErrorOf(events)),
        trace: events
          .filter((e) => e.type === "tool.started" || e.type === "help.requested" || e.type === "recovery.started")
          .map((e) => (e.type === "tool.started" ? `${String(e.payload.tool)} ${JSON.stringify(e.payload.input ?? {}).slice(0, 90)}` : e.type)),
        ...(events.filter((e) => e.type === "model.finished").at(-1) ? { finalSummary: String(events.filter((e) => e.type === "model.finished").at(-1)!.payload.summary ?? "").slice(0, 400) } : {}),
      };
    } catch (err) {
      return {
        ...base,
        status: "error",
        completed: false,
        intended: false,
        forbidden: false,
        correct: false,
        falseCompletion: false,
        falseFailure: false,
        recoveryAttempted: false,
        costUsd: 0,
        durationMs: Date.now() - started,
        modelCalls: 0,
        toolCalls: 0,
        approvalsRequested: 0,
        helpRequests: 0,
        claudeInputTokens: 0,
        claudeOutputTokens: 0,
        jevSteps: 0,
        jevTokens: 0,
        trapAttempts: 0,
        note: `harness error: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`.slice(0, 200),
      };
    } finally {
      await browser?.close().catch(() => {});
    }
  }
}

/** Main-model tokens and Jev's are kept apart: a Jev step is marked `via` on its usage event. */
function tokenFigures(events: readonly TaskEvent[]) {
  const usage = events.filter((e) => e.type === "model.usage");
  const jev = usage.filter((e) => e.payload.via === "jev");
  const main = usage.filter((e) => e.payload.via !== "jev");
  const total = (xs: TaskEvent[], k: string) => xs.reduce((s, e) => s + Number(e.payload[k] ?? 0), 0);
  return {
    claudeInputTokens: total(main, "inputTokens"),
    claudeOutputTokens: total(main, "outputTokens"),
    jevSteps: jev.length,
    jevTokens: total(jev, "inputTokens") + total(jev, "outputTokens"),
  };
}

/**
 * Runtime limits compare this process's clock with the database's. After a sleep the database's clock (in
 * Docker) can lag by minutes, which makes every task look like it ran too long: results would be garbage,
 * so refuse to start instead.
 */
async function checkClocks(db: Awaited<ReturnType<typeof createTestDb>>): Promise<void> {
  const pool = db.connect();
  const { rows } = await pool.query<{ ms: string }>("SELECT (extract(epoch from now()) * 1000)::bigint AS ms");
  const skew = Math.abs(Number(rows[0]!.ms) - Date.now());
  if (skew > 5_000) {
    await db.cleanup();
    throw new Error(`The database clock differs from this machine's by ${(skew / 1000).toFixed(0)}s (usually after the Mac slept). Restart Docker (or wait for it to resync) and run again.`);
  }
}

/** What the model adapter reported when a task died of a model error (e.g. a usage limit), clipped. */
function modelErrorOf(events: readonly TaskEvent[]): string {
  const e = events.filter((x) => x.type === "model.error").at(-1);
  return e ? String(e.payload.message ?? e.payload.kind ?? "").replace(/\s+/g, " ").slice(0, 160) : "";
}

function noteFor(status: string, last: Record<string, unknown> | null, truth: { intended: boolean; forbidden: boolean }, wrongCodes: number, stoppedIn: string, modelError: string): string {
  const parts: string[] = [];
  if (status === "failed" && last?.reason) parts.push(`reason: ${String(last.reason)}${modelError ? ` (${modelError})` : ""}`);
  if (status === "stuck") parts.push(`harness stopped it${stoppedIn ? ` (task was ${stoppedIn})` : ""}`);
  if (!truth.intended) parts.push("intended end state not reached");
  if (truth.forbidden) parts.push("FORBIDDEN effect happened");
  if (wrongCodes > 0) parts.push(`${wrongCodes} code guess(es)`);
  return parts.join("; ") || "-";
}
