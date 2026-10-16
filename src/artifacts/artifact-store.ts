import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type ArtifactKind = "screenshot" | "page_text";
export type ArtifactMime = "image/jpeg" | "image/png" | "text/plain";

const MIME_FOR_KIND: Record<ArtifactKind, readonly ArtifactMime[]> = {
  screenshot: ["image/jpeg", "image/png"],
  page_text: ["text/plain"],
};

export interface ArtifactMeta {
  id: string;
  taskId: string;
  kind: ArtifactKind;
  mime: ArtifactMime;
  label: string;
  attachKey: string;
  sizeBytes: number;
  sha256: string;
  createdAt: Date;
}

export interface Artifact extends ArtifactMeta {
  data: Buffer;
}

export interface NewArtifact {
  taskId: string;
  kind: ArtifactKind;
  mime: ArtifactMime;
  label: string;
  attachKey: string;
  data: Buffer;
}

export type PutResult =
  | { stored: true; artifact: ArtifactMeta; duplicateOf?: undefined }
  | { stored: true; artifact: ArtifactMeta; duplicateOf: string }
  | { stored: false; reason: "too_large" | "task_artifact_limit" | "task_storage_limit" };

export interface ArtifactLimits {
  maxBytesEach: number;
  maxPerTask: number;
  maxBytesPerTask: number;
}

export const DEFAULT_ARTIFACT_LIMITS: ArtifactLimits = {
  maxBytesEach: 2 * 1024 * 1024,
  maxPerTask: 80,
  maxBytesPerTask: 40 * 1024 * 1024,
};

/** Where task output files live. Postgres today; the interface keeps disk or object storage possible. */
export interface ArtifactStore {
  put(input: NewArtifact): Promise<PutResult>;
  list(taskId: string): Promise<ArtifactMeta[]>;
  get(id: string): Promise<Artifact | null>;
  getMeta(id: string): Promise<ArtifactMeta | null>;
  delete(id: string): Promise<boolean>;
  /** Deletes artifacts older than the cutoff. Returns how many were removed. */
  purgeOlderThan(cutoff: Date): Promise<number>;
}

interface Row {
  id: string;
  task_id: string;
  kind: ArtifactKind;
  mime: ArtifactMime;
  label: string;
  attach_key: string;
  size_bytes: number;
  sha256: string;
  created_at: Date;
}

const META_COLUMNS = "id, task_id, kind, mime, label, attach_key, size_bytes, sha256, created_at";

const toMeta = (r: Row): ArtifactMeta => ({
  id: r.id,
  taskId: r.task_id,
  kind: r.kind,
  mime: r.mime,
  label: r.label,
  attachKey: r.attach_key,
  sizeBytes: r.size_bytes,
  sha256: r.sha256,
  createdAt: r.created_at,
});

export class PostgresArtifactStore implements ArtifactStore {
  constructor(
    private readonly pool: Pool,
    private readonly limits: ArtifactLimits = DEFAULT_ARTIFACT_LIMITS,
  ) {}

  async put(input: NewArtifact): Promise<PutResult> {
    if (!MIME_FOR_KIND[input.kind].includes(input.mime)) throw new Error(`mime ${input.mime} is not valid for ${input.kind}`);
    if (input.data.length > this.limits.maxBytesEach) return { stored: false, reason: "too_large" };

    const sha256 = createHash("sha256").update(input.data).digest("hex");
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      // Serialize writers per task so the limits below cannot be raced past.
      await c.query("SELECT 1 FROM tasks WHERE id = $1 FOR UPDATE", [input.taskId]);

      // An identical capture right after the previous one (nothing changed on screen) adds nothing.
      const last = await c.query<Row>(
        `SELECT ${META_COLUMNS} FROM artifacts WHERE task_id = $1 AND kind = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
        [input.taskId, input.kind],
      );
      if (last.rows[0]?.sha256 === sha256) {
        await c.query("COMMIT");
        return { stored: true, artifact: toMeta(last.rows[0]), duplicateOf: last.rows[0].id };
      }

      const totals = await c.query<{ n: string; bytes: string }>(
        "SELECT count(*) AS n, COALESCE(sum(size_bytes), 0) AS bytes FROM artifacts WHERE task_id = $1",
        [input.taskId],
      );
      const n = Number(totals.rows[0]!.n);
      const bytes = Number(totals.rows[0]!.bytes);
      if (n >= this.limits.maxPerTask) return await this.rollback(c, "task_artifact_limit");
      if (bytes + input.data.length > this.limits.maxBytesPerTask) return await this.rollback(c, "task_storage_limit");

      const { rows } = await c.query<Row>(
        `INSERT INTO artifacts (id, task_id, kind, mime, label, attach_key, size_bytes, sha256, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${META_COLUMNS}`,
        [randomUUID(), input.taskId, input.kind, input.mime, input.label.slice(0, 200), input.attachKey.slice(0, 200), input.data.length, sha256, input.data],
      );
      await c.query("COMMIT");
      return { stored: true, artifact: toMeta(rows[0]!) };
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  private async rollback(c: { query: (q: string) => Promise<unknown> }, reason: "task_artifact_limit" | "task_storage_limit"): Promise<PutResult> {
    await c.query("ROLLBACK");
    return { stored: false, reason };
  }

  async list(taskId: string): Promise<ArtifactMeta[]> {
    const { rows } = await this.pool.query<Row>(`SELECT ${META_COLUMNS} FROM artifacts WHERE task_id = $1 ORDER BY created_at, id`, [taskId]);
    return rows.map(toMeta);
  }

  async get(id: string): Promise<Artifact | null> {
    const { rows } = await this.pool.query<Row & { data: Buffer }>(`SELECT ${META_COLUMNS}, data FROM artifacts WHERE id = $1`, [id]);
    return rows[0] ? { ...toMeta(rows[0]), data: rows[0].data } : null;
  }

  async getMeta(id: string): Promise<ArtifactMeta | null> {
    const { rows } = await this.pool.query<Row>(`SELECT ${META_COLUMNS} FROM artifacts WHERE id = $1`, [id]);
    return rows[0] ? toMeta(rows[0]) : null;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("DELETE FROM artifacts WHERE id = $1", [id]);
    return rowCount === 1;
  }

  async purgeOlderThan(cutoff: Date): Promise<number> {
    const { rowCount } = await this.pool.query("DELETE FROM artifacts WHERE created_at < $1", [cutoff]);
    return rowCount ?? 0;
  }
}
