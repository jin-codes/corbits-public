import { InvalidTransitionError } from "../domain/task-state.js";
import type { ApprovalStore } from "../persistence/approval-store.js";
import { StaleStateError, type TaskStore } from "../persistence/task-store.js";

export class NotAuthorizedError extends Error {
  constructor() {
    super("Only the task owner can decide approvals");
    this.name = "NotAuthorizedError";
  }
}

/**
 * Records approval decisions and unpauses the task. It never executes anything itself:
 * the orchestrator re-evaluates the action under the policy engine when the task resumes.
 */
export class ApprovalService {
  constructor(
    private readonly store: TaskStore,
    private readonly approvals: ApprovalStore,
  ) {}

  /** Returns the task id so the caller can schedule a run. */
  async decide(approvalId: string, decision: "approved" | "rejected", decidedBy: string): Promise<string> {
    const approval = await this.approvals.get(approvalId);
    const task = await this.store.getTask(approval.taskId);
    if (task.owner !== decidedBy) throw new NotAuthorizedError();
    await this.approvals.decide(approvalId, decision, decidedBy);
    await this.store.appendEvent(task.id, "approval.decided", {
      approvalId,
      decision,
      decidedBy,
      tool: approval.tool,
      input: approval.input,
      target: (approval.context as { target?: unknown } | null)?.target ?? null,
    });
    if ((await this.approvals.listPending(task.id)).length === 0) {
      try {
        await this.store.transition(task.id, "running", {
          expectedFrom: "awaiting_approval",
          payload: { reason: "approvals_decided" },
        });
      } catch (err) {
        // Cancelled or already resumed in the meantime: nothing to do.
        if (!(err instanceof StaleStateError || err instanceof InvalidTransitionError)) throw err;
      }
    }
    return task.id;
  }
}
