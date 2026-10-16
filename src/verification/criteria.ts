import { z } from "zod";

/**
 * Observable completion criteria, checked by deterministic code against browser state.
 * The model may propose criteria, but it never decides whether they were met.
 */
export const CriterionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url_contains"), value: z.string().min(1).max(500) }),
  z.object({ kind: z.literal("text_present"), value: z.string().min(1).max(500) }),
  /**
   * For tasks whose result is an answer (look something up, read a value): the numbers and quoted text in the agent's
   * final summary must all be found on the final page. It checks that stated values are on the page, not that the answer
   * is right. No value: the thing checked is the agent's own summary.
   */
  z.object({ kind: z.literal("answer_grounded") }),
]);
export type Criterion = z.infer<typeof CriterionSchema>;

/** How a criterion is put to the model: it must know what it has to leave on the page and in its summary. */
export function criterionForModel(c: Criterion): string {
  if (c.kind === "answer_grounded") return "answer_grounded: your final summary must state the requested values exactly as they appear on the final page (numbers as shown, names in double quotes); every number and quoted text in it is looked up on that page";
  return `${c.kind}: ${c.value}`;
}

export const CriteriaSchema = z.array(CriterionSchema).max(20);
