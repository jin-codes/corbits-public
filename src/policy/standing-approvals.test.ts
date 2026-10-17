import { describe, expect, it } from "vitest";
import { MAX_AUTO_APPROVALS, StandingApprovalsSchema, matchStandingApproval, standingApprovalsOf } from "./standing-approvals.js";

const grant = { tool: "browser.click" as const, origin: "https://blog.example.com", names: ["Publish now", "Continue"] };
const target = (over: Record<string, unknown> = {}) => ({ ref: "e1", tag: "button", name: "Publish now", role: "button", download: false, ...over });
const PAGE = "https://blog.example.com/publish/post/123";

describe("standing approval matching", () => {
  it("matches a click on a listed control on the named origin, ignoring case and padding", () => {
    expect(matchStandingApproval([grant], "browser.click", target(), PAGE)).toEqual({ origin: "https://blog.example.com", name: "Publish now" });
    expect(matchStandingApproval([grant], "browser.click", target({ name: "  CONTINUE " }), PAGE)).toMatchObject({ name: "CONTINUE" });
  });

  it("does not match another control, a near-miss name, or a partial name", () => {
    for (const name of ["Delete post", "Publish", "Publish now and email everyone", "Send"]) {
      expect(matchStandingApproval([grant], "browser.click", target({ name }), PAGE)).toBeNull();
    }
  });

  it("does not match another origin, a subdomain, a different scheme or an unreadable page", () => {
    for (const page of ["https://evil.example.com/", "https://blog.example.com.evil.net/", "http://blog.example.com/", "https://example.com/", "not a url", undefined]) {
      expect(matchStandingApproval([grant], "browser.click", target(), page)).toBeNull();
    }
  });

  it("does not match another tool, a download, a nameless target or a missing inspection", () => {
    expect(matchStandingApproval([grant], "browser.type", target(), PAGE)).toBeNull();
    expect(matchStandingApproval([grant], "browser.click", target({ download: true }), PAGE)).toBeNull();
    expect(matchStandingApproval([grant], "browser.click", target({ name: "" }), PAGE)).toBeNull();
    expect(matchStandingApproval([grant], "browser.click", undefined, PAGE)).toBeNull();
  });

  it("with no grants nothing matches", () => {
    expect(matchStandingApproval([], "browser.click", target(), PAGE)).toBeNull();
  });
});

describe("standing approval grants", () => {
  it("accept an https origin with or without a trailing slash, one to three grants", () => {
    expect(StandingApprovalsSchema.safeParse([grant]).success).toBe(true);
    expect(StandingApprovalsSchema.safeParse([{ ...grant, origin: "https://blog.example.com/" }]).success).toBe(true);
    expect(StandingApprovalsSchema.safeParse([grant, grant, grant]).success).toBe(true);
  });

  it("refuse http, a path, another tool, no names, too many names or grants, and unknown fields", () => {
    const bad = [
      [{ ...grant, origin: "http://blog.example.com" }],
      [{ ...grant, origin: "https://blog.example.com/publish" }],
      [{ ...grant, tool: "browser.type" }],
      [{ ...grant, names: [] }],
      [{ ...grant, names: Array.from({ length: 9 }, (_, i) => `n${i}`) }],
      [grant, grant, grant, grant],
      [],
      [{ ...grant, anyOrigin: true }],
    ];
    for (const b of bad) expect(StandingApprovalsSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });

  it("are read from stored constraints, and a malformed value grants nothing", () => {
    expect(standingApprovalsOf({ standingApprovals: [grant] })).toEqual([grant]);
    expect(standingApprovalsOf({})).toEqual([]);
    expect(standingApprovalsOf({ standingApprovals: "yes" })).toEqual([]);
    expect(standingApprovalsOf({ standingApprovals: [{ ...grant, origin: "http://x.com" }] })).toEqual([]);
  });

  it("are capped in how often they can be used", () => {
    expect(MAX_AUTO_APPROVALS).toBe(8);
  });
});
