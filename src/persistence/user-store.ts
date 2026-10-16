import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { hashToken } from "../runtime/config.js";

export const OwnerName = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,31}$/, "use 2-32 lowercase letters, digits, - or _");

export const NewUserSchema = z
  .object({
    name: OwnerName,
    displayName: z.string().trim().max(80).optional(),
    email: z.email().max(200).optional(),
    role: z.enum(["admin", "user"]).optional(),
    maxConcurrent: z.number().int().min(1).max(50).nullable().optional(),
    dailySpendUsd: z.number().min(0).max(1000).nullable().optional(),
  })
  .strict();
export type NewUser = z.infer<typeof NewUserSchema>;

export const UserPatchSchema = z
  .object({
    displayName: z.string().trim().max(80).optional(),
    email: z.email().max(200).nullable().optional(),
    role: z.enum(["admin", "user"]).optional(),
    disabled: z.boolean().optional(),
    maxConcurrent: z.number().int().min(1).max(50).nullable().optional(),
    dailySpendUsd: z.number().min(0).max(1000).nullable().optional(),
  })
  .strict();
export type UserPatch = z.infer<typeof UserPatchSchema>;

export interface User {
  owner: string;
  displayName: string;
  email: string | null;
  role: "admin" | "user";
  disabled: boolean;
  maxConcurrent: number | null;
  dailySpendUsd: number | null;
  createdAt: Date;
  lastSeenAt: Date | null;
}

interface Row {
  owner: string;
  display_name: string;
  email: string | null;
  role: "admin" | "user";
  disabled: boolean;
  max_concurrent: number | null;
  daily_spend_usd: string | null;
  created_at: Date;
  last_seen_at: Date | null;
}
const COLUMNS = "owner, display_name, email, role, disabled, max_concurrent, daily_spend_usd, created_at, last_seen_at";
const toUser = (r: Row): User => ({
  owner: r.owner,
  displayName: r.display_name,
  email: r.email,
  role: r.role,
  disabled: r.disabled,
  maxConcurrent: r.max_concurrent,
  dailySpendUsd: r.daily_spend_usd === null ? null : Number(r.daily_spend_usd),
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
});

export class OwnerTakenError extends Error {
  constructor(readonly owner: string) {
    super(`The name "${owner}" is already taken`);
    this.name = "OwnerTakenError";
  }
}
export class UserNotFoundError extends Error {
  constructor(readonly owner: string) {
    super(`No such user: ${owner}`);
    this.name = "UserNotFoundError";
  }
}

/** A new token: long, random, and recognizable. Only its hash is kept, so it can be shown exactly once. */
const newToken = () => `cbu_${randomBytes(32).toString("hex")}`;

export class UserStore {
  /** `reserved` are owner names that exist outside this table (the tokens in .env). */
  constructor(
    private readonly pool: Pool,
    private readonly reserved: ReadonlySet<string> = new Set(),
  ) {}

  async create(input: NewUser): Promise<{ user: User; token: string }> {
    const v = NewUserSchema.parse(input);
    if (this.reserved.has(v.name)) throw new OwnerTakenError(v.name);
    const token = newToken();
    try {
      const { rows } = await this.pool.query<Row>(
        `INSERT INTO users (owner, display_name, email, role, token_hash, max_concurrent, daily_spend_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
        [v.name, v.displayName ?? "", v.email ?? null, v.role ?? "user", hashToken(token), v.maxConcurrent ?? null, v.dailySpendUsd ?? null],
      );
      return { user: toUser(rows[0]!), token };
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new OwnerTakenError(v.name);
      throw err;
    }
  }

  async list(): Promise<User[]> {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM users ORDER BY created_at`);
    return rows.map(toUser);
  }

  async get(owner: string): Promise<User | undefined> {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM users WHERE owner = $1`, [owner]);
    return rows[0] ? toUser(rows[0]) : undefined;
  }

  /** The user a token belongs to, whether or not they are disabled (the caller decides what that means). */
  async findByToken(token: string): Promise<User | undefined> {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM users WHERE token_hash = $1`, [hashToken(token)]);
    return rows[0] ? toUser(rows[0]) : undefined;
  }

  async update(owner: string, patch: UserPatch): Promise<User> {
    const p = UserPatchSchema.parse(patch);
    const sets: string[] = [];
    const values: unknown[] = [owner];
    const add = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (p.displayName !== undefined) add("display_name", p.displayName);
    if (p.email !== undefined) add("email", p.email);
    if (p.role !== undefined) add("role", p.role);
    if (p.disabled !== undefined) add("disabled", p.disabled);
    if (p.maxConcurrent !== undefined) add("max_concurrent", p.maxConcurrent);
    if (p.dailySpendUsd !== undefined) add("daily_spend_usd", p.dailySpendUsd);
    if (sets.length === 0) {
      const u = await this.get(owner);
      if (!u) throw new UserNotFoundError(owner);
      return u;
    }
    const { rows } = await this.pool.query<Row>(`UPDATE users SET ${sets.join(", ")} WHERE owner = $1 RETURNING ${COLUMNS}`, values);
    if (!rows[0]) throw new UserNotFoundError(owner);
    return toUser(rows[0]);
  }

  /** Replaces the user's token; the old one stops working at once. */
  async rotateToken(owner: string): Promise<string> {
    const token = newToken();
    const { rowCount } = await this.pool.query("UPDATE users SET token_hash = $2, token_rotated_at = now() WHERE owner = $1", [owner, hashToken(token)]);
    if (!rowCount) throw new UserNotFoundError(owner);
    return token;
  }

  async touch(owner: string): Promise<void> {
    await this.pool.query("UPDATE users SET last_seen_at = now() WHERE owner = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')", [owner]);
  }
}
