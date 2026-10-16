import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskStore } from "../persistence/task-store.js";
import { createTestDb } from "../testing/test-db.js";
import { PostgresArtifactStore, type ArtifactLimits } from "./artifact-store.js";

let db: Awaited<ReturnType<typeof createTestDb>>;
let tasks: TaskStore;
beforeAll(async () => {
  db = await createTestDb();
  tasks = new TaskStore(db.connect());
});
afterAll(async () => db.cleanup());

const store = (limits?: Partial<ArtifactLimits>) =>
  new PostgresArtifactStore(db.connect(), { maxBytesEach: 1000, maxPerTask: 5, maxBytesPerTask: 3000, ...limits });
const newTask = () => tasks.createTask({ owner: "u", goal: "g" });
const img = (text: string, size = 100) => Buffer.from(text.padEnd(size, "x"));
const shot = (taskId: string, data: Buffer, attachKey = "tool:c1") => ({ taskId, kind: "screenshot" as const, mime: "image/jpeg" as const, label: "page", attachKey, data });

describe("PostgresArtifactStore", () => {
  it("stores bytes and returns metadata without loading the data", async () => {
    const s = store();
    const t = await newTask();
    const r = await s.put(shot(t.id, img("a")));
    expect(r).toMatchObject({ stored: true, artifact: { kind: "screenshot", mime: "image/jpeg", sizeBytes: 100, attachKey: "tool:c1" } });
    const [meta] = await s.list(t.id);
    expect(meta).not.toHaveProperty("data");
    expect((await s.get(meta!.id))!.data.equals(img("a"))).toBe(true);
    expect(await s.get("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("does not store an identical capture twice in a row, but stores it again after something changed", async () => {
    const s = store();
    const t = await newTask();
    const first = await s.put(shot(t.id, img("same")));
    const dup = await s.put(shot(t.id, img("same"), "tool:c2"));
    expect(dup).toMatchObject({ stored: true, duplicateOf: first.stored ? first.artifact.id : "" });
    await s.put(shot(t.id, img("different")));
    await s.put(shot(t.id, img("same")));
    expect((await s.list(t.id)).length).toBe(3);
  });

  it("enforces per-file, per-task count and per-task byte limits", async () => {
    const s = store();
    const t = await newTask();
    expect(await s.put(shot(t.id, img("big", 1001)))).toEqual({ stored: false, reason: "too_large" });
    for (let i = 0; i < 3; i++) await s.put(shot(t.id, img(`n${i}`, 900)));
    expect(await s.put(shot(t.id, img("more", 900)))).toEqual({ stored: false, reason: "task_storage_limit" });

    const t2 = await newTask();
    for (let i = 0; i < 5; i++) await s.put(shot(t2.id, img(`m${i}`, 10)));
    expect(await s.put(shot(t2.id, img("six", 10)))).toEqual({ stored: false, reason: "task_artifact_limit" });
    expect((await s.list(t2.id)).length).toBe(5);
  });

  it("cannot be raced past the count limit by concurrent writers", async () => {
    const s = store({ maxPerTask: 3 });
    const t = await newTask();
    await Promise.all(Array.from({ length: 8 }, (_, i) => s.put(shot(t.id, img(`r${i}`, 20)))));
    expect((await s.list(t.id)).length).toBe(3);
  });

  it("rejects a mime type that does not match the kind", async () => {
    const t = await newTask();
    await expect(store().put({ ...shot(t.id, img("a")), kind: "page_text" })).rejects.toThrow(/not valid/);
  });

  it("keeps tasks separate, deletes one artifact, and purges old ones by age", async () => {
    const s = store();
    const a = await newTask();
    const b = await newTask();
    const ra = await s.put(shot(a.id, img("a1")));
    await s.put(shot(b.id, img("b1")));
    expect((await s.list(a.id)).length).toBe(1);

    expect(await s.delete(ra.stored ? ra.artifact.id : "")).toBe(true);
    expect(await s.delete(ra.stored ? ra.artifact.id : "")).toBe(false);

    await db.connect().query("UPDATE artifacts SET created_at = now() - interval '40 days' WHERE task_id = $1", [b.id]);
    expect(await s.purgeOlderThan(new Date(Date.now() - 30 * 86_400_000))).toBeGreaterThanOrEqual(1);
    expect((await s.list(b.id)).length).toBe(0);
  });
});
