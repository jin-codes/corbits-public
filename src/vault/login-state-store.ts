import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { StorageStateSchema, type StorageState } from "../execution/login-state.js";
import { decrypt, encrypt } from "./crypto.js";
import { validateName } from "./secret-store.js";

export const MAX_LOGINS_PER_OWNER = 20;
const MAX_STATE_BYTES = 256 * 1024;

export class LoginStateStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginStateStoreError";
  }
}

export interface LoginMeta {
  name: string;
  origin: string;
  cookieCount: number;
  savedAt: Date;
  lastUsedAt: Date | null;
}

interface Row {
  name: string;
  origin: string;
  cookie_count: number;
  updated_at: Date;
  last_used_at: Date | null;
}
const toMeta = (r: Row): LoginMeta => ({ name: r.name, origin: r.origin, cookieCount: r.cookie_count, savedAt: r.updated_at, lastUsedAt: r.last_used_at });
const aad = (owner: string, name: string, origin: string) => `${owner}|${name}|${origin}|login-state`;

/**
 * Saved browser logins, one per (owner, name) and one site each. Encrypted with the server's secrets key and
 * authenticated with the owner, name and site, so a row cannot be moved to another person or another site.
 * Write-only: the API lists names and sites; only a task's own browser ever receives the state.
 */
export class LoginStateStore {
  constructor(
    private readonly pool: Pool,
    private readonly key: Buffer,
  ) {}

  async put(owner: string, name: string, origin: string, state: StorageState): Promise<LoginMeta> {
    validateName(name);
    const checked = StorageStateSchema.parse(state);
    if (checked.cookies.length === 0 && checked.origins.every((o) => o.localStorage.length === 0)) {
      throw new LoginStateStoreError("There is nothing to save: this site has no login in the browser yet");
    }
    const json = JSON.stringify(checked);
    if (Buffer.byteLength(json) > MAX_STATE_BYTES) throw new LoginStateStoreError("That login is too large to save");
    const existing = await this.pool.query("SELECT 1 FROM login_states WHERE owner = $1 AND name = $2", [owner, name]);
    if (existing.rowCount === 0) {
      const { rows } = await this.pool.query<{ n: string }>("SELECT count(*) AS n FROM login_states WHERE owner = $1", [owner]);
      if (Number(rows[0]!.n) >= MAX_LOGINS_PER_OWNER) throw new LoginStateStoreError(`You can keep at most ${MAX_LOGINS_PER_OWNER} saved logins`);
    }
    const { iv, data } = encrypt(this.key, json, aad(owner, name, origin));
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO login_states (id, owner, name, origin, iv, ciphertext, cookie_count) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (owner, name) DO UPDATE SET origin = EXCLUDED.origin, iv = EXCLUDED.iv, ciphertext = EXCLUDED.ciphertext,
         cookie_count = EXCLUDED.cookie_count, updated_at = now(), last_used_at = NULL
       RETURNING name, origin, cookie_count, updated_at, last_used_at`,
      [randomUUID(), owner, name, origin, iv, data, checked.cookies.length],
    );
    return toMeta(rows[0]!);
  }

  async list(owner: string): Promise<LoginMeta[]> {
    const { rows } = await this.pool.query<Row>("SELECT name, origin, cookie_count, updated_at, last_used_at FROM login_states WHERE owner = $1 ORDER BY name", [owner]);
    return rows.map(toMeta);
  }

  /** Which of these names exist for this owner. */
  async existing(owner: string, names: readonly string[]): Promise<Set<string>> {
    if (names.length === 0) return new Set();
    const { rows } = await this.pool.query<{ name: string }>("SELECT name FROM login_states WHERE owner = $1 AND name = ANY($2)", [owner, [...names]]);
    return new Set(rows.map((r) => r.name));
  }

  /** The states for a task's browser. Anything missing is skipped; a row that fails authentication is an error. */
  async reveal(owner: string, names: readonly string[]): Promise<Array<{ meta: LoginMeta; state: StorageState }>> {
    if (names.length === 0) return [];
    const { rows } = await this.pool.query<Row & { iv: Buffer; ciphertext: Buffer }>(
      "SELECT name, origin, cookie_count, updated_at, last_used_at, iv, ciphertext FROM login_states WHERE owner = $1 AND name = ANY($2) ORDER BY name",
      [owner, [...names]],
    );
    const out = rows.map((r) => ({
      meta: toMeta(r),
      // A tampered row, or one moved to another owner, name or site, fails here.
      state: z.object({}).passthrough().pipe(StorageStateSchema).parse(JSON.parse(decrypt(this.key, r.iv, r.ciphertext, aad(owner, r.name, r.origin)))),
    }));
    await this.pool.query("UPDATE login_states SET last_used_at = now() WHERE owner = $1 AND name = ANY($2)", [owner, [...names]]);
    return out;
  }

  async delete(owner: string, name: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("DELETE FROM login_states WHERE owner = $1 AND name = $2", [owner, name]);
    return (rowCount ?? 0) > 0;
  }
}
