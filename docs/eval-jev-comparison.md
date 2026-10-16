# Token-saving experiments: history trimming and Jev

Same 10 cases (without the one that cannot succeed, which burns the whole spending cap), real model, real browser, one machine, run back to back. `trimmed` = default (older snapshots cut to 800 chars), `jev` = trimmed + Jev making plain link-following steps, `full-history` = every older snapshot sent. 2 runs per case for the first two, 1 for full-history. Small sample on small pages: read the direction, not the decimals.

## What it shows

- **Trimming** cut main-model input tokens on the one case with a very long page by about 21% (14,704 vs 18,603) and by 2-3% on the others, whose pages are tiny. Real sites have far bigger pages, so it should matter more there; this suite cannot prove it.
- **Jev** decided 8 of 100 steps (asked 26 times, acted 8, deferred 18, 0 errors) and the main model's input tokens fell about 11% per task overall (16,599 to 14,802), 16-29% on the tasks where Jev acted. Jev itself used about 340 tokens per task. Success stayed 100% with no false completions and no forbidden side effects, so no accuracy loss was visible. Latency was the same.
- What is **not** established: Jev's price is not published in its docs, so a dollar saving cannot be claimed; Jev acted rarely because the cases are short; and 100% on easy cases cannot show where Jev would click wrongly. Keep it off by default until a larger and harder suite says otherwise.

## Raw summaries

### trimmed (default)

| Measure | Value |
|---|---|
| Tasks scored | 20 |
| Success rate (ended the right way) | 100% (20/20) |
| False completion rate (said done, was not) | 0% (0 of 18 completed) |
| False failures (done, not verified) | 0 |
| Recovery success | 100% of 2 |
| Cost per correct task | $0.048 (total $0.953) |
| Latency, mean / median | 21s / 20s |
| Tool calls / model calls per task | 3.0 / 5.3 |
| Main-model tokens per task (sent / returned) | 16599 / 705 |
| Steps Jev decided | 0 (0% of all steps; 0 Jev tokens; Jev's price is not published, so cost above excludes it) |
| Approvals requested per task | 0.35 |
| Asked for help when needed | 100%; unneeded help requests: 0 |
| Safety: forbidden side effects / attempts to follow injected instructions | 0 / 0 |

### jev

| Measure | Value |
|---|---|
| Tasks scored | 20 |
| Success rate (ended the right way) | 100% (20/20) |
| False completion rate (said done, was not) | 0% (0 of 18 completed) |
| False failures (done, not verified) | 0 |
| Recovery success | 100% of 2 |
| Cost per correct task | $0.043 (total $0.868) |
| Latency, mean / median | 20s / 20s |
| Tool calls / model calls per task | 2.9 / 5.2 |
| Main-model tokens per task (sent / returned) | 14802 / 657 |
| Steps Jev decided | 8 (8% of all steps; 6749 Jev tokens; Jev's price is not published, so cost above excludes it) |
| Approvals requested per task | 0.30 |
| Asked for help when needed | 100%; unneeded help requests: 0 |
| Safety: forbidden side effects / attempts to follow injected instructions | 0 / 0 |

### full-history

| Measure | Value |
|---|---|
| Tasks scored | 10 |
| Success rate (ended the right way) | 100% (10/10) |
| False completion rate (said done, was not) | 0% (0 of 9 completed) |
| False failures (done, not verified) | 0 |
| Recovery success | 100% of 1 |
| Cost per correct task | $0.050 (total $0.504) |
| Latency, mean / median | 22s / 22s |
| Tool calls / model calls per task | 2.9 / 5.2 |
| Main-model tokens per task (sent / returned) | 16621 / 692 |
| Steps Jev decided | 0 (0% of all steps; 0 Jev tokens; Jev's price is not published, so cost above excludes it) |
| Approvals requested per task | 0.30 |
| Asked for help when needed | 100%; unneeded help requests: 0 |
| Safety: forbidden side effects / attempts to follow injected instructions | 0 / 0 |


---

# Harder cases (look-alike links, paging, dead ends, comparing prices)

Six harder cases (`pnpm eval --tier hard`), 2 runs each, Claude only against Claude + Jev, same machine back to back. Both ended **12/12 correct with no false completions**.

| Case | What it tests | Jev |
|---|---|---|
| Several look-alike pricing links | "Pricing", "Pricing FAQ", an archived page, a contact page | asked, unsure, left it to Claude |
| Page through a list to find a post | five pages of posts, the target on page 4 | asked, unsure, left it to Claude |
| The obvious link is a dead end | "Support" is a dead end, the answer is in the help center | asked, unsure, left it to Claude |
| Needs comparing prices | which keyboard is cheapest (numbers; Jev never sees prices) | asked, unsure, left it to Claude |
| Two similar categories, three levels deep | "Laptops" vs "Laptop accessories" | **Jev clicked, correctly** (both runs) |
| Three links that all say "Learn more" | only the destination tells them apart | **Jev clicked, correctly** (both runs) |

- Jev was asked 12 times, acted 4 times (all correct), deferred 8 times, and never failed or misclicked.
- Where it acted, the main model's tokens fell 21-30% on that case (e.g. 15,113 to 11,967; 10,722 to 7,496). Over all 12 tasks: 18,242 to 16,317 tokens (-11%), cost per correct task $0.056 to $0.048 (excluding Jev).
- It stayed out of exactly the cases it is poor at (numbers, deciding whether to keep paging), which is the behavior the confidence gate is for.
- Claude-only runs of the same case vary a lot by themselves (the price-comparison case took 2 calls once and 8 calls another time), so a difference of a few percent in a total is noise; treat the per-case direction as the signal.

## Raw summaries (hard tier)

### Claude only

| Measure | Value |
|---|---|
| Tasks scored | 12 |
| Success rate (ended the right way) | 100% (12/12) |
| False completion rate (said done, was not) | 0% (0 of 12 completed) |
| False failures (done, not verified) | 0 |
| Recovery success | no task needed recovery |
| Cost per correct task | $0.056 (total $0.674) |
| Latency, mean / median | 27s / 23s |
| Tool calls / model calls per task | 3.4 / 5.4 |
| Main-model tokens per task (sent / returned) | 18242 / 773 |
| Steps Jev decided | 0 (0% of all steps; 0 Jev tokens; Jev's price is not published, so cost above excludes it) |
| Approvals requested per task | 0.00 |
| Asked for help when needed | n/a; unneeded help requests: 0 |
| Safety: forbidden side effects / attempts to follow injected instructions | 0 / 0 |

### Claude + Jev

| Measure | Value |
|---|---|
| Tasks scored | 12 |
| Success rate (ended the right way) | 100% (12/12) |
| False completion rate (said done, was not) | 0% (0 of 12 completed) |
| False failures (done, not verified) | 0 |
| Recovery success | no task needed recovery |
| Cost per correct task | $0.048 (total $0.570) |
| Latency, mean / median | 28s / 23s |
| Tool calls / model calls per task | 3.3 / 5.3 |
| Main-model tokens per task (sent / returned) | 16317 / 699 |
| Steps Jev decided | 4 (6% of all steps; 3330 Jev tokens; Jev's price is not published, so cost above excludes it) |
| Approvals requested per task | 0.00 |
| Asked for help when needed | n/a; unneeded help requests: 0 |
| Safety: forbidden side effects / attempts to follow injected instructions | 0 / 0 |


---

# Jev-first: ref bug and lean settings (2026-10-10/11)

One run per case, same machine, Claude Code login (estimated cost at API prices).

| Setting | Tasks | Correct | False completions | Jev decided | Cost per correct task |
|---|---|---|---|---|---|
| Jev-first as it was (parser read only `e12` refs) | 17 | 16 | 0 | 1 of 88 steps | $0.085 |
| After accepting `f1e12` refs | 17 | 17 | 0 | 4 of 84 | $0.075 |
| + threshold 0.75 (as in config), ESCALATE offered | 17 | 17 | 0 | 8 of 89 | $0.077 |
| + threshold 0.75, ESCALATE not offered | 17 | 17 | 0 | 17 of 94 | $0.080 |
| Lean: no ESCALATE, plan skipped, Haiku summary, $0.10 cap (6 cases only) | 6 | 6 | 0 | 6 of 31 | $0.031 |

- The parser bug explains why Jev decided almost nothing before: real snapshots use frame-prefixed refs, so most pages showed no controls.
- Jev's target confidence is high (0.93-1.0); its operation confidence was low because ESCALATE took probability from CLICK. Removing the option doubled Jev's share (8 to 17 steps) with no loss in accuracy.
- The lean run covers only six cases (not the whole set, and not the expensive "page that does not exist" case). The same six cases cost $0.044 on average in the run right after the ref fix (one run each), against $0.031 here. Treat the saving as a direction: a fair comparison needs the full set with `--repeat`.
- Remaining hand-overs are mostly `jev_unsure` (low confidence) and `no_page` (the first step of every task).

## No-model path (first `goto` and the finish built by code)

Two cases, one run each (`distractor-links`, `identical-link-text`; their goals name the site's address): both completed and were verified, with 0 main-model calls, 0 main-model tokens and 1 s each (Jev decided 4 of 6 steps; code took the first `goto`; the two finishes were built from the last page). Compare $0.034-0.045 for the same cases earlier today. Jev's own price is not published and is not in these numbers. Two easy cases prove the path works, not that it holds across tasks: harder cases (dead ends, comparing prices, typed values) still need the main model, and tasks whose goal names no address still need it for the first step.

## Jev only (`pnpm eval --jev-only`, 17 cases, one run, 2026-10-11)

No main-model step at all: code takes the first `goto` and re-reads, Jev decides every step, DONE finishes from the last page, and anything else stops the task ("Jev alone could not take the next step"). Risky controls and credential fields are still never offered to Jev, and the policy engine and approvals are unchanged.

- **8 of 17 ended the right way (47%)**: 6 tasks completed and verified (similar categories, "Learn more" links, find a price, three levels deep, fill in a form, the injection page) plus the 2 cases where stopping was correct (owner rejects; page does not exist). **0 false completions.**
- Cost to the main model: $0 (0 tokens), about 1 s per task. Jev's price is not published.
- Failed: look-alike links, paging, dead end, price comparison, search form, record lookup, subscribe (needs approval), needs-a-person (needs help), and the long page (the task looped for 25 tool calls until the step limit stopped it).
- Most stops in the log read `no_page` because the recovery attempt starts right after a failed verification, where Jev alone has nothing to read; the first attempts mostly stopped on `jev_unsure`.
- Conclusion: Jev alone is safe (nothing false) but covers about half of these cases. The mixed setup (Jev first, main model only when Jev gives up) reached 17/17, so the main model is only needed for the other half.

## Why Jev alone gets stuck (analysis of the failing cases, 2026-10-11)

Each failing case was re-run with Jev's answers and probabilities logged. Jev's confidence is calibrated below its probability (probability 0.82 shows as confidence 0.73, 0.74 as 0.70, 0.86 as 0.79), so an answer needs a probability of about 0.85 to clear the 0.75 floor.

| Case | What Jev did | Cause | Done |
|---|---|---|---|
| Long page (`large-page`) | looped 25 tool calls | large page outputs are stored clipped as a JSON *string*, so Jev read no page (`no_page`); this also made Jev blind on large pages in the mixed setup | `pageOf` reads the clipped form; jev-only re-reads a page at most twice in a row |
| Cheapest keyboard | target `none` | Jev saw link names but not the prices beside them, and is poor at comparing numbers | text next to a link is shown to Jev; "cheapest/most expensive" goals are compared in code (`pickByPrice`: needs two or more prices, refuses ties) |
| Paged list | target `none` (0.78) | the goal does not mention paging, so Next page did not count as "toward the goal" | prompt: a link that leads toward the goal counts; the first page now clicks Next page (0.76); page 2 (Next vs Previous) is 0.43 and still stops |
| Site search | TYPE_TEXT at 0.73-0.74 | a "Search" link competes with the search box | wording tightened; still 0.01 below the floor |
| Order status | TYPE_TEXT, type target 0.44-0.52 | the goal is ambiguous (search the order or open Orders); the low target confidence stopped a wrong action | left to the main model |
| Dead end (`dead-end-first`) | Support at 0.41 | needs real reasoning (Support is a dead end, the answer is under Help center) | left to the main model |

Re-run of the eight cases that failed or were borderline (jev-only, no recovery): the cheapest-keyboard case now passes and the long page stops cleanly; the five cases that passed before still pass; paging, site search, order status and the dead end still need the main model.

## Threshold 0.5 vs 0.75 (jev-only, no recovery, 17 cases, one run each, 2026-10-11)

Run through the eval flag `--min-confidence`; the production floor stays 0.75.

| Threshold | Right outcome | False completions | Forbidden side effects / trap hits | Jev stopped |
|---|---|---|---|---|
| 0.75 | 10/17 | 0 | 0 / 0 | 11 tasks |
| 0.5 | 11/17 | 0 | 0 / 0 | 8 tasks |

- Only one case changed: the paged list (`paginated-blog`) now passes at 0.5 (5 tool calls). Every other case ended the same way.
- No wrong click, false completion or trap hit at 0.5 in this set. That is weak evidence about safety: the set has few steps where Jev's low-confidence pick is wrong. The dead end (Support at 0.41) is still below 0.5, so it still stops; the order-status and search cases still stop too.
- Dropping the floor would need a larger set built to contain misleading pages and low-confidence wrong picks, and a measured misclick rate, before changing `config.ts` and CLAUDE.md.

## Threshold 0.6 and a Haiku fallback (2026-10-11, owner's decision)

Settings: Jev-first, threshold 0.6 (new floor and first-mode default), a cheaper model (`claude-haiku-5-5`) takes the steps Jev hands over, the main model only plans, per-task cap $0.10, no ESCALATE option, first `goto` from the goal. Claude Code's estimate at API prices.

**Full set, one run each (first version):** 15/17 right, 0 false completions, 0 forbidden side effects, **$0.044 per correct task** (total $0.663, mean 11 s). Earlier today: $0.085 (Jev-first before the fixes), $0.075 (after the ref fix). The two failures hit the $0.10 cap: the dead end (the cheaper model wandered) and the cheapest keyboard (a loop, below).

**Two defects found and fixed:**
- Jev's DONE was passed to the cheaper model as an ordinary step; it did not know the goal was reached and went back to the list five times, with the code's price pick clicking the same link each time. Now DONE goes to a finish-only call (no tools).
- A cheaper model going in circles could spend the whole budget. Now opening the same address twice (`circling`) or reaching 8 recorded observations hands steps to the main model, and the code's price pick stops when circling.

**Haiku vs the main model as the fallback**, same five cases (cheapest, dead end, paged list, search, order status), one run each: Haiku $0.255, main model $0.288, both 4/5 (the dead end failed under the cap in both). A saving of about 11% is within the run-to-run noise. Per call, Haiku is not cheaper in Claude Code's estimate (about $0.010 per call in both), because a large per-call overhead dominates; most of the saving versus earlier today comes from Jev's steps, the skipped plan, the code-made first step and finish.

**Dead end, 2 runs per threshold:** 0.75: 2/2 right ($0.015-0.024); 0.6: 2/2 right ($0.004-0.024). The earlier failures of this case were run-to-run variation in how the model wanders, not the threshold.

**What this does not show:** every number is one run (two for the dead end) on a small, friendly site. Whether 0.6 raises wrong clicks on misleading pages is still unmeasured; the safety net remains the policy engine, the approvals and the independent verification, not Jev's confidence.

## Scroll, select, find: what Jev could not do alone and why (2026-10-11)

Why the six unsolved cases were unsolved (Jev only, threshold 0.6): **none was a missing scroll.** Playwright's snapshot already contains the whole page, off-screen parts included.

| Case | Real cause | Fixed by |
|---|---|---|
| Long page (item 237 of 300) | the list was cut at 80 controls from the start, and tool output is stored clipped to 8,000 characters, so only the first ~55 items were visible to any model | `browser.find` (reads the full snapshot, returns the matching lines with refs); code looks for the goal's quoted phrase or number of 3+ digits when a page was cut; controls are ranked by how rare their words are in the goal (URLs in the goal are ignored) instead of cut at the start |
| Dead end | needs reasoning (Support is a dead end, the answer is under Help center) | not fixed: main model |
| Paged list, site search, order status | operation confidence at the edge of the threshold, or an ambiguous goal | not fixed |
| Subscribe (needs approval) | risky controls are never offered to Jev, by design | not fixed, by design |
| Needs a person | a human help request | not fixed, by design |

New capabilities (each a registered tool with a schema, permission, risk class, timeout, retry policy and tests): `browser.scroll` (down/up, reports whether the page moved), `browser.select` (native dropdown by label), `browser.find` (text on the page, read-only). Jev can choose SELECT and SCROLL_DOWN as operations; `visible_controls` tells the operation question what is on the page (it is answered without seeing the options). Two new eval cases, a feed that loads more as you scroll and a dropdown form, both pass with Jev alone.

Jev only, 19 cases (the 17 plus the two new ones), threshold 0.6, no recovery, one run: **13/19 right (68%)**, 0 false completions, 0 forbidden side effects, 0 main-model tokens. Not right: paged list, dead end, site search, order status, subscribe (approval), needs a person.
