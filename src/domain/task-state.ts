export const TASK_STATES = [
  "queued",
  "planning",
  "running",
  "awaiting_approval",
  "human_control",
  "verifying",
  "completed",
  "unverified",
  "failed",
  "cancelled",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/**
 * Legal transitions. Anything not listed here is rejected.
 * - queued -> failed covers infrastructure failures before planning starts (e.g. the worker cannot run the job).
 * - running -> running is not allowed; recovery after failed verification goes verifying -> running.
 * - human_control: a person drives the browser directly; the agent is paused. Entered only from running
 *   (the person asks for it), left by handing back (-> running), failing, or cancelling.
 * - verifying -> unverified: the task had no completion criteria, so nothing could be checked. `completed` always
 *   means verified; this is the separate, honest end for work whose result is unknown.
 * - awaiting_approval -> running covers both approve and reject; a rejected action is
 *   recorded as an event and must not be executed (enforced by the policy engine).
 */
const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  queued: ["planning", "failed", "cancelled"],
  planning: ["running", "failed", "cancelled"],
  running: ["awaiting_approval", "human_control", "verifying", "failed", "cancelled"],
  awaiting_approval: ["running", "failed", "cancelled"],
  human_control: ["running", "failed", "cancelled"],
  verifying: ["completed", "unverified", "running", "failed", "cancelled"],
  completed: [],
  unverified: [],
  failed: [],
  cancelled: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`Invalid task state transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === "string" && (TASK_STATES as readonly string[]).includes(value);
}

export function isTerminal(state: TaskState): boolean {
  return TRANSITIONS[state].length === 0;
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
