import type { ArtifactStore } from "../artifacts/artifact-store.js";
import { BrowserArtifactRecorder } from "../artifacts/recorder.js";
import { isTerminal, type TaskState } from "../domain/task-state.js";
import type { Redactor } from "../security/redact.js";
import type { BrowserAdapter } from "../execution/browser-adapter.js";
import type { ModelAdapter } from "../model/types.js";
import { Orchestrator, type RunResult } from "../orchestrator/orchestrator.js";
import type { ApprovalStore } from "../persistence/approval-store.js";
import type { TaskEvent, TaskStore } from "../persistence/task-store.js";
import { PolicyEngine } from "../policy/policy-engine.js";
import { createBrowserTools } from "../tools/browser-tools.js";
import { createVaultTools } from "../tools/vault-tools.js";
import { defaultRedactor } from "../security/redact.js";
import type { OneTimeTaker } from "../vault/one-time.js";
import { mergeStorageStates, secretValues } from "../execution/login-state.js";
import type { LoginStateStore } from "../vault/login-state-store.js";
import type { VaultReader } from "../vault/secret-store.js";
import { ToolRegistry } from "../tools/registry.js";
import { BrowserStateVerifier } from "../verification/verifier.js";
import type { BrowserSessions } from "./browser-sessions.js";
import { limitsForTask, type LimitPolicy } from "./limits.js";

export const DEFAULT_PERMISSIONS: ReadonlySet<string> = new Set([
  "browser.navigate",
  "browser.click",
  "browser.type",
  "browser.paste", // only usable when the task carries a document (the tool is not registered otherwise)
  "browser.scroll",
  "browser.select",
  "browser.read",
  "browser.type_secret", // only usable when the vault is enabled (the tool is not registered otherwise)
]);

/** The document an owner attached when creating the task, if the stored constraints hold a well-formed one. */
export function taskDocument(constraints: Record<string, unknown>): { title: string; markdown: string } | undefined {
  const d = constraints.document as { title?: unknown; markdown?: unknown } | undefined;
  return d && typeof d.title === "string" && typeof d.markdown === "string" ? { title: d.title, markdown: d.markdown } : undefined;
}

export interface TaskRunnerDeps {
  store: TaskStore;
  approvals: ApprovalStore;
  model: ModelAdapter;
  /** Picks the model for a person's task (their own API key, or the server's). Without it everyone uses `model`. */
  modelFor?: (owner: string, jevMode?: "first" | "only" | "summary" | "assist") => Promise<ModelAdapter>;
  sessions: BrowserSessions;
  limits: LimitPolicy;
  /** When given, screenshots and page text are captured as evidence during runs. */
  artifacts?: ArtifactStore;
  redactor?: Redactor;
  /** When given, the agent can have saved credentials typed into password fields (by name only). */
  vault?: VaultReader;
  /** Passwords entered with an approval; enables browser.ask_password. */
  oneTime?: OneTimeTaker;
  /** Saved browser logins. A task that names some starts with its browser already signed in. */
  logins?: LoginStateStore;
}

/**
 * Executes one task for the queue worker: wires a browser session and per-task limits into a
 * fresh orchestrator, runs it as far as it can go, and decides what happens to the session.
 */
export class TaskRunner {
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly d: TaskRunnerDeps) {}

  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }

  /** Interrupts an in-flight run in this process (e.g. after cancellation). */
  abort(taskId: string): void {
    this.active.get(taskId)?.abort();
  }

  async run(taskId: string, signal?: AbortSignal): Promise<RunResult> {
    const task = await this.d.store.getTask(taskId);
    if (isTerminal(task.status)) {
      await this.d.sessions.close(taskId);
      return { status: task.status };
    }

    // Another run of this task is already in progress in this process (a duplicate delivery). Leave it
    // alone: replacing its abort handle would make it impossible to interrupt, and clearing its
    // "active" flag would make a takeover or cancellation think nothing is running.
    if (this.active.has(taskId)) return { status: "busy" };

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    this.active.set(taskId, controller);
    let signedIn: Array<{ name: string; origin: string }> = [];
    try {
      // Only the logins this task was started with, and only into a browser that is new: a browser that
      // survived a pause already has them.
      const wanted = Array.isArray(task.constraints.logins) ? (task.constraints.logins as unknown[]).filter((n): n is string => typeof n === "string") : [];
      const saved = this.d.logins && wanted.length ? await this.d.logins.reveal(task.owner, wanted) : [];
      for (const { state } of saved) for (const v of secretValues(state)) this.d.redactor?.addSecret(v);
      signedIn = saved.map(({ meta }) => ({ name: meta.name, origin: meta.origin }));
      const { browser, fresh } = await this.d.sessions.acquire(taskId, {
        ...(saved.length ? { storageState: mergeStorageStates(saved.map((s) => s.state)) } : {}),
        ...(task.constraints.browser === "chrome" ? { target: "chrome" as const } : {}),
      });
      if (fresh && saved.length) await this.d.store.appendEvent(taskId, "logins.applied", { logins: signedIn });
      if (fresh) await this.restore(taskId, browser);

      const registry = new ToolRegistry();
      const document = taskDocument(task.constraints);
      for (const t of createBrowserTools(browser, document ? { document } : {})) registry.register(t);
      const vault = this.d.vault;
      if (vault) {
        for (const t of createVaultTools({ browser, vault, owner: task.owner, redactor: this.d.redactor ?? defaultRedactor, ...(this.d.oneTime ? { oneTime: this.d.oneTime } : {}) })) registry.register(t);
      }
      const limits = limitsForTask(task.constraints, this.d.limits);
      const signedInSites = async () => signedIn;
      const orchestrator = new Orchestrator({
        store: this.d.store,
        approvals: this.d.approvals,
        registry,
        policy: new PolicyEngine(registry),
        model: this.d.modelFor ? await this.d.modelFor(task.owner, jevModeOf(task.constraints)) : this.d.model,
        verifier: new BrowserStateVerifier(browser),
        config: {
          limits: { maxToolCalls: limits.maxToolCalls, maxRuntimeMs: limits.maxRuntimeMs, maxSpendUsd: limits.maxSpendUsd },
          maxSteps: limits.maxSteps,
          maxRecoveryAttempts: limits.maxRecoveryAttempts,
          grantedPermissions: DEFAULT_PERMISSIONS,
        },
        actionContext: async () => ({ url: browser.currentUrl() }),
        signedInSites,
        ...(vault ? { availableSecrets: async () => (await vault.list(task.owner)).map((m) => ({ name: m.name, origin: m.origin })) } : {}),
        ...(this.d.artifacts
          ? { artifacts: new BrowserArtifactRecorder({ browser, artifacts: this.d.artifacts, store: this.d.store, ...(this.d.redactor ? { redactor: this.d.redactor } : {}) }) }
          : {}),
      });
      const result = await orchestrator.run(taskId, { signal: controller.signal });
      await this.afterRun(taskId, result.status);
      return result;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (this.active.get(taskId) === controller) this.active.delete(taskId);
    }
  }

  /** The task cannot continue (e.g. the worker gave up); records why and frees its browser. */
  async failTask(taskId: string, reason: string, detail?: string): Promise<void> {
    try {
      await this.d.store.transition(taskId, "failed", { payload: { reason, ...(detail ? { detail } : {}) } });
    } catch {
      /* already terminal or moved on */
    }
    await this.d.sessions.close(taskId);
  }

  /**
   * A browser lost to a restart or idle timeout comes back blank. Reload the last known page so
   * the task can continue. Refs are NOT refreshed: the model must take a new snapshot, because
   * its remembered refs may not match this new page load.
   */
  private async restore(taskId: string, browser: BrowserAdapter): Promise<void> {
    const own = lastKnownUrl(await this.d.store.listEvents(taskId));
    // A continued task starts on the page its predecessor ended on.
    const startUrl = (await this.d.store.getTask(taskId)).constraints.startUrl;
    const url = own ?? (typeof startUrl === "string" && /^https?:\/\//.test(startUrl) ? startUrl : undefined);
    if (!url) return;
    try {
      await browser.goto(url);
      await this.d.store.appendEvent(taskId, "session.restored", { url });
    } catch (err) {
      await this.d.store.appendEvent(taskId, "session.restore_failed", {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async afterRun(taskId: string, status: TaskState | "busy"): Promise<void> {
    if (status === "busy") return;
    if (isTerminal(status)) await this.d.sessions.close(taskId);
    else if (status === "awaiting_approval" || status === "human_control") this.d.sessions.keep(taskId);
  }
}

/** The Jev mode a task asked for, if any (stored in its constraints when it was created). */
function jevModeOf(constraints: Record<string, unknown>): "first" | "only" | "summary" | "assist" | undefined {
  const m = constraints.jevMode;
  return m === "first" || m === "only" || m === "summary" || m === "assist" ? m : undefined;
}

export function lastKnownUrl(events: readonly TaskEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "tool.completed") continue;
    const outcome = e.payload.outcome as { status?: string; output?: { url?: unknown } } | undefined;
    const url = outcome?.status === "ok" ? outcome.output?.url : undefined;
    if (typeof url === "string" && /^https?:\/\//.test(url)) return url;
  }
  return undefined;
}
