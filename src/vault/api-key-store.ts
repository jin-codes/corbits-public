import type { Pool } from "pg";
import { decrypt, encrypt } from "./crypto.js";

/** Anthropic keys look like sk-ant-...; anything else is refused before it is stored or sent anywhere. */
const FORMAT = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;

export class InvalidApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidApiKeyError";
  }
}

export interface ApiKeyStatus {
  saved: boolean;
  /** The last four characters, or null when nothing is saved. Never the key. */
  hint: string | null;
  lastUsedAt: Date | null;
}

const aad = (owner: string) => `${owner}|anthropic-api-key`;

/**
 * Each person's own Anthropic API key, so their tasks run on, and are billed to, their own account. Encrypted
 * with the server's secrets key and bound to the owner (a stored key cannot be moved to someone else).
 * Write-only: nothing here or in the API returns it except to the model adapter that makes their calls.
 */
export class ApiKeyStore {
  constructor(
    private readonly pool: Pool,
    private readonly key: Buffer,
  ) {}

  static check(apiKey: string): string {
    const k = apiKey.trim();
    if (!FORMAT.test(k)) throw new InvalidApiKeyError("That does not look like an Anthropic API key (it starts with sk-ant-)");
    return k;
  }

  async put(owner: string, apiKey: string): Promise<ApiKeyStatus> {
    const k = ApiKeyStore.check(apiKey);
    const { iv, data } = encrypt(this.key, k, aad(owner));
    await this.pool.query(
      `INSERT INTO user_api_keys (owner, iv, ciphertext, hint) VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner) DO UPDATE SET iv = EXCLUDED.iv, ciphertext = EXCLUDED.ciphertext, hint = EXCLUDED.hint, created_at = now(), last_used_at = NULL`,
      [owner, iv, data, k.slice(-4)],
    );
    return this.status(owner);
  }

  async status(owner: string): Promise<ApiKeyStatus> {
    const { rows } = await this.pool.query<{ hint: string; last_used_at: Date | null }>("SELECT hint, last_used_at FROM user_api_keys WHERE owner = $1", [owner]);
    return rows[0] ? { saved: true, hint: rows[0].hint, lastUsedAt: rows[0].last_used_at } : { saved: false, hint: null, lastUsedAt: null };
  }

  async has(owner: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("SELECT 1 FROM user_api_keys WHERE owner = $1", [owner]);
    return (rowCount ?? 0) > 0;
  }

  /** For the model adapter that runs this person's tasks. Fails if the row was tampered with or moved. */
  async reveal(owner: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ iv: Buffer; ciphertext: Buffer }>("SELECT iv, ciphertext FROM user_api_keys WHERE owner = $1", [owner]);
    const r = rows[0];
    if (!r) return null;
    const value = decrypt(this.key, r.iv, r.ciphertext, aad(owner));
    await this.pool.query("UPDATE user_api_keys SET last_used_at = now() WHERE owner = $1", [owner]);
    return value;
  }

  async delete(owner: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("DELETE FROM user_api_keys WHERE owner = $1", [owner]);
    return (rowCount ?? 0) > 0;
  }
}
