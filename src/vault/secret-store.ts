import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { decrypt, encrypt } from "./crypto.js";

export interface SecretMeta {
  name: string;
  origin: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
}

/** What the agent's tool is allowed to ask of the vault: who it is for and which site, never a listing of values. */
export interface VaultReader {
  list(owner: string): Promise<SecretMeta[]>;
  meta(owner: string, name: string): Promise<SecretMeta | null>;
  /** Decrypts one value. Only for the moment of typing it into a page; never store or return the result. */
  reveal(owner: string, name: string): Promise<{ origin: string; value: string } | null>;
}

export class InvalidSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSecretError";
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const MAX_SECRET_CHARS = 1024;

export function validateName(name: string): string {
  if (!NAME_RE.test(name)) throw new InvalidSecretError("name must be 1-64 characters: lowercase letters, digits, - and _");
  return name;
}

/**
 * The only site a secret may be typed into. https only (plain http just for loopback, so local
 * development works); no credentials or paths in the address; stored as scheme://host[:port].
 */
export function normalizeOrigin(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new InvalidSecretError("site must be a full address such as https://example.com");
  }
  if (u.username || u.password) throw new InvalidSecretError("site must not contain a username or password");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {
    throw new InvalidSecretError("site must use https (http is only allowed for localhost)");
  }
  return u.origin;
}

interface Row {
  name: string;
  origin: string;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
}
const toMeta = (r: Row): SecretMeta => ({ name: r.name, origin: r.origin, createdAt: r.created_at, updatedAt: r.updated_at, lastUsedAt: r.last_used_at });
const aad = (owner: string, name: string, origin: string) => `${owner}\n${name}\n${origin}`;

export class SecretStore implements VaultReader {
  constructor(
    private readonly pool: Pool,
    private readonly key: Buffer,
  ) {}

  /** Creates or replaces a secret. The value is write-only: nothing here or in the API ever returns it. */
  async put(owner: string, input: { name: string; origin: string; value: string }): Promise<SecretMeta> {
    const name = validateName(input.name);
    const origin = normalizeOrigin(input.origin);
    if (input.value.length === 0 || input.value.length > MAX_SECRET_CHARS) throw new InvalidSecretError(`value must be 1-${MAX_SECRET_CHARS} characters`);
    const { iv, data } = encrypt(this.key, input.value, aad(owner, name, origin));
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO secrets (id, owner, name, origin, iv, ciphertext) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (owner, name) DO UPDATE SET origin = EXCLUDED.origin, iv = EXCLUDED.iv, ciphertext = EXCLUDED.ciphertext, updated_at = now()
       RETURNING name, origin, created_at, updated_at, last_used_at`,
      [randomUUID(), owner, name, origin, iv, data],
    );
    return toMeta(rows[0]!);
  }

  async list(owner: string): Promise<SecretMeta[]> {
    const { rows } = await this.pool.query<Row>("SELECT name, origin, created_at, updated_at, last_used_at FROM secrets WHERE owner = $1 ORDER BY name", [owner]);
    return rows.map(toMeta);
  }

  async meta(owner: string, name: string): Promise<SecretMeta | null> {
    const { rows } = await this.pool.query<Row>("SELECT name, origin, created_at, updated_at, last_used_at FROM secrets WHERE owner = $1 AND name = $2", [owner, name]);
    return rows[0] ? toMeta(rows[0]) : null;
  }

  async reveal(owner: string, name: string): Promise<{ origin: string; value: string } | null> {
    const { rows } = await this.pool.query<Row & { iv: Buffer; ciphertext: Buffer }>(
      "SELECT name, origin, iv, ciphertext, created_at, updated_at, last_used_at FROM secrets WHERE owner = $1 AND name = $2",
      [owner, name],
    );
    const r = rows[0];
    if (!r) return null;
    // A row that was tampered with, or moved to another owner/name/site, fails authentication here.
    const value = decrypt(this.key, r.iv, r.ciphertext, aad(owner, r.name, r.origin));
    await this.pool.query("UPDATE secrets SET last_used_at = now() WHERE owner = $1 AND name = $2", [owner, name]);
    return { origin: r.origin, value };
  }

  async delete(owner: string, name: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("DELETE FROM secrets WHERE owner = $1 AND name = $2", [owner, name]);
    return rowCount === 1;
  }
}
