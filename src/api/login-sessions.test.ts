import { describe, expect, it } from "vitest";
import { hashToken } from "../runtime/config.js";
import type { TaskService } from "../runtime/task-service.js";
import { LoginSessions } from "./login-sessions.js";
import { buildApi } from "./server.js";

describe("LoginSessions", () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => void (t += ms) };
  };

  it("turns a code into a session once", () => {
    const c = clock();
    const s = new LoginSessions(c.now);
    const { code } = s.issueCode("alice");
    const session = s.redeem(code)!;
    expect(session.owner).toBe("alice");
    expect(session.token).toMatch(/^cbs_[0-9a-f]{64}$/);
    expect(s.ownerOf(session.token)).toBe("alice");
    expect(s.redeem(code)).toBeNull(); // single use
  });

  it("expires codes after a minute and sessions after twelve hours", () => {
    const c = clock();
    const s = new LoginSessions(c.now);
    const stale = s.issueCode("alice").code;
    c.advance(61_000);
    expect(s.redeem(stale)).toBeNull();

    const session = s.redeem(s.issueCode("alice").code)!;
    c.advance(11 * 3_600_000);
    expect(s.ownerOf(session.token)).toBe("alice");
    c.advance(2 * 3_600_000);
    expect(s.ownerOf(session.token)).toBeUndefined();
  });

  it("rejects unknown codes and tokens, and caps what one owner can hold", () => {
    const s = new LoginSessions();
    expect(s.redeem("0".repeat(32))).toBeNull();
    expect(s.ownerOf("cbs_nope")).toBeUndefined();
    const codes = Array.from({ length: 12 }, () => s.issueCode("alice").code);
    expect(s.redeem(codes[0]!)).toBeNull(); // the oldest was dropped
    expect(s.redeem(codes[11]!)).not.toBeNull();
    const tokens = Array.from({ length: 22 }, () => s.redeem(s.issueCode("bob").code)!.token);
    expect(s.ownerOf(tokens[0]!)).toBeUndefined();
    expect(s.ownerOf(tokens[21]!)).toBe("bob");
  });
});

describe("sign-in codes over HTTP", () => {
  const API = "alice-token-".padEnd(40, "a");
  const make = () => buildApi({ service: {} as TaskService, tokenOwners: new Map([[hashToken(API), "alice"]]) });
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  it("lets an API token mint a code that the dashboard swaps for a working session", async () => {
    const app = make();
    expect((await app.inject({ method: "POST", url: "/auth/code" })).statusCode).toBe(401);
    const minted = await app.inject({ method: "POST", url: "/auth/code", headers: bearer(API) });
    expect(minted.statusCode).toBe(200);
    const { code } = minted.json();

    const redeemed = await app.inject({ method: "POST", url: "/auth/redeem", payload: { code } });
    expect(redeemed.statusCode).toBe(200);
    const { token, owner } = redeemed.json();
    expect(owner).toBe("alice");
    expect((await app.inject({ url: "/me", headers: bearer(token) })).json()).toMatchObject({ owner: "alice", role: "admin" }); // the tokens in .env are admins
    expect((await app.inject({ method: "POST", url: "/auth/redeem", payload: { code } })).statusCode).toBe(401); // used
    expect((await app.inject({ url: "/me", headers: bearer(API) })).statusCode).toBe(200); // API token unaffected
    await app.close();
  });

  it("does not let a session mint more codes, and refuses malformed or guessed codes", async () => {
    const app = make();
    const { code } = (await app.inject({ method: "POST", url: "/auth/code", headers: bearer(API) })).json();
    const { token } = (await app.inject({ method: "POST", url: "/auth/redeem", payload: { code } })).json();
    expect((await app.inject({ method: "POST", url: "/auth/code", headers: bearer(token) })).statusCode).toBe(403);

    for (const payload of [{}, { code: "short" }, { code: "G".repeat(32) }, { code, extra: 1 }]) {
      expect((await app.inject({ method: "POST", url: "/auth/redeem", payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: "/auth/redeem", payload: { code: "a".repeat(32) } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/me", headers: bearer("cbs_" + "0".repeat(64)) })).statusCode).toBe(401);
    await app.close();
  });
});
