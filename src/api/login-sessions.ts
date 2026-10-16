import { randomBytes } from "node:crypto";
import { hashToken } from "../runtime/config.js";

const CODE_TTL_MS = 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;
const MAX_CODES_PER_OWNER = 10;
const MAX_SESSIONS_PER_OWNER = 20;

interface Entry {
  owner: string;
  expiresAt: number;
}

/**
 * Lets something that already holds an API token (the menu bar app) open the dashboard without
 * the token ever appearing in a URL: it asks for a one-time code, the dashboard swaps the code for
 * a short-lived session token. Everything here is in memory only, so a server restart signs every
 * session out, and only hashes are kept.
 */
export class LoginSessions {
  private readonly codes = new Map<string, Entry>();
  private readonly sessions = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A single-use code, valid for a minute. */
  issueCode(owner: string): { code: string; expiresInSeconds: number } {
    this.sweep();
    const mine = [...this.codes.entries()].filter(([, e]) => e.owner === owner);
    if (mine.length >= MAX_CODES_PER_OWNER) this.codes.delete(mine[0]![0]); // drop the oldest
    const code = randomBytes(16).toString("hex");
    this.codes.set(hashToken(code), { owner, expiresAt: this.now() + CODE_TTL_MS });
    return { code, expiresInSeconds: CODE_TTL_MS / 1000 };
  }

  /** Spends a code. Returns a session token once, or null if the code is unknown, used, or expired. */
  redeem(code: string): { token: string; owner: string } | null {
    this.sweep();
    const key = hashToken(code);
    const entry = this.codes.get(key);
    if (!entry) return null;
    this.codes.delete(key); // single use, even if something below fails
    const token = `cbs_${randomBytes(32).toString("hex")}`;
    const mine = [...this.sessions.entries()].filter(([, e]) => e.owner === entry.owner);
    if (mine.length >= MAX_SESSIONS_PER_OWNER) this.sessions.delete(mine[0]![0]);
    this.sessions.set(hashToken(token), { owner: entry.owner, expiresAt: this.now() + SESSION_TTL_MS });
    return { token, owner: entry.owner };
  }

  ownerOf(token: string): string | undefined {
    const key = hashToken(token);
    const entry = this.sessions.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.sessions.delete(key);
      return undefined;
    }
    return entry.owner;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, e] of this.codes) if (e.expiresAt <= t) this.codes.delete(k);
    for (const [k, e] of this.sessions) if (e.expiresAt <= t) this.sessions.delete(k);
  }
}
