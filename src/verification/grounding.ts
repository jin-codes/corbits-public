/**
 * Checks that the values an answer states can actually be found on a page. This does not decide whether the
 * answer is right or whether it responds to the question: it only catches values that appear nowhere on the page
 * (made up, misread, carried over from another page). Pure code, no model.
 */

const MAX_VALUES = 20;
const QUOTES: Array<[string, string]> = [
  ['"', '"'],
  ["“", "”"],
  ["‘", "’"],
  ["「", "」"],
  ["『", "』"],
];

export interface Checkable {
  kind: "number" | "quoted";
  value: string;
}

/** Collapses whitespace and case, and removes thousands separators inside numbers ("1,299" -> "1299"). */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/(?<=\d),(?=\d{3}(?!\d))/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * The values in an answer that can be looked up: quoted phrases, and numbers of two or more digits or with a decimal
 * point (a lone digit such as "step 2" says nothing). Quoted text is searched for first and removed, so a number
 * inside a quotation is checked as part of the phrase.
 */
export function extractCheckable(claim: string): Checkable[] {
  const found: Checkable[] = [];
  let rest = claim;
  for (const [open, close] of QUOTES) {
    const re = new RegExp(`${escape(open)}([^${escape(open)}${escape(close)}\\n]{2,200})${escape(close)}`, "g");
    rest = rest.replace(re, (_m, inner: string) => {
      found.push({ kind: "quoted", value: inner.trim() });
      return " ";
    });
  }
  const numbers = normalizeForMatch(rest).match(/\d+(?:\.\d+)?/g) ?? [];
  for (const n of numbers) if (n.includes(".") || n.length >= 2) found.push({ kind: "number", value: n });
  const seen = new Set<string>();
  return found
    .filter((c) => c.value.length > 0 && !seen.has(`${c.kind}:${c.value}`) && !!seen.add(`${c.kind}:${c.value}`))
    .slice(0, MAX_VALUES);
}

/** Is the value on the page? Numbers must not be part of a longer number ("99" is not found in "1999"). */
export function isOnPage(item: Checkable, page: string): boolean {
  const hay = normalizeForMatch(page);
  const needle = normalizeForMatch(item.value);
  if (item.kind === "quoted") return hay.includes(needle);
  const re = new RegExp(`(?<![\\d.])${needle.replace(/\./g, "\\.")}(?![\\d]|\\.\\d)`);
  return re.test(hay);
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
