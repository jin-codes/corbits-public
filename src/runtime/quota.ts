import type { Pool } from "pg";
import { tEn, type Translator } from "../i18n/messages.js";

export interface QuotaDefaults {
  maxConcurrent: number;
  dailySpendUsd: number;
  maxTasksPerHour: number;
}

export type QuotaReason = "too_many_active" | "daily_spend" | "too_many_recent";

export class QuotaExceededError extends Error {
  constructor(
    readonly reason: QuotaReason,
    message: string,
  ) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

const ACTIVE = ["queued", "planning", "running", "awaiting_approval", "human_control", "verifying"];

export interface Allowance {
  maxConcurrent: number | null;
  dailySpendUsd: number | null;
  /** They run on their own API key, so the spend is theirs: no daily spend limit applies. */
  ownKey?: boolean;
}

export interface Usage {
  activeTasks: number;
  spendTodayUsd: number;
  tasksLastHour: number;
}

/**
 * Keeps one user from using up everyone's share: how many tasks at once, how much model spend per day
 * (estimated; Jev steps count as zero because its price is not published), and how many tasks per hour.
 * Counted from what is already stored, so it survives restarts. Admins are not limited.
 */
export class QuotaService {
  constructor(
    private readonly pool: Pool,
    private readonly defaults: QuotaDefaults,
    /** Per-user overrides and the admin test, looked up when needed. */
    private readonly allowanceFor: (owner: string) => Promise<(Allowance & { unlimited: boolean }) | undefined>,
    /** Language of the messages shown to the user. */
    private readonly t: Translator = tEn,
  ) {}

  /** The limits that apply to this owner right now (null when they have none). */
  async limitsFor(owner: string): Promise<{ maxConcurrent: number; dailySpendUsd: number | null; maxTasksPerHour: number } | null> {
    const a = await this.allowanceFor(owner);
    if (a?.unlimited) return null;
    return {
      maxConcurrent: a?.maxConcurrent ?? this.defaults.maxConcurrent,
      dailySpendUsd: a?.ownKey ? null : (a?.dailySpendUsd ?? this.defaults.dailySpendUsd),
      maxTasksPerHour: this.defaults.maxTasksPerHour,
    };
  }

  async usage(owner: string): Promise<Usage> {
    const [active, spend, recent] = await Promise.all([
      this.pool.query<{ n: string }>("SELECT count(*) AS n FROM tasks WHERE owner = $1 AND status = ANY($2)", [owner, ACTIVE]),
      this.pool.query<{ total: string }>(
        `SELECT COALESCE(SUM((e.payload->>'costUsd')::numeric), 0) AS total
           FROM task_events e JOIN tasks t ON t.id = e.task_id
          WHERE t.owner = $1 AND e.type = 'model.usage' AND e.created_at >= date_trunc('day', now())`,
        [owner],
      ),
      this.pool.query<{ n: string }>("SELECT count(*) AS n FROM tasks WHERE owner = $1 AND created_at >= now() - interval '1 hour'", [owner]),
    ]);
    return { activeTasks: Number(active.rows[0]!.n), spendTodayUsd: Number(spend.rows[0]!.total), tasksLastHour: Number(recent.rows[0]!.n) };
  }

  /** Throws QuotaExceededError (with a message the user can act on) if this owner may not start another task. */
  async check(owner: string): Promise<void> {
    const allowance = await this.allowanceFor(owner);
    if (allowance?.unlimited) return;
    const maxConcurrent = allowance?.maxConcurrent ?? this.defaults.maxConcurrent;
    const dailySpend = allowance?.dailySpendUsd ?? this.defaults.dailySpendUsd;
    const u = await this.usage(owner);
    if (u.activeTasks >= maxConcurrent) {
      throw new QuotaExceededError("too_many_active", this.t("quota.tooManyActive", { active: u.activeTasks, max: maxConcurrent }));
    }
    if (!allowance?.ownKey && u.spendTodayUsd >= dailySpend) {
      throw new QuotaExceededError("daily_spend", this.t("quota.dailySpend", { cap: dailySpend.toFixed(2) }));
    }
    if (u.tasksLastHour >= this.defaults.maxTasksPerHour) {
      throw new QuotaExceededError("too_many_recent", this.t("quota.tooManyRecent", { count: u.tasksLastHour, max: this.defaults.maxTasksPerHour }));
    }
  }
}
