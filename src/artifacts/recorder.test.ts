import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserAdapter } from "../execution/browser-adapter.js";
import { TaskStore } from "../persistence/task-store.js";
import { Redactor } from "../security/redact.js";
import { MockBrowser } from "../testing/mock-browser.js";
import { createTestDb } from "../testing/test-db.js";
import { PostgresArtifactStore } from "./artifact-store.js";
import { BrowserArtifactRecorder } from "./recorder.js";

let db: Awaited<ReturnType<typeof createTestDb>>;
let tasks: TaskStore;
beforeAll(async () => {
  db = await createTestDb();
  tasks = new TaskStore(db.connect());
});
afterAll(async () => db.cleanup());

const PAGE = { "https://x.example/": { content: '- heading "Hello"\n- text "token sk-ant-api03-abcdefghijklmnopqrstuv"' } };
const setup = async (browser: BrowserAdapter = new MockBrowser(PAGE), limits?: ConstructorParameters<typeof PostgresArtifactStore>[1]) => {
  const task = await tasks.createTask({ owner: "u", goal: "g" });
  const artifacts = new PostgresArtifactStore(db.connect(), limits);
  const recorder = new BrowserArtifactRecorder({ browser, artifacts, store: tasks, redactor: new Redactor() });
  return { task, artifacts, recorder };
};
const events = async (taskId: string) => (await tasks.listEvents(taskId)).filter((e) => e.type.startsWith("artifact."));

describe("BrowserArtifactRecorder", () => {
  it("stores a screenshot and records an event that points at it", async () => {
    const b = new MockBrowser(PAGE);
    await b.goto("https://x.example/");
    const { task, artifacts, recorder } = await setup(b);
    await recorder.capture(task.id, { attachKey: "tool:c1", label: "browser.goto", kinds: ["screenshot"] });
    const [meta] = await artifacts.list(task.id);
    expect(meta).toMatchObject({ kind: "screenshot", mime: "image/jpeg", attachKey: "tool:c1", label: "browser.goto" });
    const [ev] = await events(task.id);
    expect(ev).toMatchObject({ type: "artifact.created", payload: { artifactId: meta!.id, attachKey: "tool:c1" } });
  });

  it("points a repeat capture at the existing image instead of storing it again", async () => {
    const b = new MockBrowser(PAGE);
    await b.goto("https://x.example/");
    const { task, artifacts, recorder } = await setup(b);
    await recorder.capture(task.id, { attachKey: "tool:c1", label: "a", kinds: ["screenshot"] });
    await recorder.capture(task.id, { attachKey: "tool:c2", label: "b", kinds: ["screenshot"] });
    expect((await artifacts.list(task.id)).length).toBe(1);
    const created = (await events(task.id)).filter((e) => e.type === "artifact.created");
    expect(created.map((e) => e.payload.attachKey)).toEqual(["tool:c1", "tool:c2"]);
    expect(created[1]!.payload.artifactId).toBe(created[0]!.payload.artifactId);
  });

  it("saves the page text with secrets scrubbed", async () => {
    const b = new MockBrowser(PAGE);
    await b.goto("https://x.example/");
    const { task, artifacts, recorder } = await setup(b);
    await recorder.capture(task.id, { attachKey: "verification:1", label: "v", kinds: ["page_text"] });
    const [meta] = await artifacts.list(task.id);
    const text = (await artifacts.get(meta!.id))!.data.toString("utf8");
    expect(meta).toMatchObject({ kind: "page_text", mime: "text/plain" });
    expect(text).toContain("URL: https://x.example/");
    expect(text).toContain("Hello");
    expect(text).not.toContain("abcdefghijklmnop");
  });

  it("never throws when the browser fails, and records that evidence was missed", async () => {
    const broken = new MockBrowser(PAGE);
    broken.screenshot = async () => {
      throw new Error("Target closed");
    };
    const { task, recorder } = await setup(broken);
    await expect(recorder.capture(task.id, { attachKey: "tool:c1", label: "x", kinds: ["screenshot", "page_text"] })).resolves.toBeUndefined();
    const types = (await events(task.id)).map((e) => e.type);
    expect(types).toContain("artifact.failed");
    expect(types).toContain("artifact.created"); // page_text still worked
  });

  it("times out a hung capture instead of stalling the task", async () => {
    const hung = new MockBrowser(PAGE);
    hung.screenshot = () => new Promise(() => {});
    const { task, artifacts } = await setup(hung);
    const recorder = new BrowserArtifactRecorder({ browser: hung, artifacts, store: tasks, timeoutMs: 50 });
    const started = Date.now();
    await recorder.capture(task.id, { attachKey: "tool:c1", label: "x", kinds: ["screenshot"] });
    expect(Date.now() - started).toBeLessThan(1500);
    expect((await events(task.id))[0]!.payload).toMatchObject({ error: expect.stringContaining("timed out") });
  });

  it("reports a full quota once instead of flooding the history", async () => {
    const b = new MockBrowser(PAGE);
    const { task, recorder } = await setup(b, { maxBytesEach: 10_000, maxPerTask: 1, maxBytesPerTask: 10_000 });
    for (let i = 0; i < 4; i++) {
      await b.goto("https://x.example/");
      b.clicks.push(`c${i}`); // changes the mock screenshot so it is not a duplicate
      await recorder.capture(task.id, { attachKey: `tool:c${i}`, label: "x", kinds: ["screenshot"] });
    }
    const skipped = (await events(task.id)).filter((e) => e.type === "artifact.skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.payload).toMatchObject({ reason: "task_artifact_limit" });
  });
});
