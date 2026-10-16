import { describe, expect, it } from "vitest";
import { hashToken, loadConfig, parseApiTokens, parseOwnerEmails } from "./config.js";

const TOKEN = "a".repeat(40);
const baseEnv = {
  DATABASE_URL: "postgres://u:supersecretpw@localhost/db",
  ANTHROPIC_API_KEY: "sk-ant-test-key-1234567890",
  CORBITS_CLAUDE_MODEL: "claude-sonnet-5-5",
  CORBITS_API_TOKENS: `alice:${TOKEN}`,
};

describe("parseApiTokens", () => {
  it("maps token hashes to owners and keeps no plaintext", () => {
    const m = parseApiTokens(`alice:${TOKEN}, bob:${"b".repeat(32)}`);
    expect(m.get(hashToken(TOKEN))).toBe("alice");
    expect([...m.keys()].every((k) => /^[0-9a-f]{64}$/.test(k))).toBe(true);
  });
  it("rejects short, malformed, duplicate and empty tokens", () => {
    expect(() => parseApiTokens("alice:short")).toThrow(/too short/);
    expect(() => parseApiTokens(`:${TOKEN}`)).toThrow(/owner:token/);
    expect(() => parseApiTokens(`a:${TOKEN},b:${TOKEN}`)).toThrow(/Duplicate/);
    expect(() => parseApiTokens("")).toThrow();
  });
});

describe("loadConfig", () => {
  it("applies safe defaults", () => {
    const c = loadConfig(baseEnv);
    expect(c.host).toBe("127.0.0.1");
    expect(c.allowPrivateNetwork).toBe(false);
    expect(c.limits.defaults.maxSpendUsd).toBeLessThanOrEqual(c.limits.maximums.maxSpendUsd);
    expect(c.workerConcurrency).toBe(2);
  });
  it("names bad variables without echoing their values", () => {
    try {
      loadConfig({ ...baseEnv, PORT: "not-a-port", CORBITS_CLAUDE_MODEL: "" });
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("PORT");
      expect(msg).toContain("CORBITS_CLAUDE_MODEL");
      expect(msg).not.toContain("not-a-port");
    }
  });
  it("parses the origin allowlist and boolean flags", () => {
    const c = loadConfig({ ...baseEnv, CORBITS_ALLOWED_ORIGINS: "https://a.example, https://b.example", CORBITS_ALLOW_PRIVATE_NETWORK: "true" });
    expect(c.allowedOrigins).toEqual(["https://a.example", "https://b.example"]);
    expect(c.allowPrivateNetwork).toBe(true);
  });
});

describe("email configuration", () => {
  const email = { CORBITS_SMTP_USER: "bot@example.com", CORBITS_SMTP_PASS: "app-password-123", CORBITS_OWNER_EMAILS: "alice:alice@example.com" };
  it("is off unless fully configured", () => {
    expect(loadConfig(baseEnv).notifications).toBeUndefined();
  });
  it("is on with user, password and recipients, and defaults the sender to the SMTP user", () => {
    const n = loadConfig({ ...baseEnv, ...email }).notifications!;
    expect(n.smtp).toMatchObject({ host: "smtp.gmail.com", port: 465, user: "bot@example.com", from: "bot@example.com" });
    expect(n.ownerEmails.get("alice")).toBe("alice@example.com");
  });
  it("refuses a half-configured setup instead of silently sending nothing", () => {
    expect(() => loadConfig({ ...baseEnv, CORBITS_SMTP_USER: "bot@example.com" })).toThrow(/missing: CORBITS_SMTP_PASS, CORBITS_OWNER_EMAILS/);
  });
  it("validates owner addresses", () => {
    expect(() => parseOwnerEmails("alice:not-an-email")).toThrow(/Invalid email/);
    expect(() => parseOwnerEmails("alice")).toThrow(/owner:email/);
  });
});

describe("browser sandbox configuration", () => {
  it("runs Chromium locally unless a sandbox secret is configured", () => {
    expect(loadConfig(baseEnv).browser).toEqual({ mode: "local" });
  });
  it("attaches to the container, with a secret path, when configured", () => {
    const secret = "s".repeat(32);
    const b = loadConfig({ ...baseEnv, CORBITS_BROWSER_WS_SECRET: secret, CORBITS_BROWSER_PORT: "19222" }).browser;
    expect(b).toEqual({ mode: "docker", wsEndpoint: `ws://127.0.0.1:19222/${secret}`, secret });
  });
  it("rejects a weak sandbox secret", () => {
    expect(() => loadConfig({ ...baseEnv, CORBITS_BROWSER_WS_SECRET: "short" })).toThrow(/CORBITS_BROWSER_WS_SECRET/);
  });
});

describe("blank variables", () => {
  it("treat `NAME=` lines as unset for optional settings, as .env.example ships them", () => {
    const c = loadConfig({ ...baseEnv, CORBITS_BROWSER_WS_SECRET: "", CORBITS_SMTP_USER: "", CORBITS_SMTP_PASS: "", CORBITS_OWNER_EMAILS: "", PORT: "" });
    expect(c.browser).toEqual({ mode: "local" });
    expect(c.notifications).toBeUndefined();
    expect(c.port).toBe(8787);
  });
  it("still reports a blank required variable by name", () => {
    expect(() => loadConfig({ ...baseEnv, CORBITS_CLAUDE_MODEL: "" })).toThrow(/CORBITS_CLAUDE_MODEL/);
  });
});

describe("language", () => {
  it("defaults to Korean and accepts English", () => {
    expect(loadConfig(baseEnv).locale).toBe("ko");
    expect(loadConfig({ ...baseEnv, CORBITS_LOCALE: "en" }).locale).toBe("en");
  });
  it("rejects an unsupported language", () => {
    expect(() => loadConfig({ ...baseEnv, CORBITS_LOCALE: "fr" })).toThrow(/CORBITS_LOCALE/);
  });
});

describe("model provider", () => {
  const { ANTHROPIC_API_KEY: _ignored, ...noKey } = baseEnv as Record<string, string>;
  it("defaults to the Claude Code login and needs no API key", () => {
    expect(loadConfig(noKey).model).toEqual({ provider: "claude-code", bin: "claude" });
  });
  it("does not use an API key that happens to be set unless the API provider is chosen", () => {
    expect(loadConfig(baseEnv).model.provider).toBe("claude-code");
  });
  it("uses the API only when asked, and then requires the key", () => {
    expect(loadConfig({ ...baseEnv, CORBITS_MODEL_PROVIDER: "api" }).model).toEqual({ provider: "api", apiKey: baseEnv.ANTHROPIC_API_KEY });
    expect(() => loadConfig({ ...noKey, CORBITS_MODEL_PROVIDER: "api" })).toThrow(/ANTHROPIC_API_KEY/);
  });
  it("accepts a custom path to the CLI", () => {
    expect(loadConfig({ ...noKey, CORBITS_CLAUDE_BIN: "/opt/bin/claude" }).model).toEqual({ provider: "claude-code", bin: "/opt/bin/claude" });
  });
});

describe("credential vault key", () => {
  it("is off by default", () => {
    expect(loadConfig(baseEnv).secretsKey).toBeUndefined();
  });
  it("accepts 64 hex characters", () => {
    expect(loadConfig({ ...baseEnv, CORBITS_SECRETS_KEY: "ab".repeat(32) }).secretsKey).toBe("ab".repeat(32));
  });
  it("rejects a malformed key by name without echoing it", () => {
    const bad = "not-hex-" + "x".repeat(20);
    try {
      loadConfig({ ...baseEnv, CORBITS_SECRETS_KEY: bad });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("CORBITS_SECRETS_KEY");
      expect((e as Error).message).not.toContain(bad);
    }
  });
});

describe("queue schema", () => {
  it("defaults to pgboss and lets an instance use its own queue", () => {
    expect(loadConfig(baseEnv).queueSchema).toBe("pgboss");
    expect(loadConfig({ ...baseEnv, CORBITS_QUEUE_SCHEMA: "pgboss_test_1" }).queueSchema).toBe("pgboss_test_1");
  });
  it("rejects names that are not safe schema identifiers", () => {
    for (const bad of ["Has-Dash", "1abc", "a;drop", "x".repeat(60)]) expect(() => loadConfig({ ...baseEnv, CORBITS_QUEUE_SCHEMA: bad })).toThrow(/CORBITS_QUEUE_SCHEMA/);
  });
});

describe("attaching to your own Chrome", () => {
  const chrome = { ...baseEnv, CORBITS_BROWSER_CDP_URL: "http://127.0.0.1:9223", CORBITS_ALLOWED_ORIGINS: "https://example.com" };

  it("is selected by CORBITS_BROWSER_CDP_URL", () => {
    expect(loadConfig(chrome).browser).toEqual({ mode: "chrome", cdpUrl: "http://127.0.0.1:9223" });
    expect(loadConfig({ ...chrome, CORBITS_BROWSER_CDP_URL: "http://localhost:9223" }).browser.mode).toBe("chrome");
    expect(loadConfig({ ...chrome, CORBITS_BROWSER_CDP_URL: "http://[::1]:9223" }).browser.mode).toBe("chrome");
  });

  it("only accepts an address on this machine", () => {
    for (const url of ["http://192.168.0.5:9223", "http://example.com:9223", "https://127.0.0.1:9223", "ws://127.0.0.1:9223", "http://user:pw@127.0.0.1:9223", "http://127.0.0.1.evil.com:9223", "not a url"]) {
      expect(() => loadConfig({ ...chrome, CORBITS_BROWSER_CDP_URL: url })).toThrow(/CORBITS_BROWSER_CDP_URL/);
    }
  });

  it("requires a list of sites the agent may visit", () => {
    const { CORBITS_ALLOWED_ORIGINS: _omit, ...without } = chrome;
    expect(() => loadConfig(without)).toThrow(/CORBITS_ALLOWED_ORIGINS/);
    expect(() => loadConfig({ ...chrome, CORBITS_ALLOWED_ORIGINS: " , " })).toThrow(/CORBITS_ALLOWED_ORIGINS/);
  });

  it("can allow any public site only by an explicit choice, with private addresses still blocked", () => {
    const { CORBITS_ALLOWED_ORIGINS: _omit, ...without } = chrome;
    const any = { ...without, CORBITS_ALLOW_ANY_ORIGIN: "true" };
    const c = loadConfig(any);
    expect(c.browser.mode).toBe("chrome");
    expect(c.allowedOrigins).toBeUndefined();
    expect(() => loadConfig({ ...any, CORBITS_ALLOWED_ORIGINS: "https://example.com" })).toThrow(/choose one/);
    expect(() => loadConfig({ ...any, CORBITS_ALLOW_PRIVATE_NETWORK: "true" })).toThrow(/private addresses/);
    const { CORBITS_BROWSER_CDP_URL: _cdp, ...noChrome } = any;
    expect(() => loadConfig(noChrome)).toThrow(/only valid with CORBITS_BROWSER_CDP_URL/);
  });

  it("can sit next to the sandbox: the sandbox stays the default and your Chrome is offered per task", () => {
    const c = loadConfig({ ...chrome, CORBITS_BROWSER_WS_SECRET: "s".repeat(32) });
    expect(c.browser.mode).toBe("docker");
    expect(c.ownChrome).toEqual({ cdpUrl: "http://127.0.0.1:9223" });
    expect(loadConfig(chrome).ownChrome).toEqual({ cdpUrl: "http://127.0.0.1:9223" });
    expect(loadConfig(baseEnv).ownChrome).toBeUndefined();
  });
});

describe("Jev assistance", () => {
  const key = "k".repeat(20);
  it("is on whenever a key is configured, and off without one", () => {
    expect(loadConfig(baseEnv).jev).toBeUndefined();
    expect(loadConfig({ ...baseEnv, TYPESAFE_API_KEY: key }).jev).toEqual({ apiKey: key, minConfidence: 0.6, mode: "first", consensus: false, planGate: false, thresholds: { first: 0.6, assist: 0.75 } });
    expect(loadConfig({ ...baseEnv, TYPESAFE_API_KEY: key, CORBITS_JEV_MODE: "first" }).jev?.mode).toBe("first");
    expect(() => loadConfig({ ...baseEnv, TYPESAFE_API_KEY: key, CORBITS_JEV_MODE: "wild" })).toThrow(/CORBITS_JEV_MODE/);
    // The old on/off switch is gone: a leftover CORBITS_JEV=0 no longer turns Jev off.
    expect(loadConfig({ ...baseEnv, CORBITS_JEV: "0", TYPESAFE_API_KEY: key }).jev).toBeDefined();
  });

  it("refuses a confidence threshold below 0.6, and defaults to 0.6 (first) or 0.75 (assist)", () => {
    const on = { ...baseEnv, TYPESAFE_API_KEY: key };
    expect(() => loadConfig({ ...on, CORBITS_JEV_MIN_CONFIDENCE: "0.5" })).toThrow(/CORBITS_JEV_MIN_CONFIDENCE/);
    expect(() => loadConfig({ ...on, CORBITS_JEV_MIN_CONFIDENCE: "0.59" })).toThrow(/CORBITS_JEV_MIN_CONFIDENCE/);
    expect(loadConfig({ ...on, CORBITS_JEV_MIN_CONFIDENCE: "0.6" }).jev?.minConfidence).toBe(0.6);
    expect(loadConfig({ ...on, CORBITS_JEV_MODE: "assist" }).jev?.minConfidence).toBe(0.75);
    expect(loadConfig({ ...on }).jev?.minConfidence).toBe(0.6);
    expect(loadConfig({ ...on, CORBITS_JEV_MIN_CONFIDENCE: "0.95" }).jev?.minConfidence).toBe(0.95);
  });
});

describe("limits for other people", () => {
  it("has sensible defaults and accepts overrides within bounds", () => {
    expect(loadConfig(baseEnv).userDefaults).toEqual({ maxConcurrent: 2, dailySpendUsd: 2, maxTasksPerHour: 30 });
    expect(loadConfig({ ...baseEnv, CORBITS_USER_MAX_CONCURRENT: "4", CORBITS_USER_DAILY_SPEND_USD: "10", CORBITS_USER_MAX_TASKS_PER_HOUR: "60" }).userDefaults).toEqual({ maxConcurrent: 4, dailySpendUsd: 10, maxTasksPerHour: 60 });
    expect(() => loadConfig({ ...baseEnv, CORBITS_USER_MAX_CONCURRENT: "0" })).toThrow(/CORBITS_USER_MAX_CONCURRENT/);
    expect(() => loadConfig({ ...baseEnv, CORBITS_USER_DAILY_SPEND_USD: "-1" })).toThrow(/CORBITS_USER_DAILY_SPEND_USD/);
  });
});
