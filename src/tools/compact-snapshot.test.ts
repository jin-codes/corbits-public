import { describe, expect, it } from "vitest";
import { compactSnapshot } from "./browser-tools.js";

const page = [
  "- iframe [active] [ref=e2]:",
  "  - generic [ref=f1e1]:",
  "    - paragraph [ref=f1e2]",
  "    - paragraph [ref=f1e3]",
  "    - paragraph [ref=f1e4]",
  '    - link "Next" [ref=f1e5] [cursor=pointer]:',
  '      - /url: "https://a.example/?x=1&y="',
  "    - paragraph [ref=f1e6]: Real text",
  "    - generic [ref=f1e7]",
].join("\n");

describe("compactSnapshot", () => {
  const out = compactSnapshot(page);

  it("halves the indentation and folds runs of empty nodes into one line", () => {
    expect(out.split("\n")).toEqual([
      "- iframe [active] [ref=e2]:",
      " - generic [ref=f1e1]:",
      "  - (3 empty elements)",
      '  - link "Next" [ref=f1e5] [cursor=pointer]:',
      '   - /url: "https://a.example/?x=1&y="',
      "  - paragraph [ref=f1e6]: Real text",
      "  - (1 empty element)",
    ]);
  });

  it("keeps every ref of a node that has a name, text, attributes or children, and every address as is", () => {
    for (const ref of ["e2", "f1e1", "f1e5", "f1e6"]) expect(out).toContain(`[ref=${ref}]`);
    expect(out).toContain('"https://a.example/?x=1&y="');
  });

  it("keeps the relative depth of every kept line", () => {
    const lead = (l: string) => l.length - l.trimStart().length;
    const kept = page.split("\n").filter((l) => !/^\s*- (paragraph|generic) \[ref=[^\]]+\]$/.test(l));
    const before = kept.map((l) => lead(l) / 2);
    const depth = (s: string) => s.split("\n").filter((l) => !l.includes("empty element")).map(lead);
    expect(depth(out)).toEqual(before);
  });

  it("is a no-op shortening only: a short flat page keeps all its lines", () => {
    expect(compactSnapshot('- link "A" [ref=e1]\n- button "B" [ref=e2]')).toBe('- link "A" [ref=e1]\n- button "B" [ref=e2]');
  });

  it("makes the snapshot of a deep, mostly empty page clearly shorter", () => {
    const deep = Array.from({ length: 300 }, (_, i) => `${" ".repeat(20)}- paragraph [ref=e${i}]`).join("\n");
    expect(compactSnapshot(deep).length).toBeLessThan(deep.length / 50);
  });
});
