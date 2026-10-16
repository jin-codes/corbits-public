import { z } from "zod";
import { ApprovalService, NotAuthorizedError } from "../approvals/approval-service.js";
import { InvalidTransitionError } from "../domain/task-state.js";
import { ApprovalNotFoundError, ApprovalNotPendingError, type Approval, type ApprovalStore } from "../persistence/approval-store.js";
import type { OneTimeSecretStore } from "../vault/one-time.js";
import { InvalidSecretError, normalizeOrigin, validateName, type SecretStore } from "../vault/secret-store.js";
import { TaskNotFoundError, type Task, type TaskEvent, type TaskStore } from "../persistence/task-store.js";
import { buildTimeline, describeCall, type TimelineResult } from "../api/timeline.js";
import { isHumanControllable, type HumanControllable, type HumanInput, type LiveFrame } from "../execution/human-input.js";
import type { Artifact, ArtifactMeta, ArtifactStore } from "../artifacts/artifact-store.js";
import { tEn, type Translator } from "../i18n/messages.js";
import { CriteriaSchema } from "../verification/criteria.js";
import { buildCarryOver } from "../orchestrator/carry-over.js";
import { RequestedLimitsSchema, limitsForTask, resolveLimits, type LimitPolicy } from "./limits.js";
import type { RunQueue } from "./queue.js";
import type { QuotaService } from "./quota.js";
import { LoginStateError } from "../execution/login-state.js";
import { deriveGoalCriteria } from "../verification/goal-criteria.js";
import { LoginStateStoreError, type LoginMeta, type LoginStateStore } from "../vault/login-state-store.js";

/**
 * Which stored artifact belongs to an approval. Looked up through the history, not the artifact
 * row: when nothing changed on screen a capture reuses an earlier image, and only the history
 * records that it belongs to this approval.
 */
function screenshotFor(files: ArtifactMeta[], attachments: TaskEvent[], approvalId: string): string | null {
  const live = new Set(files.map((f) => f.id));
  const hit = attachments.find((e) => e.payload.attachKey === `approval:${approvalId}` && e.payload.kind === "screenshot" && live.has(String(e.payload.artifactId)));
  return hit ? String(hit.payload.artifactId) : null;
}

export class NotFoundError extends Error {
  constructor(what = "Not found") {
    super(what);
    this.name = "NotFoundError";
  }
}

/** The request is well-formed but not acceptable (e.g. a password sent to something that does not take one). */
export class InvalidRequestError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

export class VaultDisabledError extends Error {
  constructor() {
    super("Saved credentials are not enabled");
    this.name = "VaultDisabledError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export const CreateTaskRequestSchema = z
  .object({
    goal: z.string().trim().min(1).max(10_000),
    completionCriteria: CriteriaSchema.optional(),
    limits: RequestedLimitsSchema.optional(),
    /** Names of saved logins this task starts signed in with. Nothing is loaded unless it is named here. */
    logins: z.array(z.string().min(1).max(64)).max(5).optional(),
    /** How Jev takes part in this task: "first" (Jev drives browser steps), "only" (Jev alone, no Claude call, needs completion criteria), "summary" (as "only", plus one Claude call that writes the final summary), "assist" (Jev picks plain links). Omitted = the server's default. */
    jevMode: z.enum(["first", "only", "summary", "assist"]).optional(),
    /** A finished document (title and Markdown body) for the agent to put into an editor with browser.paste_document. The text goes in exactly as written and never passes through a model. */
    document: z.object({ title: z.string().trim().min(1).max(300), markdown: z.string().trim().min(1).max(100_000) }).strict().optional(),
    /** "chrome": run in a new tab of the owner's own Chrome (admins only, when the server has it). Omitted = the default browser. */
    browser: z.enum(["sandbox", "chrome"]).optional(),
  })
  .strict();
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export const SaveLoginRequestSchema = z.object({ name: z.string().trim().min(1).max(64) }).strict();
export type SaveLoginRequest = z.infer<typeof SaveLoginRequestSchema>;

export const ContinueTaskRequestSchema = z
  .object({
    /** An extra instruction for the new attempt, e.g. "use the saved password this time". */
    note: z.string().trim().max(2000).optional(),
    limits: RequestedLimitsSchema.optional(),
    /** For a task that ended unverified (it had none): a phrase that must be on the final page, so this attempt can be checked. */
    mustShow: z.string().trim().min(2).max(200).optional(),
  })
  .strict();
export type ContinueTaskRequest = z.infer<typeof ContinueTaskRequestSchema>;

export interface TaskView {
  id: string;
  goal: string;
  status: Task["status"];
  /** Set when this task was started by continuing an earlier one. */
  parentTaskId: string | null;
  completionCriteria: unknown[];
  limits: unknown;
  /** Set while the agent is waiting for its owner: what it asked for. Otherwise null. */
  helpRequest: { reason: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalView {
  id: string;
  /** One-line description of the action, e.g. Click button “Subscribe”. */
  summary: string;
  taskId: string;
  tool: string;
  input: unknown;
  context: unknown;
  consequentialKind: string | null;
  createdAt: string;
  /** True when approving must come with a password typed into the approval card. */
  needsSecret: boolean;
  /** Screenshot of the page when the agent asked, if one was captured. */
  screenshotId: string | null;
}

export interface ArtifactView {
  id: string;
  kind: string;
  mime: string;
  label: string;
  sizeBytes: number;
  createdAt: string;
}

export interface TaskDetail extends TaskView {
  /** Tasks started by continuing this one. */
  continuations: Array<{ id: string; status: Task["status"]; createdAt: string }>;
  pendingApprovals: ApprovalView[];
  artifacts: ArtifactView[];
  /** Why the task ended (or last changed state): verified, partial, failed, cancelled, with reason. */
  lastTransition: Record<string, unknown> | null;
  /** When the owner marked an unverified result as looking right. Never changes the status. */
  acknowledgedAt: string | null;
}

const toTaskView = (t: Task): TaskView => ({
  id: t.id,
  goal: t.goal,
  status: t.status,
  parentTaskId: t.parentTaskId,
  completionCriteria: t.completionCriteria,
  limits: t.constraints.limits ?? null,
  helpRequest: null,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

export interface LoginView {
  name: string;
  /** The one site this login is for. */
  origin: string;
  cookieCount: number;
  savedAt: string;
  lastUsedAt: string | null;
}

const toLoginView = (m: LoginMeta): LoginView => ({
  name: m.name,
  origin: m.origin,
  cookieCount: m.cookieCount,
  savedAt: m.savedAt.toISOString(),
  lastUsedAt: m.lastUsedAt?.toISOString() ?? null,
});

const ASK_PASSWORD_TOOL = "browser.ask_password";

const toArtifactView = (a: ArtifactMeta): ArtifactView => ({
  id: a.id,
  kind: a.kind,
  mime: a.mime,
  label: a.label,
  sizeBytes: a.sizeBytes,
  createdAt: a.createdAt.toISOString(),
});

const toApprovalView = (a: Approval, screenshotId: string | null, t: Translator): ApprovalView => ({
  id: a.id,
  summary: describeCall(a.tool, a.input, (a.context as { target?: unknown } | null)?.target, t),
  taskId: a.taskId,
  tool: a.tool,
  input: a.input,
  context: a.context,
  consequentialKind: a.consequentialKind,
  createdAt: a.createdAt.toISOString(),
  needsSecret: a.tool === ASK_PASSWORD_TOOL,
  screenshotId,
});

export interface TaskServiceDeps {
  store: TaskStore;
  approvals: ApprovalStore;
  queue: RunQueue;
  limits: LimitPolicy;
  artifacts: ArtifactStore;
  /** Passwords entered with an approval, held until the approved action uses them. Needs the vault key. */
  oneTime?: OneTimeSecretStore;
  /** Where "save it for next time" stores a password. */
  vault?: SecretStore;
  /** Language of server-written text (history, summaries). Defaults to English. */
  t?: Translator;
  /** Interrupts an in-flight run in this process, if there is one. */
  abortRun: (taskId: string) => void;
  /** Per-user limits on how much one person can start. Without it nothing is limited (single-user setups). */
  quota?: QuotaService;
  /** Saved browser logins (needs the secrets key). Without it tasks cannot start signed in. */
  logins?: LoginStateStore;
  /** Lets a person watch and drive a task's browser. Without it the live view and takeover are unavailable. */
  human?: {
    /** The task's live browser, if this process holds one. */
    browser: (taskId: string) => unknown;
    isRunActive: (taskId: string) => boolean;
    /** Keeps the browser session from idling out while a person is using it. */
    touch: (taskId: string) => void;
  };
}

export const ReleaseControlRequestSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();
export type ReleaseControlRequest = z.infer<typeof ReleaseControlRequestSchema>;

/** Task states in which the live view may be shown (read-only except under human control). */
const LIVE_VIEW_STATES: ReadonlySet<Task["status"]> = new Set(["running", "awaiting_approval", "human_control"]);

interface ControlStats {
  startedAt: number;
  clicks: number;
  texts: number;
  keys: number;
  scrolls: number;
}

/**
 * What the HTTP layer calls. Every method takes the authenticated owner and treats tasks that
 * belong to someone else exactly like tasks that do not exist.
 */
export class TaskService {
  private readonly approvalService: ApprovalService;
  private readonly t: Translator;
  /** Counts only (never what was typed) for the history entry written when control is handed back. */
  private readonly control = new Map<string, ControlStats>();

  constructor(private readonly d: TaskServiceDeps) {
    this.approvalService = new ApprovalService(d.store, d.approvals);
    this.t = d.t ?? tEn;
  }

  async createTask(owner: string, input: CreateTaskRequest, opts: { schedule?: { id: string; name: string } } = {}): Promise<TaskView> {
    await this.d.quota?.check(owner);
    const logins = await this.checkLogins(owner, input.logins);
    // Jev alone never calls a model, so nothing could propose criteria for the verifier: the owner must give them,
    // or the goal must spell them out (a quoted phrase, see deriveGoalCriteria).
    if ((input.jevMode === "only" || input.jevMode === "summary") && !input.completionCriteria?.length && deriveGoalCriteria(input.goal).length === 0) {
      throw new InvalidRequestError("completionCriteria", "Jev-only mode calls no Claude model, so the task needs completion criteria of its own, or a goal with a phrase in quotes that must be on the final page.");
    }
    const limits = resolveLimits(input.limits, this.d.limits);
    const task = await this.d.store.createTask({
      owner,
      goal: input.goal,
      constraints: { limits, ...(logins.length ? { logins } : {}), ...(input.jevMode ? { jevMode: input.jevMode } : {}), ...(input.browser === "chrome" ? { browser: "chrome" } : {}), ...(input.document ? { document: input.document } : {}), ...(opts.schedule ? { scheduleId: opts.schedule.id } : {}) },
      completionCriteria: input.completionCriteria ?? [],
    });
    if (opts.schedule) await this.d.store.appendEvent(task.id, "task.scheduled", { scheduleId: opts.schedule.id, name: opts.schedule.name });
    // The task is persisted before it is queued: a lost enqueue leaves a visible queued task,
    // never a job without a task.
    await this.d.queue.enqueueRun(task.id);
    return toTaskView(task);
  }

  /**
   * Starts a new task that picks up where a failed or cancelled one stopped. The earlier task and
   * its history stay exactly as they were (a finished task never changes); the new one gets the
   * same goal and completion criteria, a summary of what was already done, the last page, an
   * optional note from the user, and a fresh budget. The new browser starts from the saved logins the
   * earlier task was started with (still on file), not from whatever the earlier browser held.
   */
  async continueTask(owner: string, id: string, input: ContinueTaskRequest, opts: { ownChrome?: boolean } = {}): Promise<TaskView> {
    const parent = await this.owned(owner, id);
    if (parent.status !== "failed" && parent.status !== "cancelled" && parent.status !== "unverified") {
      throw new ConflictError(`Only a failed, cancelled or unverified task can be continued (this one is ${parent.status})`);
    }
    if (input.mustShow && parent.completionCriteria.length > 0) {
      throw new InvalidRequestError("mustShow", "This task already has completion criteria; they are carried over unchanged.");
    }
    await this.d.quota?.check(owner);
    const carry = buildCarryOver(await this.d.store.listEvents(id));
    // Same limits as before unless the user asks for different ones; always clamped to the server maximum.
    const base = limitsForTask(parent.constraints, this.d.limits);
    const limits = input.limits ? resolveLimits(input.limits, { defaults: base, maximums: this.d.limits.maximums }) : base;
    // The same saved logins as before, unless one was deleted since: a missing one is dropped, not an error.
    const wanted = Array.isArray(parent.constraints.logins) ? (parent.constraints.logins as unknown[]).filter((n): n is string => typeof n === "string") : [];
    const still = this.d.logins ? await this.d.logins.existing(owner, wanted) : new Set<string>();
    const logins = wanted.filter((n) => still.has(n));
    const task = await this.d.store.createTask({
      owner,
      goal: parent.goal,
      constraints: {
        limits,
        ...(logins.length ? { logins } : {}),
        // Your own Chrome only continues in your own Chrome if the caller may still use it.
        ...(parent.constraints.browser === "chrome" && opts.ownChrome ? { browser: "chrome" } : {}),
        ...(parent.constraints.document ? { document: parent.constraints.document } : {}),
        ...(parent.constraints.jevMode === "first" || parent.constraints.jevMode === "only" || parent.constraints.jevMode === "summary" || parent.constraints.jevMode === "assist" ? { jevMode: parent.constraints.jevMode } : {}),
        carryOver: carry.summary,
        ...(carry.lastUrl ? { startUrl: carry.lastUrl } : {}),
        ...(input.note ? { userNote: input.note } : {}),
      },
      completionCriteria: input.mustShow ? [{ kind: "text_present", value: input.mustShow }] : parent.completionCriteria,
      parentTaskId: parent.id,
    });
    await this.d.store.appendEvent(task.id, "task.continued", { parentTaskId: parent.id });
    await this.d.queue.enqueueRun(task.id);
    return toTaskView(task);
  }

  async listTasks(owner: string, opts: { limit: number; before?: Date }): Promise<TaskView[]> {
    const tasks = await this.d.store.listTasks(owner, opts);
    return Promise.all(tasks.map((t) => this.withHelp(t, toTaskView(t))));
  }

  /** Fills in what the agent asked for, only for tasks currently waiting under human control. */
  private async withHelp<V extends TaskView>(task: Task, view: V): Promise<V> {
    if (task.status !== "human_control") return view;
    const events = await this.d.store.listEvents(task.id, { types: ["help.requested", "human.control_ended"] });
    const last = events.at(-1);
    return last?.type === "help.requested" ? { ...view, helpRequest: { reason: String(last.payload.reason ?? "") } } : view;
  }

  async getTask(owner: string, id: string): Promise<TaskDetail> {
    const task = await this.owned(owner, id);
    const [pending, last, files, attachments, children, acks] = await Promise.all([
      this.d.approvals.listPending(id),
      this.d.store.lastTransition(id),
      this.d.artifacts.list(id),
      this.d.store.listEvents(id, { types: ["artifact.created"] }),
      this.d.store.listContinuations(id),
      this.d.store.listEvents(id, { types: ["owner.acknowledged"] }),
    ]);
    return {
      ...(await this.withHelp(task, toTaskView(task))),
      continuations: children.map((c) => ({ id: c.id, status: c.status, createdAt: c.createdAt.toISOString() })),
      pendingApprovals: pending.map((a) => toApprovalView(a, screenshotFor(files, attachments, a.id), this.t)),
      artifacts: files.map(toArtifactView),
      lastTransition: last,
      acknowledgedAt: acks[0]?.createdAt.toISOString() ?? null,
    };
  }

  /**
   * The owner looked at an unverified result and says it looks right. Recorded as its own event once; the task stays
   * `unverified`, because `completed` always means verified.
   */
  async acknowledge(owner: string, id: string): Promise<TaskDetail> {
    const task = await this.owned(owner, id);
    if (task.status !== "unverified") throw new ConflictError(`Only an unverified task can be marked as looking right (this one is ${task.status})`);
    if ((await this.d.store.listEvents(id, { types: ["owner.acknowledged"] })).length === 0) {
      await this.d.store.appendEvent(id, "owner.acknowledged", { by: owner });
    }
    return this.getTask(owner, id);
  }

  async getEvents(owner: string, id: string, opts: { afterSeq: number; limit: number }): Promise<TaskEvent[]> {
    await this.owned(owner, id);
    return this.d.store.listEvents(id, opts);
  }

  /** Human-readable history plus cost and outcome, for dashboards. Same ownership rules as events. */
  async getTimeline(owner: string, id: string): Promise<TimelineResult> {
    await this.owned(owner, id);
    const [events, files] = await Promise.all([this.d.store.listEvents(id, { limit: 5000 }), this.d.artifacts.list(id)]);
    return buildTimeline(events, new Set(files.map((f) => f.id)), this.t);
  }

  async cancel(owner: string, id: string): Promise<TaskView> {
    await this.owned(owner, id);
    try {
      const task = await this.d.store.transition(id, "cancelled", { payload: { reason: "user_requested", cancelledBy: owner } });
      this.d.abortRun(id);
      return toTaskView(task);
    } catch (err) {
      if (err instanceof InvalidTransitionError) throw new ConflictError(`Task is already ${err.from}`);
      throw err;
    }
  }

  // ---- human control ----------------------------------------------------------------------

  /**
   * Pauses the agent and lets the owner drive the task's browser. Only a running task can be
   * taken over (reject or wait out a pending approval first): the agent is stopped before the
   * state changes, so a person and the agent never act on the page at the same time.
   */
  async takeControl(owner: string, id: string): Promise<TaskView> {
    const human = this.requireHuman();
    const task = await this.owned(owner, id);
    if (task.status === "human_control") return toTaskView(task);
    if (task.status !== "running") throw new ConflictError(`Only a running task can be taken over (this one is ${task.status})`);
    if (!human.browser(id)) throw new ConflictError("This task's browser is not available in this server process");

    this.d.abortRun(id);
    const deadline = Date.now() + 15_000;
    while (human.isRunActive(id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (human.isRunActive(id)) throw new ConflictError("The agent is still finishing a step; try again in a moment");
    try {
      const updated = await this.d.store.transition(id, "human_control", { payload: { reason: "human_takeover", by: owner } });
      this.control.set(id, { startedAt: Date.now(), clicks: 0, texts: 0, keys: 0, scrolls: 0 });
      void this.setBorder(id, false);
      // Start the idle timer now: if the person walks away without handing back, the browser is released.
      human.touch(id);
      return toTaskView(updated);
    } catch (err) {
      if (err instanceof InvalidTransitionError) throw new ConflictError(`The task changed while taking over (now ${err.from}); try again`);
      throw err;
    }
  }

  /** Hands the browser back: the agent continues from whatever page the person left. */
  async releaseControl(owner: string, id: string, req: ReleaseControlRequest = {}): Promise<TaskView> {
    this.requireHuman();
    const task = await this.owned(owner, id);
    if (task.status !== "human_control") throw new ConflictError(`Task is not under human control (it is ${task.status})`);
    const stats = this.control.get(id);
    this.control.delete(id);
    await this.d.store.appendEvent(id, "human.control_ended", {
      by: owner,
      durationMs: stats ? Date.now() - stats.startedAt : null,
      // Counts only. What was typed (possibly a password or a one-time code) is never recorded.
      inputs: stats ? { clicks: stats.clicks, texts: stats.texts, keys: stats.keys, scrolls: stats.scrolls } : null,
      ...(req.note ? { note: req.note } : {}),
    });
    let updated: Task;
    try {
      updated = await this.d.store.transition(id, "running", { payload: { reason: "human_released" } });
    } catch (err) {
      if (err instanceof InvalidTransitionError) throw new ConflictError(`Task is already ${err.from}`);
      throw err;
    }
    void this.setBorder(id, true);
    await this.d.queue.enqueueRun(id);
    return toTaskView(updated);
  }

  /** Cosmetic only: the page's "agent is working" border follows who is driving. */
  private async setBorder(id: string, on: boolean): Promise<void> {
    const b = this.d.human?.browser(id);
    if (isHumanControllable(b)) await b.setAgentDriving?.(on).catch(() => {});
  }

  /** A picture of the task's browser, for the live view. */
  async liveFrame(owner: string, id: string): Promise<LiveFrame> {
    const human = this.requireHuman();
    const task = await this.owned(owner, id);
    if (!LIVE_VIEW_STATES.has(task.status)) throw new ConflictError(`No live view for a ${task.status} task`);
    const browser = this.controllable(human.browser(id));
    human.touch(id);
    return browser.liveFrame();
  }

  /** Forwards one click, key press, text entry or scroll from the owner to the browser. Only while in control. */
  async humanInput(owner: string, id: string, input: HumanInput): Promise<void> {
    const human = this.requireHuman();
    const task = await this.owned(owner, id);
    if (task.status !== "human_control") throw new ConflictError("Take control of the task first");
    const browser = this.controllable(human.browser(id));
    human.touch(id);
    await browser.applyInput(input);
    // When the agent asked for help there was no takeover call: start counting at the first input.
    if (!this.control.has(id)) this.control.set(id, { startedAt: Date.now(), clicks: 0, texts: 0, keys: 0, scrolls: 0 });
    const stats = this.control.get(id);
    if (stats) {
      if (input.type === "click") stats.clicks++;
      else if (input.type === "text") stats.texts++;
      else if (input.type === "key") stats.keys++;
      else stats.scrolls++;
    }
  }

  private requireHuman(): NonNullable<TaskServiceDeps["human"]> {
    if (!this.d.human) throw new ConflictError("Live browser control is not enabled on this server");
    return this.d.human;
  }

  private controllable(browser: unknown): HumanControllable {
    if (!browser) throw new ConflictError("This task's browser is not available (the server restarted or it timed out)");
    if (!isHumanControllable(browser)) throw new ConflictError("This browser cannot be controlled by a person");
    return browser;
  }

  // ---- saved logins -----------------------------------------------------------------------

  /** The names a new task asked to start signed in with, checked against what this owner really saved. */
  async checkLogins(owner: string, names: readonly string[] | undefined): Promise<string[]> {
    const wanted = [...new Set(names ?? [])];
    if (wanted.length === 0) return [];
    if (!this.d.logins) throw new VaultDisabledError();
    const have = await this.d.logins.existing(owner, wanted);
    const missing = wanted.find((n) => !have.has(n));
    if (missing) throw new InvalidRequestError("logins", `You have no saved login named "${missing}"`);
    return wanted;
  }

  async listLogins(owner: string): Promise<LoginView[]> {
    if (!this.d.logins) throw new VaultDisabledError();
    return (await this.d.logins.list(owner)).map(toLoginView);
  }

  async deleteLogin(owner: string, name: string): Promise<void> {
    if (!this.d.logins) throw new VaultDisabledError();
    if (!(await this.d.logins.delete(owner, name))) throw new NotFoundError("Saved login not found");
  }

  /**
   * While the owner has the browser (they signed in by hand), keep that login for later tasks. Only the open
   * page's own site is saved. What is stored is never shown again; the history records the name, the site and
   * how many cookies, not their values.
   */
  async saveLogin(owner: string, taskId: string, input: SaveLoginRequest): Promise<LoginView> {
    const human = this.requireHuman();
    if (!this.d.logins) throw new VaultDisabledError();
    const task = await this.owned(owner, taskId);
    if (task.status !== "human_control") throw new ConflictError("Take control of the task and sign in first");
    const browser = this.controllable(human.browser(taskId));
    human.touch(taskId);
    let captured;
    try {
      captured = await browser.captureLoginState();
    } catch (err) {
      if (err instanceof LoginStateError) throw new InvalidRequestError("name", err.message);
      throw err;
    }
    let meta: LoginMeta;
    try {
      meta = await this.d.logins.put(owner, input.name, captured.origin, captured.state);
    } catch (err) {
      if (err instanceof LoginStateStoreError || err instanceof InvalidSecretError) throw new InvalidRequestError("name", err.message);
      throw err;
    }
    await this.d.store.appendEvent(taskId, "login.saved", { name: meta.name, origin: meta.origin, cookies: meta.cookieCount });
    return toLoginView(meta);
  }

  async listPendingApprovals(owner: string): Promise<ApprovalView[]> {
    const pending = await this.d.approvals.listPendingForOwner(owner);
    const perTask = new Map<string, { files: ArtifactMeta[]; attachments: TaskEvent[] }>();
    for (const taskId of new Set(pending.map((a) => a.taskId))) {
      perTask.set(taskId, {
        files: await this.d.artifacts.list(taskId),
        attachments: await this.d.store.listEvents(taskId, { types: ["artifact.created"] }),
      });
    }
    return pending.map((a) => {
      const t = perTask.get(a.taskId);
      return toApprovalView(a, t ? screenshotFor(t.files, t.attachments, a.id) : null, this.t);
    });
  }

  async listArtifacts(owner: string, taskId: string): Promise<ArtifactView[]> {
    await this.owned(owner, taskId);
    return (await this.d.artifacts.list(taskId)).map(toArtifactView);
  }

  /** The bytes of one artifact. Someone else's artifact is indistinguishable from a missing one. */
  async getArtifact(owner: string, artifactId: string): Promise<Artifact> {
    const art = await this.d.artifacts.get(artifactId);
    if (!art) throw new NotFoundError("Artifact not found");
    await this.owned(owner, art.taskId).catch(() => {
      throw new NotFoundError("Artifact not found");
    });
    return art;
  }

  async deleteArtifact(owner: string, artifactId: string): Promise<void> {
    const meta = await this.d.artifacts.getMeta(artifactId);
    if (!meta) throw new NotFoundError("Artifact not found");
    await this.owned(owner, meta.taskId).catch(() => {
      throw new NotFoundError("Artifact not found");
    });
    await this.d.artifacts.delete(artifactId);
    await this.d.store.appendEvent(meta.taskId, "artifact.deleted", { artifactId, kind: meta.kind, deletedBy: owner });
  }

  /**
   * Records a decision. A password request (browser.ask_password) can only be approved together
   * with the password typed into the approval card: it is held encrypted until the browser types
   * it, optionally also saved under a name for next time, and is never returned or logged.
   */
  async decideApproval(
    owner: string,
    approvalId: string,
    decision: "approved" | "rejected",
    extras: { secret?: string | undefined; saveAs?: string | undefined } = {},
  ): Promise<void> {
    let approval: Approval;
    try {
      approval = await this.d.approvals.get(approvalId);
    } catch (err) {
      if (err instanceof ApprovalNotFoundError) throw new NotFoundError("Approval not found");
      throw err;
    }
    // Someone else's approval looks exactly like a missing one.
    await this.owned(owner, approval.taskId).catch(() => {
      throw new NotFoundError("Approval not found");
    });

    const asksPassword = approval.tool === ASK_PASSWORD_TOOL;
    const withPassword = decision === "approved" && asksPassword;
    if (withPassword && !extras.secret) throw new InvalidRequestError("secret", "Enter the password to approve this request");
    if (!withPassword && (extras.secret || extras.saveAs)) {
      throw new InvalidRequestError("secret", "A password can only be sent when approving a password request");
    }

    let origin = "";
    if (withPassword) {
      if (!this.d.oneTime) throw new VaultDisabledError();
      // Refuse before storing anything: the password is only for the page the agent is on.
      origin = normalizeOrigin(String((approval.context as { target?: { pageOrigin?: unknown } } | null)?.target?.pageOrigin ?? ""));
      if (extras.saveAs) {
        validateName(extras.saveAs);
        if (!this.d.vault) throw new VaultDisabledError();
      }
    }

    try {
      if (withPassword && extras.secret) {
        if (extras.saveAs && this.d.vault) await this.d.vault.put(owner, { name: extras.saveAs, origin, value: extras.secret });
        await this.d.oneTime!.put(approvalId, { value: extras.secret, origin });
      }
      const taskId = await this.approvalService.decide(approvalId, decision, owner);
      await this.d.queue.enqueueRun(taskId);
    } catch (err) {
      if (withPassword) await this.d.oneTime?.delete(approvalId).catch(() => {}); // never leave a password behind after a failed decision
      if (err instanceof ApprovalNotFoundError || err instanceof NotAuthorizedError) throw new NotFoundError("Approval not found");
      if (err instanceof ApprovalNotPendingError) throw new ConflictError("Approval was already decided");
      throw err;
    }
  }

  private async owned(owner: string, id: string): Promise<Task> {
    try {
      const task = await this.d.store.getTask(id);
      if (task.owner !== owner) throw new NotFoundError("Task not found");
      return task;
    } catch (err) {
      if (err instanceof TaskNotFoundError) throw new NotFoundError("Task not found");
      throw err;
    }
  }
}
