# Comparison with browser-use/jev-ultrafast

Source: the README of https://github.com/browser-use/jev-ultrafast, read on 2026-10-11. The source code was not read, so anything the README does not state is marked "not stated". Corbits' numbers are in `docs/eval-jev-comparison.md`.

## Different goals

jev-ultrafast is a fast browser execution engine: one Jev request per step, as little as possible between the page and the click. Corbits is an agent platform: the same kind of step decision, but under a policy engine, human approvals, independent verification, persistence, recovery and notifications. They are not substitutes; parts of the first can feed the second.

## Side by side

| | jev-ultrafast | Corbits |
|---|---|---|
| Decision per step | one Jev request returns an operation and its target; only the chosen operation's target runs | the same (`JevFirstModel`); the main model or a cheaper fallback takes steps Jev hands over |
| Operations | CLICK, TYPE_TEXT, SELECT, SCROLL_UP, SCROLL_DOWN, WAIT, DONE, BLOCKED | CLICK, TYPE_TEXT, SELECT, SCROLL_DOWN, DONE (plus code-made steps: first `goto`, `find`, price pick) |
| Typed text | a small LLM (`mercury-2.5` in the demo) writes it as a JSON object | cut word for word out of the owner's goal; `TextWriter` slot exists but is not filled |
| When unsure | BLOCKED exists; when Jev picks it is not stated | below the confidence floor (0.6) the step goes to the next model; risky cases are handed over by code first |
| Risky actions | no approval flow stated | policy engine and human approval; risky controls are never offered to Jev |
| Prompt injection | no defence stated | page text is untrusted data; typed values come from the goal only |
| Success | DONE "still requires independent outcome verification" (how: not stated) | the verifier reads live browser state itself and records evidence |
| Infrastructure | the user's own Chrome profile, Python package | Docker sandbox with an egress proxy, Postgres, approvals, email |
| Out of scope | shadow DOM, iframes, canvas, uploads, pop-ups, nested scrolling, arbitrary keyboard widgets | similar, plus no desktop execution |
| Speed claim | about 7 s for a flights search; browser protocol calls 1,092 to 101; median 9.45 s to 7.09 s (three runs of one task) | 11 s mean for the mixed setup, about 1 s for Jev alone (17-19 easy cases, one run each) |
| Cost | no per-task cost, tokens or prices stated | about $0.044 per correct task (mixed setup, Claude Code's estimate); Jev's price is not published, so it is not included |

## What Corbits has that the README does not mention

Approvals and a policy engine, independent verification with recorded evidence, an injection-aware trust boundary, a sandboxed browser, persistence and recovery, notifications, and an evaluation harness that measures false completions and cost on the same cases.

## What to take from jev-ultrafast (recorded decisions)

In priority order. None of this was implemented in the commit that records it.

1. **Re-check the target just before acting.** Reject a click when the page changed or the element is covered by another one, and use the element's current position. Corbits only rejects stale refs today. This is a safety gain, not just speed. Where: `PlaywrightBrowser.resolve` / `click`. **Checked 2026-10-11:** most of this already holds. A ref whose element was renamed is refused (existing test), and Playwright's own `click` waits for the target to be visible, stable and not covered, then fails without clicking anything; a new test (`does not click a target that another element covers`) pins that down. Not covered: an element that moves between the check and the click (Playwright rechecks just before the click, so the window is tiny). No code change was needed.
2. **Let a small model write derived values.** Dates in a field's format, translations and similar values cannot be cut out of the goal. Fill the existing `TextWriter` slot with a small model whose output must parse as a small JSON object before it is typed, and reuse a generated value on a stale-page retry only when its input is unchanged. The goal-cut path stays first (it is the safer one).
3. **More operations: WAIT and SCROLL_UP**, and a BLOCKED-style "cannot continue" outcome for Jev-only runs (today it stops with a plain finish). Offer each only where it applies.
4. **Fewer browser round trips and shorter waits**: read the page in one call and wait on conditions (up to about 200 ms for suggestions, otherwise a frame or two) instead of load states. Only worth doing once model calls are no longer most of a task's time; today they are.
5. **A step-by-step inspector** that pauses before executing so a person can watch Jev's choices. Corbits has the event log and live view but no "choose next" pause.

Not taken: sharing the user's own Chrome profile as the default (Corbits keeps the sandbox; own-Chrome mode stays opt-in and local).

## Caveats

- The speed and protocol-call figures are the project's own, from one task on one profile, and the README says they are not a general reliability benchmark.
- No cost figures are given, so a cost comparison is not possible from the README.
- Corbits' numbers are one run per case on a small, friendly test site.
