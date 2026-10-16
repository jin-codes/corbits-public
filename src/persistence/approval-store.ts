import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ApprovalRecord } from "../policy/policy-engine.js";
import { defaultRedactor, type Redactor } from "../security/redact.js";

export interface Approval {
  id: string;
  taskId: string;
  tool: string;
  input: unknown;
  /** Where and on what the action would run (page URL, resolved element), shown to the approver. */
  context: unknown;
  actionFingerprint: string;
  effectFingerprint: string;
  consequentialKind: string | null;
  status: "pending" | "approved" | "rejected";
  consumedAt: Date | null;
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
}

export class ApprovalNotFoundError extends Error {
  constructor(readonly approvalId: string) {
    super(`Approval not found: ${approvalId}`);
    this.name = "ApprovalNotFoundError";
  }
}

export class ApprovalNotPendingError extends Error {
  constructor(readonly approvalId: string) {
    super(`Approval already decided: ${approvalId}`);
    this.name = "ApprovalNotPendingError";
  }
}

export interface ApprovalRequest {
  tool: string;
  input: unknown;
  context?: unknown;
  actionFingerprint: string;
  effectFingerprint: string;
  consequentialKind?: string | undefined;
}

interface Row {
  id: string;
  task_id: string;
  tool: string;
  input: unknown;
  context: unknown;
  action_fingerprint: string;
  effect_fingerprint: string;
  consequential_kind: string | null;
  status: Approval["status"];
  consumed_at: Date | null;
  created_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
}

const toApproval = (r: Row): Approval => ({
  id: r.id,
  taskId: r.task_id,
  tool: r.tool,
  input: r.input,
  context: r.context,
  actionFingerprint: r.action_fingerprint,
  effectFingerprint: r.effect_fingerprint,
  consequentialKind: r.consequential_kind,
  status: r.status,
  consumedAt: r.consumed_at,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  decidedBy: r.decided_by,
});

export class ApprovalStore {
  constructor(
    private readonly pool: Pool,
    private readonly redactor: Redactor = defaultRedactor,
  ) {}

  /** Creates a pending approval, or returns the existing pending one for the same exact action. */
  async request(taskId: string, req: ApprovalRequest): Promise<{ approval: Approval; created: boolean }> {
    const inserted = await this.pool.query<Row>(
      `INSERT INTO approvals (id, task_id, tool, input, context, action_fingerprint, effect_fingerprint, consequential_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (task_id, action_fingerprint) WHERE status = 'pending' DO NOTHING
       RETURNING *`,
      [
        randomUUID(),
        taskId,
        req.tool,
        JSON.stringify(this.redactor.redact(req.input)),
        JSON.stringify(this.redactor.redact(req.context ?? null)),
        req.actionFingerprint,
        req.effectFingerprint,
        req.consequentialKind ?? null,
      ],
    );
    if (inserted.rows[0]) return { approval: toApproval(inserted.rows[0]), created: true };
    const existing = await this.pool.query<Row>(
      "SELECT * FROM approvals WHERE task_id = $1 AND action_fingerprint = $2 AND status = 'pending'",
      [taskId, req.actionFingerprint],
    );
    return { approval: toApproval(existing.rows[0]!), created: false };
  }

  async get(id: string): Promise<Approval> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM approvals WHERE id = $1", [id]);
    if (!rows[0]) throw new ApprovalNotFoundError(id);
    return toApproval(rows[0]);
  }

  /** Records a decision. Only a pending approval can be decided, and only once. */
  async decide(id: string, decision: "approved" | "rejected", decidedBy: string): Promise<Approval> {
    const { rows } = await this.pool.query<Row>(
      `UPDATE approvals SET status = $2, decided_at = now(), decided_by = $3
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, decision, decidedBy],
    );
    if (rows[0]) return toApproval(rows[0]);
    await this.get(id); // throws ApprovalNotFoundError if it does not exist
    throw new ApprovalNotPendingError(id);
  }

  /** Atomically marks an approved approval as used. Returns false if it was already used. */
  async consume(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "UPDATE approvals SET consumed_at = now() WHERE id = $1 AND status = 'approved' AND consumed_at IS NULL",
      [id],
    );
    return rowCount === 1;
  }

  /** The oldest approval the user granted that has not been carried out yet. */
  async nextApprovedUnused(taskId: string): Promise<Approval | null> {
    const { rows } = await this.pool.query<Row>(
      "SELECT * FROM approvals WHERE task_id = $1 AND status = 'approved' AND consumed_at IS NULL ORDER BY decided_at, created_at LIMIT 1",
      [taskId],
    );
    return rows[0] ? toApproval(rows[0]) : null;
  }

  async listPending(taskId: string): Promise<Approval[]> {
    const { rows } = await this.pool.query<Row>(
      "SELECT * FROM approvals WHERE task_id = $1 AND status = 'pending' ORDER BY created_at",
      [taskId],
    );
    return rows.map(toApproval);
  }

  /** Pending approvals across all of an owner's tasks, oldest first. */
  async listPendingForOwner(owner: string): Promise<Approval[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT a.* FROM approvals a JOIN tasks t ON t.id = a.task_id
       WHERE t.owner = $1 AND a.status = 'pending' ORDER BY a.created_at`,
      [owner],
    );
    return rows.map(toApproval);
  }

  /** Decided approvals in the shape the policy engine consumes. */
  async policyRecords(taskId: string): Promise<ApprovalRecord[]> {
    const { rows } = await this.pool.query<Row>(
      "SELECT * FROM approvals WHERE task_id = $1 AND status <> 'pending'",
      [taskId],
    );
    return rows.map((r) => ({
      id: r.id,
      actionFingerprint: r.action_fingerprint,
      effectFingerprint: r.effect_fingerprint,
      decision: r.status as "approved" | "rejected",
      consumed: r.consumed_at !== null,
    }));
  }
}
