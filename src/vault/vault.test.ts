import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../testing/test-db.js";
import { decrypt, encrypt, parseKey } from "./crypto.js";
import { InvalidSecretError, SecretStore, normalizeOrigin, validateName } from "./secret-store.js";

const KEY = randomBytes(32);

describe("crypto", () => {
  it("round-trips, with a fresh IV every time", () => {
    const a = encrypt(KEY, "hunter2-correct-horse", "alice\nname\nhttps://a.example");
    const b = encrypt(KEY, "hunter2-correct-horse", "alice\nname\nhttps://a.example");
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.data.equals(b.data)).toBe(false);
    expect(decrypt(KEY, a.iv, a.data, "alice\nname\nhttps://a.example")).toBe("hunter2-correct-horse");
    expect(a.data.toString("utf8")).not.toContain("hunter2");
  });

  it("refuses the wrong key, wrong context, or any tampering", () => {
    const { iv, data } = encrypt(KEY, "s3cret-value", "ctx");
    expect(() => decrypt(randomBytes(32), iv, data, "ctx")).toThrow();
    expect(() => decrypt(KEY, iv, data, "other-ctx")).toThrow();
    const flipped = Buffer.from(data);
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decrypt(KEY, iv, flipped, "ctx")).toThrow();
    expect(() => decrypt(KEY, iv, data.subarray(0, 5), "ctx")).toThrow();
  });

  it("only accepts a 32-byte key written as 64 hex characters", () => {
    expect(parseKey("ab".repeat(32))).toHaveLength(32);
    for (const bad of ["", "short", "zz".repeat(32), "ab".repeat(31), "ab".repeat(33)]) expect(() => parseKey(bad)).toThrow();
  });
});

describe("validation", () => {
  it("normalizes sites to scheme://host[:port], https only (plain http only for localhost)", () => {
    expect(normalizeOrigin("https://Verilix.Vercel.app/ko/login?x=1")).toBe("https://verilix.vercel.app");
    expect(normalizeOrigin("http://127.0.0.1:5173/app")).toBe("http://127.0.0.1:5173");
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    for (const bad of ["http://example.com", "ftp://example.com", "example.com", "https://user:pw@example.com", "javascript:alert(1)", ""]) {
      expect(() => normalizeOrigin(bad), bad).toThrow(InvalidSecretError);
    }
  });
  it("restricts names", () => {
    expect(validateName("verilix-password")).toBe("verilix-password");
    for (const bad of ["", "Has Space", "UPPER", "-lead", "a".repeat(65), "x/y", "x\ny"]) expect(() => validateName(bad), bad).toThrow(InvalidSecretError);
  });
});

describe("SecretStore (real Postgres)", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let store: SecretStore;
  beforeAll(async () => {
    db = await createTestDb();
    store = new SecretStore(db.connect(), KEY);
  });
  afterAll(async () => db.cleanup());

  const raw = async (owner: string, name: string) =>
    (await db.connect().query("SELECT iv, ciphertext FROM secrets WHERE owner = $1 AND name = $2", [owner, name])).rows[0] as { iv: Buffer; ciphertext: Buffer };

  it("stores the value encrypted and lists only name, site and timestamps", async () => {
    const value = "my-very-secret-password-123";
    const meta = await store.put("alice", { name: "site-pw", origin: "https://a.example/login", value });
    expect(meta).toMatchObject({ name: "site-pw", origin: "https://a.example", lastUsedAt: null });
    const listed = await store.list("alice");
    expect(listed.map((m) => m.name)).toEqual(["site-pw"]);
    expect(JSON.stringify(listed)).not.toContain(value);

    const row = await raw("alice", "site-pw");
    expect(row.ciphertext.toString("utf8")).not.toContain(value);
    expect(row.ciphertext.toString("hex")).not.toContain(Buffer.from(value).toString("hex"));
    const dump = (await db.connect().query("SELECT t::text AS t FROM secrets t")).rows.map((r) => r.t).join("");
    expect(dump).not.toContain(value);
  });

  it("reveals the value only through reveal(), and records that it was used", async () => {
    await store.put("alice", { name: "pw2", origin: "https://a.example", value: "another-secret-value" });
    expect((await store.meta("alice", "pw2"))!.lastUsedAt).toBeNull();
    expect(await store.reveal("alice", "pw2")).toEqual({ origin: "https://a.example", value: "another-secret-value" });
    expect((await store.meta("alice", "pw2"))!.lastUsedAt).toBeInstanceOf(Date);
    expect(await store.reveal("alice", "nope")).toBeNull();
  });

  it("keeps owners apart", async () => {
    await store.put("alice", { name: "shared-name", origin: "https://a.example", value: "alice-value-1234" });
    await store.put("bob", { name: "shared-name", origin: "https://b.example", value: "bob-value-5678" });
    expect((await store.reveal("alice", "shared-name"))!.value).toBe("alice-value-1234");
    expect((await store.reveal("bob", "shared-name"))!.value).toBe("bob-value-5678");
    expect((await store.list("bob")).map((m) => m.name)).not.toContain("site-pw");
    expect(await store.delete("bob", "site-pw")).toBe(false);
  });

  it("replaces a secret when saved again, including its site", async () => {
    await store.put("alice", { name: "rot", origin: "https://old.example", value: "old-value-12345" });
    await store.put("alice", { name: "rot", origin: "https://new.example", value: "new-value-67890" });
    expect(await store.reveal("alice", "rot")).toEqual({ origin: "https://new.example", value: "new-value-67890" });
    expect((await store.list("alice")).filter((m) => m.name === "rot")).toHaveLength(1);
  });

  it("detects a row moved to another owner, renamed, or pointed at another site", async () => {
    const pool = db.connect();
    await store.put("alice", { name: "victim", origin: "https://a.example", value: "victim-value-1234" });
    await pool.query("UPDATE secrets SET owner = 'mallory' WHERE owner = 'alice' AND name = 'victim'");
    await expect(store.reveal("mallory", "victim")).rejects.toThrow();

    await store.put("alice", { name: "pinned", origin: "https://a.example", value: "pinned-value-1234" });
    await pool.query("UPDATE secrets SET origin = 'https://evil.example' WHERE owner = 'alice' AND name = 'pinned'");
    await expect(store.reveal("alice", "pinned")).rejects.toThrow();
  });

  it("rejects bad input and cannot decrypt with a different key", async () => {
    await expect(store.put("alice", { name: "Bad Name", origin: "https://a.example", value: "x-value-1234" })).rejects.toBeInstanceOf(InvalidSecretError);
    await expect(store.put("alice", { name: "ok", origin: "http://a.example", value: "x-value-1234" })).rejects.toBeInstanceOf(InvalidSecretError);
    await expect(store.put("alice", { name: "ok", origin: "https://a.example", value: "" })).rejects.toBeInstanceOf(InvalidSecretError);
    await expect(store.put("alice", { name: "ok", origin: "https://a.example", value: "x".repeat(1025) })).rejects.toBeInstanceOf(InvalidSecretError);
    await store.put("alice", { name: "keyed", origin: "https://a.example", value: "keyed-value-1234" });
    await expect(new SecretStore(db.connect(), randomBytes(32)).reveal("alice", "keyed")).rejects.toThrow();
  });

  it("deletes a secret", async () => {
    await store.put("alice", { name: "gone", origin: "https://a.example", value: "gone-value-1234" });
    expect(await store.delete("alice", "gone")).toBe(true);
    expect(await store.meta("alice", "gone")).toBeNull();
  });
});
