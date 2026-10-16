import type { Criterion } from "./criteria.js";
import { extractCheckable } from "./grounding.js";

const MAX_GOAL_CRITERIA = 3;

/**
 * Completion criteria worked out from the owner's goal by plain code, no model: every phrase the owner put in quotes
 * must be visible on the final page (`text_present`). Only the goal is read, never page content, so a page cannot
 * choose its own criteria. Addresses and bare numbers are not used: an address in a goal is where to start (true on
 * the first page), and a number is as often an input as a result.
 *
 * It is deliberately narrow. A goal with no quoted phrase yields nothing, and the task then ends `unverified` (or
 * uses what the plan proposes) rather than being checked against a guess. A phrase that is only typed or clicked and
 * never shown at the end makes the check fail, which is the safe direction.
 */
export function deriveGoalCriteria(goal: string): Criterion[] {
  return extractCheckable(goal)
    .filter((c) => c.kind === "quoted")
    .slice(0, MAX_GOAL_CRITERIA)
    .map((c) => ({ kind: "text_present" as const, value: c.value }));
}
