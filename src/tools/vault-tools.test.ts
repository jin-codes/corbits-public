import { describe, expect, it } from "vitest";
import { PolicyEngine, type ApprovalRecord, type PolicyContext } from "../policy/policy-engine.js";
import { actionFingerprint, effectFingerprint, fingerprintContext } from "../policy/fingerprint.js";
import { Redactor } from "../security/redact.js";
import { MockBrowser } from "../testing/mock-browser.js";
import type { SecretMeta, VaultReader } from "../vault/secret-store.js";
import { executeAllowed } from "./executor.js";
import { createBrowserTools } from "./browser-tools.js";
import { ToolRegistry } from "./registry.js";
import { createVaultTools } from "./vault-tools.js";
import type { OneTimeSecret, OneTimeTaker } from "../vault/one-time.js";

const SECRET = "Sup3r-Secret-Passw0rd!";
const LOGIN = "https://login.example/";

const pages = () => ({
  [LOGIN]: {
    content: `- heading "Sign in"`,
    elements: [
      { role: "textbox" as const, name: "Email", inputType: "email" }, // e1
      { role: "textbox" as const, name: "Password", inputType: "password", insideForm: true }, // e2
      { role: "button" as const, name: "Log in", insideForm: true, inputType: "submit" }, // e3
    ],
  },
  "https://evil.example/": { content: `- heading "Sign in"`, elements: [{ role: "textbox" as const, name: "Password", inputType: "password" }] },
});

class FakeVault implements VaultReader {
  reveals = 0;
  data = new Map<string, { origin: string; value: string }>([["login-pw", { origin: "https://login.example", value: SECRET }]]);
  async list(): Promise<SecretMeta[]> {
    return [...this.data].map(([name, v]) => ({ name, origin: v.origin, createdAt: new Date(), updatedAt: new Date(), lastUsedAt: null }));
  }
  async meta(_owner: string, name: string) {
    const v = this.data.get(name);
    return v ? { name, origin: v.origin, createdAt: new Date(), updatedAt: new Date(), lastUsedAt: null } : null;
  }
  async reveal(_owner: string, name: string) {
    this.reveals++;
    return this.data.get(name) ?? null;
  }
}

async function setup(startUrl = LOGIN) {
  const browser = new MockBrowser(pages());
  await browser.goto(startUrl);
  const vault = new FakeVault();
  const redactor = new Redactor();
  const registry = new ToolRegistry();
  for (const t of [...createBrowserTools(browser), ...createVaultTools({ browser, vault, owner: "alice", redactor })]) registry.register(t);
  const engine = new PolicyEngine(registry);
  const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
    grantedPermissions: new Set(["browser.navigate", "browser.click", "browser.type", "browser.read", "browser.type_secret"]),
    limits: { maxToolCalls: 10, maxRuntimeMs: 60_000, maxSpendUsd: 5 },
    usage: { toolCalls: 0, elapsedMs: 0, spendUsd: 0 },
    approvals: [],
    actionContext: { url: browser.currentUrl() },
    ...over,
  });
  const tool = registry.get("browser.type_secret")!;
  const evaluate = async (input: unknown, over: Partial<PolicyContext> = {}) => {
    const parsed = tool.inputSchema.safeParse(input);
    const inspection = parsed.success ? await tool.inspect!(parsed.data).catch(() => ({ inspectionFailed: true })) : undefined;
    return { decision: engine.evaluate({ tool: "browser.type_secret", input, inspection }, ctx(over)), inspection };
  };
  return { browser, vault, engine, ctx, evaluate, registry, redactor };
}

describe("browser.type_secret: refusals happen before anyone is asked to approve", () => {
  it("refuses an unknown credential", async () => {
    const { evaluate } = await setup();
    expect((await evaluate({ ref: "e2", secretName: "nope" })).decision).toMatchObject({ kind: "deny", code: "precondition_failed", reason: expect.stringContaining('no saved credential named "nope"') });
  });

  it("refuses to type into anything but a password field", async () => {
    const { evaluate } = await setup();
    const { decision } = await evaluate({ ref: "e1", secretName: "login-pw" }); // the email box
    expect(decision).toMatchObject({ kind: "deny", code: "precondition_failed", reason: expect.stringContaining("password fields") });
  });

  it("refuses to use a credential on a different site", async () => {
    const { evaluate } = await setup("https://evil.example/");
    const { decision } = await evaluate({ ref: "e1", secretName: "login-pw" });
    expect(decision).toMatchObject({ kind: "deny", code: "precondition_failed" });
    expect((decision as { reason: string }).reason).toContain("https://login.example");
    expect((decision as { reason: string }).reason).toContain("https://evil.example");
  });

  it("refuses when the target cannot be inspected (stale or unknown ref)", async () => {
    const { evaluate } = await setup();
    expect((await evaluate({ ref: "e99", secretName: "login-pw" })).decision).toMatchObject({ kind: "deny", code: "precondition_failed" });
  });

  it("rejects malformed input", async () => {
    const { evaluate } = await setup();
    for (const input of [{ ref: "e2" }, { secretName: "login-pw" }, { ref: "e2", secretName: "Has Space" }, { ref: "e2", secretName: "login-pw", value: "x" }]) {
      expect((await evaluate(input)).decision.kind).toBe("deny");
    }
  });
});

describe("browser.type_secret: approval and execution", () => {
  it("always requires approval, bound to the field, page and credential name", async () => {
    const { evaluate } = await setup();
    const { decision, inspection } = await evaluate({ ref: "e2", secretName: "login-pw" });
    expect(decision).toMatchObject({ kind: "require_approval", consequentialKind: "use_credentials" });
    expect(inspection).toMatchObject({ name: "Password", inputType: "password", pageOrigin: "https://login.example", secretOrigin: "https://login.example", secretExists: true });
    expect(JSON.stringify(inspection)).not.toContain(SECRET);
  });

  it("types the value only after approval, and never returns or leaks it", async () => {
    const { browser, vault, registry, engine, ctx, evaluate } = await setup();
    const input = { ref: "e2", secretName: "login-pw" };
    const first = await evaluate(input);
    expect(browser.typed).toEqual([]);
    expect(vault.reveals).toBe(0); // nothing was decrypted just to ask

    const record: ApprovalRecord = {
      id: "ap1",
      actionFingerprint: actionFingerprint("browser.type_secret", input, fingerprintContext({ url: browser.currentUrl() }, first.inspection)),
      effectFingerprint: effectFingerprint("credential:login-pw"),
      decision: "approved",
      consumed: false,
    };
    const approved = engine.evaluate({ tool: "browser.type_secret", input, inspection: first.inspection }, ctx({ approvals: [record] }));
    expect(approved.kind).toBe("allow");
    if (approved.kind !== "allow") throw new Error("unreachable");

    const outcome = await executeAllowed(approved, new AbortController().signal);
    expect(outcome.status).toBe("ok");
    expect(browser.typed).toEqual([{ ref: "e2", text: SECRET }]); // it reached the page...
    expect(JSON.stringify(outcome)).not.toContain(SECRET); // ...and nowhere else
    expect(vault.reveals).toBe(1);
    void registry;
  });

  it("an approval for one credential does not carry over to another field or page", async () => {
    const { engine, ctx, evaluate, browser } = await setup();
    const input = { ref: "e2", secretName: "login-pw" };
    const first = await evaluate(input);
    const record: ApprovalRecord = {
      id: "ap1",
      actionFingerprint: actionFingerprint("browser.type_secret", input, fingerprintContext({ url: browser.currentUrl() }, first.inspection)),
      effectFingerprint: effectFingerprint("credential:login-pw"),
      decision: "approved",
      consumed: false,
    };
    // Same call, but the page the agent is on has changed: a new approval is needed.
    const moved = engine.evaluate({ tool: "browser.type_secret", input, inspection: first.inspection }, ctx({ approvals: [record], actionContext: { url: "https://login.example/other" } }));
    expect(moved.kind).toBe("require_approval");
  });

  it("re-checks the site at the moment of use and types nothing if the page moved", async () => {
    const { browser, vault, engine, ctx, evaluate } = await setup();
    const input = { ref: "e2", secretName: "login-pw" };
    const first = await evaluate(input);
    const record: ApprovalRecord = {
      id: "ap1",
      actionFingerprint: actionFingerprint("browser.type_secret", input, fingerprintContext({ url: browser.currentUrl() }, first.inspection)),
      effectFingerprint: effectFingerprint("credential:login-pw"),
      decision: "approved",
      consumed: false,
    };
    const approved = engine.evaluate({ tool: "browser.type_secret", input, inspection: first.inspection }, ctx({ approvals: [record] }));
    if (approved.kind !== "allow") throw new Error("expected allow");
    await browser.goto("https://evil.example/"); // the page changes between approval and execution
    const outcome = await executeAllowed(approved, new AbortController().signal);
    expect(outcome.status).toBe("error");
    expect(browser.typed).toEqual([]);
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    void vault;
  });

  it("scrubs the value from output even if a page echoes it back", async () => {
    const { browser, redactor, registry } = await setup();
    // Make the page reflect whatever was typed (a hostile or buggy page).
    const realType = browser.type.bind(browser);
    browser.type = async (ref, text) => {
      await realType(ref, text);
      (browser as unknown as { extra: string }).extra += `\n- text "you typed ${text}"`;
    };
    const tool = registry.get("browser.type_secret")!;
    const out = (await tool.handler({ ref: "e2", secretName: "login-pw" }, { signal: new AbortController().signal })) as { ariaSnapshot: string };
    expect(out.ariaSnapshot).not.toContain(SECRET);
    expect(out.ariaSnapshot).toContain("[REDACTED]");
    expect(redactor.redactString(`x ${SECRET} y`)).toBe("x [REDACTED] y");
  });
});

class FakeOneTime implements OneTimeTaker {
  items = new Map<string, OneTimeSecret>();
  async take(id: string) {
    const v = this.items.get(id) ?? null;
    this.items.delete(id);
    return v;
  }
}

describe("browser.ask_password", () => {
  async function setupAsk(url = LOGIN) {
    const browser = new MockBrowser(pages());
    await browser.goto(url);
    const oneTime = new FakeOneTime();
    const registry = new ToolRegistry();
    for (const t of [...createBrowserTools(browser), ...createVaultTools({ browser, vault: new FakeVault(), owner: "alice", redactor: new Redactor(), oneTime })]) registry.register(t);
    const tool = registry.get("browser.ask_password")!;
    const engine = new PolicyEngine(registry);
    const evaluate = async (input: unknown) => {
      const parsed = tool.inputSchema.safeParse(input);
      const inspection = parsed.success ? await tool.inspect!(parsed.data).catch(() => ({ inspectionFailed: true })) : undefined;
      const decision = engine.evaluate({ tool: "browser.ask_password", input, inspection }, {
        grantedPermissions: new Set(["browser.type_secret"]),
        limits: { maxToolCalls: 10, maxRuntimeMs: 60_000, maxSpendUsd: 5 },
        usage: { toolCalls: 0, elapsedMs: 0, spendUsd: 0 },
        approvals: [],
        actionContext: { url: browser.currentUrl() },
      });
      return { decision, inspection };
    };
    return { browser, oneTime, tool, evaluate, registry };
  }

  it("is only registered when passwords can be held (the vault is enabled)", async () => {
    const browser = new MockBrowser(pages());
    const without = createVaultTools({ browser, vault: new FakeVault(), owner: "alice", redactor: new Redactor() });
    expect(without.map((t) => t.name)).toEqual(["browser.type_secret"]);
  });

  it("asks for approval on a password field, recording the page it is for", async () => {
    const { evaluate } = await setupAsk();
    const { decision, inspection } = await evaluate({ ref: "e2" });
    expect(decision).toMatchObject({ kind: "require_approval", consequentialKind: "use_credentials" });
    expect(inspection).toMatchObject({ inputType: "password", pageOrigin: "https://login.example" });
  });

  it("refuses non-password fields and plain-http pages before asking", async () => {
    const { evaluate } = await setupAsk();
    expect((await evaluate({ ref: "e1" })).decision).toMatchObject({ kind: "deny", code: "precondition_failed" });
    const http = new MockBrowser({ "http://insecure.example/": { content: "", elements: [{ role: "textbox" as const, name: "Password", inputType: "password" }] } });
    await http.goto("http://insecure.example/");
    const registry = new ToolRegistry();
    for (const t of createVaultTools({ browser: http, vault: new FakeVault(), owner: "alice", redactor: new Redactor(), oneTime: new FakeOneTime() })) registry.register(t);
    const tool = registry.get("browser.ask_password")!;
    const inspection = await tool.inspect!({ ref: "e1" });
    expect(tool.precheck!({ ref: "e1" }, inspection)).toContain("https");
  });

  it("rejects extra fields, such as a password supplied by the model", async () => {
    const { evaluate } = await setupAsk();
    expect((await evaluate({ ref: "e2", value: "hunter2" })).decision.kind).toBe("deny");
    expect((await evaluate({ ref: "e2", password: "hunter2" })).decision.kind).toBe("deny");
  });

  it("types the entered password once, only on the page it was entered for, and never returns it", async () => {
    const { browser, oneTime, tool } = await setupAsk();
    oneTime.items.set("ap1", { value: SECRET, origin: "https://login.example" });
    const out = await tool.handler({ ref: "e2" }, { signal: new AbortController().signal, approvalId: "ap1" });
    expect(browser.typed).toEqual([{ ref: "e2", text: SECRET }]);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    // Used up: a replay finds nothing.
    await expect(tool.handler({ ref: "e2" }, { signal: new AbortController().signal, approvalId: "ap1" })).rejects.toThrow(/no password/);
    expect(browser.typed).toHaveLength(1);
  });

  it("types nothing without an approval, without an entered password, or if the page moved", async () => {
    const { browser, oneTime, tool } = await setupAsk();
    await expect(tool.handler({ ref: "e2" }, { signal: new AbortController().signal })).rejects.toThrow(/approval/);
    await expect(tool.handler({ ref: "e2" }, { signal: new AbortController().signal, approvalId: "none" })).rejects.toThrow(/no password/);
    oneTime.items.set("ap2", { value: SECRET, origin: "https://login.example" });
    await browser.goto("https://evil.example/");
    const err = await tool.handler({ ref: "e1" }, { signal: new AbortController().signal, approvalId: "ap2" }).then(() => null, (e: Error) => e);
    expect(err!.message).toContain("no longer the one");
    expect(err!.message).not.toContain(SECRET);
    expect(browser.typed).toEqual([]);
  });
});
