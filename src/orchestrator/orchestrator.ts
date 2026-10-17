import { randomUUID } from "node:crypto";
import { ApprovalService } from "../approvals/approval-service.js";
import { InvalidTransitionError, type TaskState } from "../domain/task-state.js";
import type { ArtifactRecorder } from "../artifacts/recorder.js";
import type { SecretInfo, TaskContext } from "../model/context.js";
import type { ModelAdapter } from "../model/types.js";
import { PlanResultSchema, StepResultSchema, ModelError } from "../model/types.js";
import type { ApprovalStore } from "../persistence/approval-store.js";
import {
  StaleStateError,
  type Task,
  type TaskEvent,
  type TaskStore,
} from "../persistence/task-store.js";
import type { Decision, Limits, PolicyEngine } from "../policy/policy-engine.js";
import { MAX_AUTO_APPROVALS, matchStandingApproval, standingApprovalsOf } from "../policy/standing-approvals.js";
import { executeAllowed } from "../tools/executor.js";
import type { ToolRegistry } from "../tools/registry.js";
import { CriteriaSchema, type Criterion } from "../verification/criteria.js";
import { deriveGoalCriteria } from "../verification/goal-criteria.js";
import { pageMeets } from "../verification/verifier.js";
import type { Verifier } from "../verification/verifier.js";
import { buildObservations, clipOutput, deriveUsage, findDanglingCalls } from "./derive.js";

export interface OrchestratorConfig {
  limits: Limits;
  /** Total model step calls allowed per task; stops loops that never reach a tool call. */
  maxSteps: number;
  maxRecoveryAttempts: number;
  grantedPermissions: ReadonlySet<string>;
}

export interface OrchestratorDeps {
  store: TaskStore;
  approvals: ApprovalStore;
  registry: ToolRegistry;
  policy: PolicyEngine;
  model: ModelAdapter;
  verifier: Verifier;
  config: OrchestratorConfig;
  /** Names and allowed sites of saved credentials the agent may use (never their values). */
  availableSecrets?: () => Promise<SecretInfo[]>;
  /** Sites this task's browser was started signed in to (names and sites only). */
  signedInSites?: () => Promise<SecretInfo[]>;
  /** Optional evidence capture (screenshots, page text). Best effort: never affects the task outcome. */
  artifacts?: ArtifactRecorder;
  /** Where actions are proposed (e.g. current page origin). Approvals are bound to it. */
  actionContext?: () => Promise<unknown>;
  now?: () => number;
}

export type RunResult = { status: TaskState } | { status: "busy" };

export { NotAuthorizedError } from "../approvals/approval-service.js";

export class Orchestrator {
  private readonly controllers = new Map<string, AbortController>();
  private readonly now: () => number;

  constructor(private readonly d: OrchestratorDeps) {
    this.now = d.now ?? Date.now;
  }

  /**
   * Drives a task as far as it can go without outside input. Safe to call repeatedly and
   * concurrently: a per-task lease means duplicate deliveries return "busy" instead of
   * double-executing, and the persisted state decides what happens next.
   */
  async run(taskId: string, opts: { signal?: AbortSignal } = {}): Promise<RunResult> {
    const leased = await this.d.store.withLease(taskId, () => this.drive(taskId, opts.signal));
    return leased.acquired ? leased.value : { status: "busy" };
  }

  /** Cancels a task. Works from any process; in-flight tool calls in this process are aborted. */
  async cancel(taskId: string, reason = "user_requested"): Promise<Task> {
    const task = await this.d.store.transition(taskId, "cancelled", { payload: { reason } });
    this.controllers.get(taskId)?.abort();
    return task;
  }

  /** Records the owner's decision. Call run() afterwards to continue the task. */
  async decideApproval(approvalId: string, decision: "approved" | "rejected", decidedBy: string): Promise<void> {
    await new ApprovalService(this.d.store, this.d.approvals).decide(approvalId, decision, decidedBy);
  }

  // ---- state dispatch -------------------------------------------------------------------

  private async drive(taskId: string, external?: AbortSignal): Promise<RunResult> {
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    const onExternalAbort = () => controller.abort();
    if (external?.aborted) controller.abort();
    external?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      for (;;) {
        const task = await this.d.store.getTask(taskId);
        // Shutdown or cancellation of this run: stop without changing the task's state, so a
        // later run (another worker, or this one after restart) resumes from the persisted state.
        if (controller.signal.aborted && task.status !== "cancelled") return { status: task.status };
        switch (task.status) {
          case "queued":
            await this.move(taskId, "planning", "queued");
            break;
          case "planning":
            await this.plan(task, controller.signal);
            break;
          case "running":
            await this.runLoop(task, controller.signal);
            break;
          case "awaiting_approval":
            if ((await this.d.approvals.listPending(taskId)).length > 0) return { status: "awaiting_approval" };
            await this.move(taskId, "running", "awaiting_approval", { reason: "approvals_decided" });
            break;
          case "verifying":
            await this.verify(task);
            break;
          default:
            return { status: task.status };
        }
      }
    } finally {
      external?.removeEventListener("abort", onExternalAbort);
      this.controllers.delete(taskId);
    }
  }

  // ---- planning -------------------------------------------------------------------------

  private async plan(task: Task, signal: AbortSignal): Promise<void> {
    let raw;
    const own = CriteriaSchema.safeParse(task.completionCriteria);
    const ownGiven = own.success && own.data.length > 0;
    // No criteria from the owner: take what the goal itself spells out (quoted phrases). They are handed to the model
    // as given, so a model that skips planning for given criteria does.
    const fromGoal = ownGiven ? [] : deriveGoalCriteria(task.goal);
    const given = ownGiven ? own.data : fromGoal;
    try {
      raw = await this.d.model.plan(
        { goal: task.goal, constraints: limitsOnly(task.constraints), tools: this.d.registry.describeForModel(), ...(given.length > 0 ? { givenCriteria: given } : {}), ...(await this.contextFor(task)) },
        signal,
      );
    } catch (err) {
      return this.failOnModelError(task.id, "planning", "plan", err, signal);
    }
    const plan = PlanResultSchema.safeParse(raw);
    if (!plan.success) {
      return this.fail(task.id, "planning", "invalid_model_response", { phase: "plan", detail: plan.error.message });
    }
    await this.recordUsage(task.id, "plan", plan.data.usage);

    // Task-supplied criteria win, then those spelled out in the goal; plan-proposed criteria are only a fallback.
    const criteriaSource = ownGiven ? "task" : fromGoal.length > 0 ? "goal" : "plan";
    const criteria = ownGiven ? own.data : fromGoal.length > 0 ? fromGoal : plan.data.criteria;
    // No criteria is allowed: the task runs and then ends `unverified` (see verify), never `completed`.
    if (!ownGiven) await this.d.store.setCompletionCriteria(task.id, criteria);

    await this.d.store.appendEvent(task.id, "plan.created", { steps: plan.data.steps, criteria, criteriaSource });
    await this.move(task.id, "running", "planning");
  }

  // ---- execution ------------------------------------------------------------------------

  private async runLoop(task: Task, signal: AbortSignal): Promise<void> {
    const id = task.id;
    const plan = await this.latestPlan(id);
    if (!plan) return this.fail(id, "running", "missing_plan");

    for (;;) {
      const events = await this.d.store.listEvents(id);
      const current = await this.d.store.getTask(id);
      if (current.status !== "running") return; // cancelled or moved by someone else
      if (signal.aborted) return;

      // A call that started but never finished: its outcome is unknown. Never re-run a
      // consequential one; for low-risk calls just record the abandonment and carry on.
      for (const call of findDanglingCalls(events)) {
        if (call.risk === "consequential") {
          return this.fail(id, "running", "interrupted_consequential_action", { tool: call.tool, callId: call.callId });
        }
        await this.d.store.appendEvent(id, "tool.abandoned", { callId: call.callId, tool: call.tool });
      }

      // The user approved an action: do exactly that before asking the model anything else, instead of
      // hoping the model proposes the same call again. (Skipped if secret scrubbing altered the stored
      // input, since the exact original is then unknown.)
      const approved = await this.d.approvals.nextApprovedUnused(id);
      if (approved && !JSON.stringify(approved.input).includes("[REDACTED")) {
        const r = await this.handleProposed(id, signal, approved.tool, approved.input, approved.id);
        if (r === "stop") return;
        continue;
      }

      const usage = deriveUsage(events, this.now());
      const steps = events.filter((e) => e.type === "model.step").length;
      if (steps >= this.d.config.maxSteps) return this.fail(id, "running", "step_limit_reached", { steps });
      const limitHit = this.limitReached(usage);
      if (limitHit) return this.fail(id, "running", "limit_exceeded", { detail: limitHit });

      let raw;
      try {
        raw = await this.d.model.step(
          {
            goal: current.goal,
            plan: plan.steps,
            criteria: plan.criteria,
            tools: this.d.registry.describeForModel(),
            observations: buildObservations(events),
            ...(await this.contextFor(current)),
          },
          signal,
        );
      } catch (err) {
        return this.failOnModelError(id, "running", "step", err, signal);
      }
      const step = StepResultSchema.safeParse(raw);
      if (!step.success) {
        return this.fail(id, "running", "invalid_model_response", { phase: "step", detail: step.error.message });
      }
      const via = step.data.type === "tool_call" ? step.data.via : undefined;
      await this.recordUsage(id, "step", step.data.usage, via);
      await this.d.store.appendEvent(id, "model.step", { kind: step.data.type, ...(via ? { via } : {}) });

      if (step.data.type === "finish") {
        // The model's claim is recorded but is never the basis for completion.
        await this.d.store.appendEvent(id, "model.finished", { summary: step.data.summary });
        await this.move(id, "verifying", "running");
        return;
      }

      if (step.data.type === "help") {
        if (await this.requestHelp(id, events, step.data.reason)) return;
        continue;
      }

      const r = await this.handleProposed(id, signal, step.data.tool, step.data.input);
      if (r === "stop") return;
    }
  }

  /**
   * Approves, on the owner's standing grant, a held click that matches it exactly, and carries it out.
   * Returns what carrying it out returned, or null (and does nothing) when there is no grant, no match, the cap
   * is reached, or the same action was already requested before (then a person decides, as usual).
   */
  private async tryStandingApproval(
    id: string,
    signal: AbortSignal,
    decision: Extract<Decision, { kind: "require_approval" }>,
    inspection: Record<string, unknown> | undefined,
    actionContext: unknown,
  ): Promise<"continue" | "stop" | null> {
    const task = await this.d.store.getTask(id);
    const grants = standingApprovalsOf(task.constraints);
    if (grants.length === 0) return null;
    const page = (actionContext as { url?: unknown } | null)?.url;
    const hit = matchStandingApproval(grants, decision.tool.name, inspection, page);
    if (!hit) return null;
    const used = (await this.d.store.listEvents(id, { types: ["approval.auto_approved"] })).length;
    if (used >= MAX_AUTO_APPROVALS) return null;

    const { approval, created } = await this.d.approvals.request(id, {
      tool: decision.tool.name,
      input: decision.input,
      context: { page: actionContext, target: inspection ?? null },
      actionFingerprint: decision.actionFingerprint,
      effectFingerprint: decision.effectFingerprint,
      consequentialKind: decision.consequentialKind,
    });
    if (!created) return null;
    await this.d.approvals.decide(approval.id, "approved", `standing:${hit.origin}`);
    await this.d.store.appendEvent(id, "approval.auto_approved", {
      approvalId: approval.id,
      tool: decision.tool.name,
      input: decision.input,
      control: hit.name,
      origin: hit.origin,
      grantedBy: "owner (standing approval on this task)",
    });
    return this.handleProposed(id, signal, decision.tool.name, decision.input, approval.id);
  }

  /**
   * Carries out one proposed action under the policy engine: denies it, asks for approval, or runs it.
   * `replayOf` is set when the proposal comes from an approval the user already gave (see runLoop).
   */
  private async handleProposed(id: string, signal: AbortSignal, tool: string, input: unknown, replayOf?: string): Promise<"continue" | "stop"> {
    const fresh = await this.d.store.listEvents(id);
    const inspection = await this.inspect(tool, input);
    const actionContext = await (this.d.actionContext?.() ?? Promise.resolve({}));
    const decision = this.d.policy.evaluate(
      { tool: tool, input: input, inspection },
      {
        grantedPermissions: this.d.config.grantedPermissions,
        limits: this.d.config.limits,
        usage: deriveUsage(fresh, this.now()),
        approvals: await this.d.approvals.policyRecords(id),
        actionContext,
      },
    );

    // An approved action that is being carried out for the user's approval, but which no longer
    // matches it (the page moved, the target changed), is retired so it is never retried in a loop.
    if (replayOf && !(decision.kind === "allow" && decision.approvalId === replayOf)) {
      await this.d.approvals.consume(replayOf);
      await this.d.store.appendEvent(id, "approval.stale", { approvalId: replayOf, tool, reason: decision.kind });
    }

    if (decision.kind === "deny") {
      await this.d.store.appendEvent(id, "tool.denied", {
        tool: tool,
        input: input,
        code: decision.code,
        reason: decision.reason,
      });
      if (decision.code === "limit_exceeded") {
        await this.fail(id, "running", "limit_exceeded", { detail: decision.reason });
        return "stop";
      }
      return "continue"; // the model sees the denial and can choose differently
    }

    if (decision.kind === "require_approval") {
      // The owner may have given advance permission for this exact click (see policy/standing-approvals.ts).
      // The approval is still requested, decided and consumed like any other, so it is on the record.
      if (!replayOf) {
        const auto = await this.tryStandingApproval(id, signal, decision, inspection, actionContext);
        if (auto) return auto;
      }
      const { approval } = await this.d.approvals.request(id, {
        tool: decision.tool.name,
        input: decision.input,
        context: { page: actionContext, target: inspection ?? null },
        actionFingerprint: decision.actionFingerprint,
        effectFingerprint: decision.effectFingerprint,
        consequentialKind: decision.consequentialKind,
      });
      // Capture what the page looks like right now: this is what the approver is being asked about.
      await this.capture(id, { attachKey: `approval:${approval.id}`, label: "When approval was requested", kinds: ["screenshot"] });
      await this.d.store.appendEvent(id, "approval.requested", {
        approvalId: approval.id,
        tool: decision.tool.name,
        input: decision.input,
        context: { page: actionContext, target: inspection ?? null },
        consequentialKind: decision.consequentialKind ?? null,
      });
      await this.move(id, "awaiting_approval", "running");
      return "stop";
    }

    // Allowed. Consume the approval first so a crash after this point can never re-authorize.
    if (decision.approvalId && !(await this.d.approvals.consume(decision.approvalId))) {
      await this.d.store.appendEvent(id, "tool.denied", {
        tool: decision.tool.name,
        input: decision.input,
        code: "approval_already_used",
        reason: "Approval was already used",
      });
      return "continue";
    }

    const callId = randomUUID();
    await this.d.store.appendEvent(id, "tool.started", {
      callId,
      tool: decision.tool.name,
      input: decision.input,
      risk: decision.risk,
      approvalId: decision.approvalId ?? null,
      target: inspection ?? null,
    });
    const outcome = await executeAllowed(decision, signal);
    await this.d.store.appendEvent(id, "tool.completed", {
      callId,
      tool: decision.tool.name,
      input: decision.input,
      attempts: outcome.attempts,
      outcome: summarizeOutcome(outcome),
    });
    if (outcome.status === "cancelled") return "stop";
    await this.capture(id, { attachKey: `tool:${callId}`, label: decision.tool.name, kinds: ["screenshot"] });
    return "continue";
  }

  /** What the model should know besides the goal: a continued attempt's history, the user's note, saved credentials. */
  private async contextFor(task: Task): Promise<TaskContext> {
    const c = task.constraints;
    const secrets = this.d.availableSecrets ? await this.d.availableSecrets().catch(() => []) : [];
    const signedIn = this.d.signedInSites ? await this.d.signedInSites().catch(() => []) : [];
    return {
      ...(typeof c.carryOver === "string" ? { priorAttempt: c.carryOver } : {}),
      ...(typeof c.userNote === "string" && c.userNote ? { userNote: c.userNote } : {}),
      ...(secrets.length ? { secrets } : {}),
      ...(signedIn.length ? { signedIn } : {}),
      ...(c.document && typeof (c.document as { title?: unknown }).title === "string" && typeof (c.document as { markdown?: unknown }).markdown === "string"
        ? { document: { title: (c.document as { title: string }).title, chars: (c.document as { markdown: string }).markdown.length } }
        : {}),
    };
  }

  /**
   * Resolves what a call would actually act on (e.g. the element behind a ref) using the tool's
   * read-only `inspect`. Only runs on schema-valid input. A failed inspection is reported as such
   * so classification falls back to the safer behavior.
   */
  private async inspect(toolName: string, rawInput: unknown): Promise<Record<string, unknown> | undefined> {
    const tool = this.d.registry.get(toolName);
    if (!tool?.inspect) return undefined;
    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) return undefined; // the policy engine will deny invalid input
    try {
      return await Promise.race([
        tool.inspect(parsed.data),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("inspect timed out")), 5000).unref()),
      ]);
    } catch {
      return { inspectionFailed: true };
    }
  }

  // ---- verification and recovery ---------------------------------------------------------

  private async verify(task: Task): Promise<void> {
    const id = task.id;
    const parsed = CriteriaSchema.safeParse(task.completionCriteria);
    if (!parsed.success) return this.fail(id, "verifying", "no_completion_criteria");

    const events = await this.d.store.listEvents(id);
    const attempt = events.filter((e) => e.type === "verification.completed").length + 1;
    await this.capture(id, { attachKey: `verification:${attempt}`, label: "What the verifier saw", kinds: ["screenshot", "page_text"] });
    if (parsed.data.length === 0) {
      // Nothing to check the result against. Say so plainly instead of calling it a success or inventing a failure.
      await this.d.store.appendEvent(id, "verification.completed", { attempt, verdict: "unverified", results: [], evidence: null });
      await this.move(id, "unverified", "verifying", { reason: "no_completion_criteria" });
      return;
    }
    let result;
    try {
      const claim = [...events].reverse().find((e) => e.type === "model.finished")?.payload.summary;
      result = await this.d.verifier.verify(parsed.data, typeof claim === "string" ? claim : undefined);
    } catch (err) {
      result = { verdict: "inconclusive" as const, results: [], evidence: null, error: errMsg(err) };
    }
    // Criteria not given by the owner as criteria (proposed by the plan, or taken from the goal) may be true before any work was done; say so instead of treating that as proof.
    const metBeforeWork = result.verdict === "verified" && this.proposedByPlan(events) && this.metOnFirstPage(events, parsed.data);
    await this.d.store.appendEvent(id, "verification.completed", { attempt, ...result, ...(metBeforeWork ? { metBeforeWork: true } : {}) });

    if (result.verdict === "verified") {
      await this.move(id, "completed", "verifying", { outcome: "verified" });
      return;
    }

    const failedCriteria = result.results.filter((r) => !r.passed).map((r) => r.detail);
    const recoveries = events.filter((e) => e.type === "recovery.started").length;
    const usage = deriveUsage(events, this.now());
    const canRecover =
      result.verdict === "failed" && recoveries < this.d.config.maxRecoveryAttempts && !this.limitReached(usage);
    if (canRecover) {
      await this.d.store.appendEvent(id, "recovery.started", { attempt: recoveries + 1, failedCriteria });
      await this.move(id, "running", "verifying", { reason: "recovery" });
      return;
    }
    const passed = result.results.filter((r) => r.passed).length;
    await this.fail(id, "verifying", result.verdict === "inconclusive" ? "verification_inconclusive" : "verification_failed", {
      outcome: passed > 0 ? "partial" : "failed",
      failedCriteria,
    });
  }

  private proposedByPlan(events: readonly TaskEvent[]): boolean {
    const plan = [...events].reverse().find((e) => e.type === "plan.created");
    return plan?.payload.criteriaSource === "plan" || plan?.payload.criteriaSource === "goal";
  }

  /**
   * Were all the criteria already true on the first page the agent saw? Read from the stored first page (clipped, so
   * a criterion that only sits further down counts as not met there), with no extra browser call. Plain URL/text
   * criteria only.
   */
  private metOnFirstPage(events: readonly TaskEvent[], criteria: readonly Criterion[]): boolean {
    for (const e of events) {
      if (e.type !== "tool.completed") continue;
      const out = e.payload.outcome as { status?: unknown; output?: { url?: unknown; ariaSnapshot?: unknown } } | undefined;
      const page = out?.status === "ok" ? out.output : undefined;
      if (typeof page?.url !== "string" || typeof page.ariaSnapshot !== "string") continue;
      const first = { url: page.url, ariaSnapshot: page.ariaSnapshot };
      return criteria.length > 0 && criteria.every((c) => pageMeets(c, first) === true);
    }
    return false;
  }

  // ---- helpers --------------------------------------------------------------------------

  private limitReached(usage: ReturnType<typeof deriveUsage>): string | undefined {
    const { limits } = this.d.config;
    if (usage.toolCalls >= limits.maxToolCalls) return `tool call limit (${limits.maxToolCalls})`;
    if (usage.elapsedMs >= limits.maxRuntimeMs) return `runtime limit (${limits.maxRuntimeMs}ms)`;
    if (usage.spendUsd >= limits.maxSpendUsd) return `spending limit ($${limits.maxSpendUsd})`;
    return undefined;
  }

  private async latestPlan(id: string): Promise<{ steps: string[]; criteria: Criterion[] } | null> {
    const events = await this.d.store.listEvents(id);
    const e = [...events].reverse().find((x: TaskEvent) => x.type === "plan.created");
    if (!e) return null;
    return { steps: e.payload.steps as string[], criteria: e.payload.criteria as Criterion[] };
  }

  private async recordUsage(id: string, phase: string, u: { inputTokens: number; outputTokens: number; costUsd: number }, via?: string) {
    // `via` marks a decision made by something other than the main model; its tokens are not the main model's.
    await this.d.store.appendEvent(id, "model.usage", { phase, ...(via ? { via } : this.d.model.label ? { provider: this.d.model.label } : {}), ...u });
  }

  /** Transition that tolerates losing a race (e.g. the task was cancelled meanwhile). */
  /**
   * The agent asked for a person. Pauses the task under human control (nothing here grants the agent
   * any power: it is only a pause plus a notification). Asking again and again is capped, so a model
   * that keeps punting cannot stall a task forever. Returns true when the run should stop.
   */
  private async requestHelp(id: string, events: readonly TaskEvent[], reason: string): Promise<boolean> {
    const asked = events.filter((e) => e.type === "help.requested").length;
    if (asked >= MAX_HELP_REQUESTS) {
      await this.d.store.appendEvent(id, "help.declined", { reason });
      return false;
    }
    await this.d.store.appendEvent(id, "help.requested", { reason });
    await this.move(id, "human_control", "running", { reason: "agent_requested_help" });
    return true;
  }

  private async move(id: string, to: TaskState, from: TaskState, payload?: Record<string, unknown>): Promise<void> {
    try {
      await this.d.store.transition(id, to, { expectedFrom: from, ...(payload ? { payload } : {}) });
    } catch (err) {
      if (err instanceof StaleStateError || err instanceof InvalidTransitionError) return;
      throw err;
    }
  }

  private async fail(id: string, from: TaskState, reason: string, extra: Record<string, unknown> = {}): Promise<void> {
    // verification already captured its own evidence
    if (from !== "verifying") await this.capture(id, { attachKey: `failure:${reason}`, label: "State when the task stopped", kinds: ["screenshot"] });
    await this.move(id, "failed", from, { reason, ...extra });
  }

  private async capture(id: string, req: Parameters<ArtifactRecorder["capture"]>[1]): Promise<void> {
    if (!this.d.artifacts) return;
    try {
      await this.d.artifacts.capture(id, req);
    } catch {
      /* evidence never decides the outcome */
    }
  }

  private async failOnModelError(id: string, from: TaskState, phase: string, err: unknown, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return; // the run was interrupted, not the model's fault
    const kind = err instanceof ModelError ? err.kind : "unavailable";
    await this.d.store.appendEvent(id, "model.error", { phase, kind, message: errMsg(err) });
    await this.fail(id, from, kind === "invalid_response" ? "invalid_model_response" : "model_error", { phase, kind });
  }
}

/** Constraints the model may see: limits only. Carry-over and notes are passed separately and labeled. */
function limitsOnly(constraints: Record<string, unknown>): Record<string, unknown> {
  const { carryOver: _c, userNote: _n, startUrl: _u, ...rest } = constraints;
  return rest;
}

/** How many times one task may pause itself to ask for a person; further requests are declined. */
export const MAX_HELP_REQUESTS = 3;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function summarizeOutcome(o: Awaited<ReturnType<typeof executeAllowed>>) {
  switch (o.status) {
    case "ok":
      return { status: "ok", output: clipOutput(o.output) };
    case "error":
    case "invalid_output":
      return { status: o.status, error: o.error };
    default:
      return { status: o.status };
  }
}
