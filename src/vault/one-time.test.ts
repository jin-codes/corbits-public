import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApprovalStore } from "../persistence/approval-store.js";
import { TaskStore } from "../persistence/task-store.js";
import { createTestDb } from "../testing/test-db.js";
import { OneTimeSecretStore } from "./one-time.js";

let db: Awaited<ReturnType<typeof createTestDb>>;
let tasks: TaskStore;
let approvals: ApprovalStore;
const KEY = randomBytes(32);
beforeAll(async () => {
  db = await createTestDb();
  const pool = db.connect();
  tasks = new TaskStore(pool);
  approvals = new ApprovalStore(pool);
});
afterAll(async () => db.cleanup());

const newApproval = async () => {
  const t = await tasks.createTask({ owner: "u", goal: "g" });
  const { approval } = await approvals.request(t.id, { tool: "browser.ask_password", input: { ref: "e1" }, actionFingerprint: `a-${randomUUID()}`, effectFingerprint: `e-${randomUUID()}` });
  return approval.id;
};

describe("OneTimeSecretStore", () => {
  it("returns the value exactly once, then it is gone", async () => {
    const store = new OneTimeSecretStore(db.connect(), KEY);
    const id = await newApproval();
    await store.put(id, { value: "typed-in-the-card-123", origin: "https://a.example" });
    expect(await store.take(id)).toEqual({ value: "typed-in-the-card-123", origin: "https://a.example" });
    expect(await store.take(id)).toBeNull();
  });

  it("stores it encrypted", async () => {
    const store = new OneTimeSecretStore(db.connect(), KEY);
    const id = await newApproval();
    await store.put(id, { value: "visible-if-not-encrypted-9", origin: "https://a.example" });
    const dump = (await db.connect().query("SELECT t::text AS t FROM approval_secrets t WHERE approval_id = $1", [id])).rows[0].t as string;
    expect(dump).not.toContain("visible-if-not-encrypted-9");
    await store.delete(id);
  });

  it("is bound to its approval and site: a moved or altered row cannot be decrypted", async () => {
    const pool = db.connect();
    const store = new OneTimeSecretStore(pool, KEY);
    const a = await newApproval();
    const b = await newApproval();
    await store.put(a, { value: "value-for-a-12345", origin: "https://a.example" });
    await pool.query("UPDATE approval_secrets SET origin = 'https://evil.example' WHERE approval_id = $1", [a]);
    await expect(store.take(a)).rejects.toThrow();

    await store.put(a, { value: "value-for-a-12345", origin: "https://a.example" });
    const row = (await pool.query("SELECT iv, ciphertext FROM approval_secrets WHERE approval_id = $1", [a])).rows[0];
    await pool.query("DELETE FROM approval_secrets WHERE approval_id = $1", [a]);
    await pool.query("INSERT INTO approval_secrets (approval_id, origin, iv, ciphertext) VALUES ($1, 'https://a.example', $2, $3)", [b, row.iv, row.ciphertext]);
    await expect(store.take(b)).rejects.toThrow(); // copied to a different approval
  });

  it("purges passwords that were never used, and keeps recent ones", async () => {
    const pool = db.connect();
    const store = new OneTimeSecretStore(pool, KEY);
    const old = await newApproval();
    const fresh = await newApproval();
    await store.put(old, { value: "stale-value-12345", origin: "https://a.example" });
    await store.put(fresh, { value: "fresh-value-12345", origin: "https://a.example" });
    await pool.query("UPDATE approval_secrets SET created_at = now() - interval '2 hours' WHERE approval_id = $1", [old]);
    expect(await store.purgeOlderThan(new Date(Date.now() - 30 * 60_000))).toBe(1);
    expect(await store.take(old)).toBeNull();
    expect((await store.take(fresh))!.value).toBe("fresh-value-12345");
  });
});
