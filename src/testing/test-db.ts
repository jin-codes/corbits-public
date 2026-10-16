import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "../persistence/migrate.js";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://corbits:corbits_dev_only@127.0.0.1:5432/corbits";

/** An isolated schema in the local Postgres; `connect()` simulates a fresh process (new pool). */
export async function createTestDb() {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pools: pg.Pool[] = [];
  const connect = () => {
    // Small, quickly-idling pools: test files run in parallel and some make a pool per test, and Postgres
    // allows only 100 connections in all (running out makes best-effort code paths fail silently).
    const p = new pg.Pool({ connectionString: URL, options: `-c search_path=${schema}`, max: 3, idleTimeoutMillis: 300 });
    pools.push(p);
    return p;
  };
  await migrate(connect());
  const bossSchema = `${schema}_boss`;
  return {
    connect,
    url: URL,
    /** Throwaway pg-boss schema, dropped on cleanup. */
    bossSchema,
    async cleanup() {
      await Promise.all(pools.map((p) => p.end()));
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.end();
    },
  };
}
