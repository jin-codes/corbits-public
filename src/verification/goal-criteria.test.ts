import { describe, expect, it } from "vitest";
import { deriveGoalCriteria } from "./goal-criteria.js";

describe("deriveGoalCriteria", () => {
  it("turns each quoted phrase in the goal into a text_present criterion", () => {
    expect(deriveGoalCriteria('Open the pricing page and find "Pro plan" and “Team plan”')).toEqual([
      { kind: "text_present", value: "Pro plan" },
      { kind: "text_present", value: "Team plan" },
    ]);
  });

  it("works for Korean goals with Korean quotes", () => {
    expect(deriveGoalCriteria("가격 페이지에서 「프로 요금제」를 찾아줘")).toEqual([{ kind: "text_present", value: "프로 요금제" }]);
  });

  it("yields nothing when the goal quotes nothing: addresses and bare numbers are not criteria", () => {
    expect(deriveGoalCriteria("Go to https://example.com/pricing and find the price of item 12345")).toEqual([]);
  });

  it("keeps at most three phrases", () => {
    expect(deriveGoalCriteria('"aa" "bb" "cc" "dd"')).toHaveLength(3);
  });
});
