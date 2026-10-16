import type { Pool } from "pg";
import { decrypt, encrypt } from "./crypto.js";

/** What the approved action needs to type: the value, and the site it was entered for. */
export interface OneTimeSecret {
  value: string;
  origin: string;
}

/** Read side, for the tool that types the password. */
export interface OneTimeTaker {
  /** Returns the value once and deletes it in the same statement. A second call returns null. */
  take(approvalId: string): Promise<OneTimeSecret | null>;
}

const aad = (approvalId: string, origin: string) => `approval:${approvalId}\n${origin}`;

/**
 * Passwords entered while approving. They are encrypted with the vault key, bound to the approval
 * and the site, and removed as soon as they are used. Nothing here is ever returned by an API.
 */
export class OneTimeSecretStore implements OneTimeTaker {
  constructor(
    private readonly pool: Pool,
    private readonly key: Buffer,
  ) {}

  async put(approvalId: string, secret: OneTimeSecret): Promise<void> {
    const { iv, data } = encrypt(this.key, secret.value, aad(approvalId, secret.origin));
    await this.pool.query(
      `INSERT INTO approval_secrets (approval_id, origin, iv, ciphertext) VALUES ($1,$2,$3,$4)
       ON CONFLICT (approval_id) DO UPDATE SET origin = EXCLUDED.origin, iv = EXCLUDED.iv, ciphertext = EXCLUDED.ciphertext, created_at = now()`,
      [approvalId, secret.origin, iv, data],
    );
  }

  async take(approvalId: string): Promise<OneTimeSecret | null> {
    const { rows } = await this.pool.query<{ origin: string; iv: Buffer; ciphertext: Buffer }>(
      "DELETE FROM approval_secrets WHERE approval_id = $1 RETURNING origin, iv, ciphertext",
      [approvalId],
    );
    const r = rows[0];
    if (!r) return null;
    return { origin: r.origin, value: decrypt(this.key, r.iv, r.ciphertext, aad(approvalId, r.origin)) };
  }

  async delete(approvalId: string): Promise<void> {
    await this.pool.query("DELETE FROM approval_secrets WHERE approval_id = $1", [approvalId]);
  }

  /** Removes passwords that were entered but never used (the task moved on, was cancelled, or failed). */
  async purgeOlderThan(cutoff: Date): Promise<number> {
    const { rowCount } = await this.pool.query("DELETE FROM approval_secrets WHERE created_at < $1", [cutoff]);
    return rowCount ?? 0;
  }
}
