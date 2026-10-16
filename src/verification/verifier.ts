import { createHash } from "node:crypto";
import type { BrowserAdapter } from "../execution/browser-adapter.js";
import type { Criterion } from "./criteria.js";
import { extractCheckable, isOnPage } from "./grounding.js";

export interface CriterionResult {
  criterion: Criterion;
  passed: boolean;
  detail: string;
}

export interface VerificationResult {
  verdict: "verified" | "failed" | "inconclusive";
  results: CriterionResult[];
  evidence: { url: string; snapshotSha256: string; snapshotExcerpt: string } | null;
}

export interface Verifier {
  /** `claim` is the agent's own final summary: only `answer_grounded` looks at it, and only to look its values up on the page. */
  verify(criteria: Criterion[], claim?: string): Promise<VerificationResult>;
}

/** The plain URL / text criteria against a page. `answer_grounded` is about the agent's summary, not the page alone, so it is not here. */
export function pageMeets(criterion: Criterion, page: { url: string; ariaSnapshot: string }): boolean | null {
  if (criterion.kind === "url_contains") return page.url.includes(criterion.value);
  if (criterion.kind === "text_present") return page.ariaSnapshot.includes(criterion.value);
  return null;
}

/**
 * Checks criteria against live browser state read by this code, not against anything the model said.
 * Limitation: snapshot text is page-controlled, so a hostile page could display expected text.
 */
export class BrowserStateVerifier implements Verifier {
  constructor(private readonly browser: BrowserAdapter) {}

  async verify(criteria: Criterion[], claim?: string): Promise<VerificationResult> {
    if (criteria.length === 0) return { verdict: "inconclusive", results: [], evidence: null };
    let snap;
    try {
      snap = await this.browser.readState();
    } catch {
      return { verdict: "inconclusive", results: [], evidence: null };
    }
    const results = criteria.map((criterion): CriterionResult => {
      if (criterion.kind === "answer_grounded") return groundAnswer(criterion, claim ?? "", snap.ariaSnapshot);
      const passed = pageMeets(criterion, snap) === true;
      return { criterion, passed, detail: `${criterion.kind} "${criterion.value}": ${passed ? "found" : "not found"}` };
    });
    return {
      verdict: results.every((r) => r.passed) ? "verified" : "failed",
      results,
      evidence: {
        url: snap.url,
        snapshotSha256: createHash("sha256").update(snap.ariaSnapshot).digest("hex"),
        snapshotExcerpt: snap.ariaSnapshot.slice(0, 2000),
      },
    };
  }
}

/** Every checkable value in the agent's summary must be on the final page. A summary with none is not accepted: it proves nothing. */
function groundAnswer(criterion: Criterion, claim: string, page: string): CriterionResult {
  const items = extractCheckable(claim);
  if (items.length === 0) {
    return { criterion, passed: false, detail: "answer_grounded: the final summary states no number or double-quoted text that could be checked on the page" };
  }
  const missing = items.filter((i) => !isOnPage(i, page));
  if (missing.length > 0) {
    return { criterion, passed: false, detail: `answer_grounded: not found on the final page: ${missing.map((m) => `"${m.value}"`).join(", ")}` };
  }
  return { criterion, passed: true, detail: `answer_grounded: all ${items.length} stated value(s) found on the final page` };
}
