import { describe, expect, it } from "vitest";
import { extractCheckable, isOnPage } from "./grounding.js";

const values = (claim: string) => extractCheckable(claim).map((c) => `${c.kind}:${c.value}`);

describe("extractCheckable", () => {
  it("takes quoted text and numbers, and ignores lone digits", () => {
    expect(values('The Team plan costs $99/month and is called "Team Plus". Step 2 of 3.')).toEqual(["quoted:Team Plus", "number:99"]);
  });

  it("reads thousands separators and decimals as one number", () => {
    expect(values("Total 1,299.50 USD")).toEqual(["number:1299.50"]);
  });

  it("accepts curly and corner quotes, and does not double-count numbers inside a quotation", () => {
    expect(values("“Pro: $29/month” and 「월 3,900원」")).toEqual(["quoted:Pro: $29/month", "quoted:월 3,900원"]);
  });

  it("returns nothing for a summary that states nothing checkable, and caps the list", () => {
    expect(values("Done, I found it.")).toEqual([]);
    expect(extractCheckable(Array.from({ length: 50 }, (_, i) => `${i + 100}`).join(" "))).toHaveLength(20);
  });
});

describe("isOnPage", () => {
  const page = "Pricing\n  Pro: $1,999 / month\n  Team   plan\n  Version 3.14";
  it("matches numbers whole, regardless of thousands separators", () => {
    expect(isOnPage({ kind: "number", value: "1999" }, page)).toBe(true);
    expect(isOnPage({ kind: "number", value: "99" }, page)).toBe(false); // part of 1999
    expect(isOnPage({ kind: "number", value: "3.14" }, page)).toBe(true);
    expect(isOnPage({ kind: "number", value: "14" }, page)).toBe(false); // part of 3.14
  });
  it("matches quoted text ignoring case and whitespace", () => {
    expect(isOnPage({ kind: "quoted", value: "team plan" }, page)).toBe(true);
    expect(isOnPage({ kind: "quoted", value: "Enterprise" }, page)).toBe(false);
  });
});
