import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidTransitionError } from "../domain/task-state.js";
import { migrate } from "./migrate.js";
import { StaleStateError, TaskNotFoundError, TaskStore } from "./task-store.js";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://corbits:corbits_dev_only@127.0.0.1:5432/corbits";
const schema = `test_${randomBytes(6).toString("hex")}`;
let admin: pg.Pool;
let pool: pg.Pool;
let store: TaskStore;

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: URL, options: `-c search_path=${schema}` });
  await migrate(pool);
  store = new TaskStore(pool);
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

const newTask = () => store.createTask({ owner: "u1", goal: "open example.com" });

describe("TaskStore", () => {
  it("creates a queued task with a creation event", async () => {
    const t = await newTask();
    expect(t.status).toBe("queued");
    const events = await store.listEvents(t.id);
    expect(events.map((e) => [e.seq, e.type])).toEqual([[1, "task.created"]]);
  });

  it("validates input", async () => {
    await expect(store.createTask({ owner: "", goal: "x" })).rejects.toThrow();
    await expect(store.createTask({ owner: "u", goal: "" })).rejects.toThrow();
  });

  it("records each transition with gap-free sequence numbers", async () => {
    const t = await newTask();
    await store.transition(t.id, "planning");
    await store.transition(t.id, "running");
    await store.appendEvent(t.id, "tool.called", { tool: "browser.goto" });
    const done = await store.transition(t.id, "verifying");
    expect(done.status).toBe("verifying");
    const events = await store.listEvents(t.id);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events[1]!.payload).toMatchObject({ from: "queued", to: "planning" });
  });

  it("rejects illegal transitions and leaves state and history untouched", async () => {
    const t = await newTask();
    await expect(store.transition(t.id, "completed")).rejects.toThrow(InvalidTransitionError);
    expect((await store.getTask(t.id)).status).toBe("queued");
    expect(await store.listEvents(t.id)).toHaveLength(1);
  });

  it("rejects duplicate delivery via expectedFrom", async () => {
    const t = await newTask();
    await store.transition(t.id, "planning", { expectedFrom: "queued" });
    await expect(store.transition(t.id, "planning", { expectedFrom: "queued" })).rejects.toThrow(StaleStateError);
    expect(await store.listEvents(t.id)).toHaveLength(2);
  });

  it("serializes concurrent transitions: exactly one wins", async () => {
    const t = await newTask();
    const results = await Promise.allSettled([
      store.transition(t.id, "planning", { expectedFrom: "queued" }),
      store.transition(t.id, "cancelled", { expectedFrom: "queued" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const events = await store.listEvents(t.id);
    expect(events).toHaveLength(2);
  });

  it("keeps unique sequence numbers under concurrent appends", async () => {
    const t = await newTask();
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.appendEvent(t.id, "note", { i })));
    const seqs = (await store.listEvents(t.id)).map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
  });

  it("does not allow events to be modified or deleted", async () => {
    const t = await newTask();
    await expect(pool.query("UPDATE task_events SET type = 'x' WHERE task_id = $1", [t.id])).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM task_events WHERE task_id = $1", [t.id])).rejects.toThrow(/append-only/);
  });

  it("survives a 'restart': a fresh pool sees the same state and history", async () => {
    const t = await newTask();
    await store.transition(t.id, "planning");
    const pool2 = new pg.Pool({ connectionString: URL, options: `-c search_path=${schema}` });
    try {
      const store2 = new TaskStore(pool2);
      expect((await store2.getTask(t.id)).status).toBe("planning");
      expect(await store2.listEvents(t.id)).toHaveLength(2);
    } finally {
      await pool2.end();
    }
  });

  it("throws TaskNotFoundError for unknown ids", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    await expect(store.getTask(id)).rejects.toThrow(TaskNotFoundError);
    await expect(store.transition(id, "planning")).rejects.toThrow(TaskNotFoundError);
  });

  it("redacts secrets before they are persisted", async () => {
    const t = await newTask();
    await store.appendEvent(t.id, "tool.completed", { output: "token sk-ant-api03-abcdefghijklmnopqrstuv leaked" });
    const events = await store.listEvents(t.id);
    expect(JSON.stringify(events.at(-1)!.payload)).not.toContain("abcdefghijklmnop");
    const raw = await pool.query("SELECT payload::text AS p FROM task_events WHERE task_id = $1", [t.id]);
    expect(raw.rows.map((r) => r.p).join()).not.toContain("abcdefghijklmnop");
  });

  it("migrate is idempotent", async () => {
    expect(await migrate(pool)).toEqual([]);
  });
});
