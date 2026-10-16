import { describe, expect, it } from "vitest";
import { ModelError, type ModelAdapter } from "../model/types.js";
import { accessFor, createModelRouter } from "./model-router.js";

const fake = (name: string): ModelAdapter & { name: string } => ({ name, plan: async () => ({ steps: [], criteria: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }), step: async () => ({ type: "finish", summary: name, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }) });
const req = { goal: "g", plan: [], criteria: [], tools: [], observations: [] };
const signal = new AbortController().signal;

describe("which model runs whose task", () => {
  const server = fake("server");
  const router = (over: { admin?: boolean; key?: string | null; shareable?: boolean } = {}) => {
    const seen: string[] = [];
    const used: string[] = [];
    const route = createModelRouter({
      defaultModel: server,
      isAdmin: async () => over.admin ?? false,
      ownKey: async () => (over.key === undefined ? null : over.key),
      serverModelIsShareable: over.shareable ?? false,
      forKey: (k) => {
        used.push(k);
        return fake(`own:${k}`);
      },
      onKey: (k) => seen.push(k),
    });
    return { route, seen, used };
  };

  it("gives admins the server's model, even if they saved a key", async () => {
    const { route, used } = router({ admin: true, key: "sk-ant-x" });
    expect(await route("boss")).toBe(server);
    expect(used).toEqual([]);
  });

  it("runs a person's task on their own key whatever the server runs on, and registers the key for scrubbing", async () => {
    for (const shareable of [false, true]) {
      const { route, seen, used } = router({ key: "sk-ant-mine", shareable });
      const m = (await route("alice")) as ModelAdapter & { name: string };
      expect(m.name).toBe("own:sk-ant-mine");
      expect(used).toEqual(["sk-ant-mine"]);
      expect(seen).toEqual(["sk-ant-mine"]);
    }
  });

  it("never falls back to the owner's personal Claude login for someone without a key: the task fails with a plain reason", async () => {
    const { route } = router({ key: null, shareable: false });
    const m = await route("alice");
    expect(m).not.toBe(server);
    await expect(m.step(req, signal)).rejects.toBeInstanceOf(ModelError);
    await expect(m.plan({ goal: "g", constraints: {}, tools: [] }, signal)).rejects.toThrow(/own Anthropic API key/);
  });

  it("uses the server's model for a person without a key only when it is a shareable API key", async () => {
    const { route } = router({ key: null, shareable: true });
    expect(await route("alice")).toBe(server);
  });

  it("decides access the same way", async () => {
    expect(await accessFor({ admin: true, hasOwnKey: false, serverModelIsShareable: false })).toBe("server");
    expect(await accessFor({ admin: false, hasOwnKey: true, serverModelIsShareable: false })).toBe("own-key");
    expect(await accessFor({ admin: false, hasOwnKey: false, serverModelIsShareable: true })).toBe("server");
    expect(await accessFor({ admin: false, hasOwnKey: false, serverModelIsShareable: false })).toBe("blocked");
  });
});

describe("a task that picks its own Jev mode", () => {
  const server = fake("server");
  const base = {
    defaultModel: server,
    defaultFor: (mode: string) => fake(`server:${mode}`),
    isAdmin: async (o: string) => o === "boss",
    ownKey: async (o: string) => (o === "alice" ? "sk-ant-mine" : null),
    serverModelIsShareable: true,
    forKey: (k: string, mode?: string) => fake(`own:${k}:${mode ?? "default"}`),
  };

  it("uses the unchanged model when no mode was asked for, and the mode's model when one was", async () => {
    const route = createModelRouter(base);
    expect(await route("boss")).toBe(server);
    expect(((await route("boss", "first")) as ModelAdapter & { name: string }).name).toBe("server:first");
    expect(((await route("carol", "only")) as ModelAdapter & { name: string }).name).toBe("server:only");
    expect(((await route("alice", "assist")) as ModelAdapter & { name: string }).name).toBe("own:sk-ant-mine:assist");
  });

  it("still refuses a person with no usable model, whatever mode they asked for", async () => {
    const route = createModelRouter({ ...base, serverModelIsShareable: false });
    await expect((await route("carol", "first")).step(req as never, signal)).rejects.toBeInstanceOf(ModelError);
  });
});
