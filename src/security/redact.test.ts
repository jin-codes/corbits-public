import { describe, expect, it } from "vitest";
import { Redactor } from "./redact.js";

const r = new Redactor();

describe("Redactor", () => {
  it.each([
    ["key sk-ant-api03-abcdefghijklmnop here", "sk-ant-api03"],
    ["token ghp_abcdefghijklmnopqrstuvwx", "ghp_abcdefghijkl"],
    ["Authorization: Bearer abcdef0123456789abcdef", "abcdef0123456789"],
    ["AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGH"],
    ['{"password": "hunter2hunter2"}', "hunter2hunter2"],
    ["api_key=supersecretvalue123", "supersecretvalue123"],
  ])("scrubs %s", (input, leak) => {
    expect(r.redactString(input)).not.toContain(leak);
  });

  it("scrubs registered exact secrets even when no pattern matches", () => {
    const red = new Redactor().addSecret("correct-horse-battery");
    expect(red.redactString("the value is correct-horse-battery!")).toBe("the value is [REDACTED]!");
  });

  it("ignores very short registered secrets instead of mangling text", () => {
    const red = new Redactor().addSecret("abc");
    expect(red.redactString("abc def")).toBe("abc def");
  });

  it("deep-redacts objects without mutating the input", () => {
    const input = { a: ["Bearer abcdef0123456789abcdef"], b: { c: "ok", n: 1 } };
    const out = r.redact(input);
    expect(JSON.stringify(out)).not.toContain("abcdef0123456789");
    expect(out.b).toEqual({ c: "ok", n: 1 });
    expect(input.a[0]).toContain("abcdef0123456789");
  });

  it("leaves ordinary text alone", () => {
    expect(r.redactString("Click the Next button on https://example.com/page")).toBe(
      "Click the Next button on https://example.com/page",
    );
  });
});
