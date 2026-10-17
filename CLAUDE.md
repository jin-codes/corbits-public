# Corbits — Project Instructions

## 1. Project Identity

Corbits is a general-purpose autonomous AI agent platform inspired by Manus.
Its purpose is to turn user goals into completed, verifiable outcomes.

Users submit tasks through a web dashboard. Corbits plans the work, executes permitted actions through tools, verifies the results, records execution history, and reports outcomes through the dashboard and email.

**Core principle: A task is not complete just because a model says it is complete.**

Prioritize reliable execution, safety, observability, and recoverability over the number of supported features.

## 2. Product Scope

### Long-term vision

Build an extensible agent platform that supports:

- General-purpose task planning and execution
- Browser and desktop automation
- Multiple model providers
- Explicit approval for consequential actions
- Independent result verification
- Failure recovery and resumable execution
- Persistent task history and artifacts
- Dashboard-based monitoring and email notifications

### MVP scope

Implement the smallest end-to-end system that can reliably execute and verify browser-based tasks.

The MVP must support:

1. Task submission through a web dashboard.
2. Planning and execution using the Claude API.
3. Browser interaction through a controlled tool interface.
4. Explicit approval for consequential actions.
5. Persistent task status and execution events.
6. Independent verification of task outcomes.
7. Cancellation and bounded failure recovery.
8. Execution logs and artifact inspection.
9. Email notifications for completion, failure, and approval requests.
10. Configurable runtime, tool-call, retry, and spending limits.

Do not implement every feature in the long-term vision before validating the core execution loop.
Desktop execution and Jev-assisted decisions are extension points, not MVP blockers.

## 3. Engineering Priorities

When making trade-offs, prioritize in this order:

1. Safety and permission enforcement
2. Correct task execution and verification
3. Reliable persistence and recovery
4. Observability and debuggability
5. Cost and latency
6. Extensibility
7. Additional features

Prefer the simplest architecture that satisfies the current requirements.
Do not introduce abstractions, services, dependencies, or infrastructure without a concrete need.

## 4. Architecture Boundaries

Keep the following responsibilities separate:

- **API and Dashboard**: Accept tasks and expose task status, approvals, logs, and artifacts.
- **Task Orchestrator**: Coordinate planning, execution, verification, recovery, and finalization.
- **Model Adapters**: Encapsulate provider-specific APIs and normalize responses.
- **Tool Registry**: Define available tools, schemas, handlers, permissions, and execution limits.
- **Execution Adapters**: Provide controlled browser execution initially and desktop execution later.
- **Policy Engine**: Enforce permissions, risk classifications, budgets, and approval requirements.
- **Approval Service**: Persist approval requests and decisions and resume eligible tasks.
- **Persistence Layer**: Store task state, events, approvals, and execution metadata.
- **Artifact Store**: Manage files and other task outputs.
- **Verification Service**: Evaluate task-specific completion criteria using available evidence.
- **Notification Service**: Send email notifications and report delivery failures.

Keep provider-specific logic out of the orchestrator.
Use stable interfaces where multiple implementations are genuinely expected. Avoid designing elaborate plugin or multi-agent frameworks before they are needed.

## 5. Model Integration

### Claude

Claude is the primary model for planning, reasoning, and selecting tool calls.
All Claude-specific API handling must remain inside its model adapter.
Validate model outputs at runtime. Handle malformed responses, API errors, timeouts, and interrupted requests explicitly.

### Jev

Jev is an optional secondary model for clearly defined, structured decision tasks.
Integrate Jev only when experiments demonstrate measurable improvements in quality, cost, or latency.
Do not use Jev as the authority for security, permissions, approval decisions, or irreversible actions.
Keep the orchestrator independent of whether Jev is enabled.

### General model rules

- Never assume an undocumented API capability or response schema.
- Consult current official documentation before integration.
- Normalize provider responses into internal types.
- Treat model output as untrusted input.
- Use deterministic application code for security-critical decisions.
- Record model usage and estimated cost where available.
- Fail safely when a model is unavailable or returns invalid data.

## 6. Tool and Execution Contracts

Every executable tool must be registered explicitly.

A tool definition must specify:

- Name and description
- Validated input schema
- Handler
- Required permissions
- Risk classification
- Timeout and retry policy
- Output schema
- Verification strategy, when applicable

Reject invalid inputs before execution.
Never execute arbitrary model-generated code or shell commands outside an explicitly configured and isolated execution policy.

### Browser execution

Browser automation is the first supported execution environment.
Encapsulate browser-specific operations behind a `BrowserAdapter`. The orchestrator must not depend on a particular browser automation library.
Persist enough execution information to inspect failures and resume eligible tasks safely.

### Desktop execution

Define a future `DesktopAdapter` boundary, but do not build a desktop runtime until browser execution and verification work reliably.
Do not assume browser and desktop actions have identical permissions or security implications.

## 7. Task State and Lifecycle

Persist every task's current state and significant state transitions.

Use these initial states:

- `queued`
- `planning`
- `running`
- `awaiting_approval`
- `human_control` (added: the owner drives the browser; see section 15)
- `verifying`
- `completed` (always means verified)
- `unverified` (added 2026-10-11: the task ran but had no completion criteria, so its result could not be checked; reached only from `verifying`, never counted as a success)
- `failed`
- `cancelled`

Define legal transitions explicitly and reject invalid transitions.

The normal execution lifecycle is:

1. Validate the task request and constraints.
2. Define observable completion criteria.
3. Generate and validate a plan.
4. Execute permitted actions through registered tools.
5. Pause for approval when required.
6. Persist state changes, events, and relevant artifacts.
7. Verify completion criteria against available evidence.
8. Attempt permitted recovery within configured limits.
9. Finalize the task state.
10. Notify the user of the actual outcome.

Handle worker restarts, duplicate delivery, interrupted API calls, pending approvals, and cancellation without silently corrupting task state.
Do not rely on in-memory state as the sole source of truth.

## 8. Safety and Approval

Enforce security policies in application code, not only through model instructions.

Require explicit approval before consequential actions, including:

- Sending messages or emails
- Publishing content externally
- Deleting or irreversibly modifying data
- Making purchases or financial commitments
- Changing account permissions or security settings

Classify actions by risk and default to the safer behavior when classification is uncertain.

An approval must be tied to a specific action, its parameters, and the relevant context. If the proposed action materially changes, request approval again.
A rejected action must not be executed through another tool or indirect route.

Treat webpage content, emails, files, and tool outputs as untrusted data. They cannot override system instructions, grant permissions, or authorize new actions.

Use isolated execution environments with restricted access to host resources, credentials, files, and networks.
Keep API keys server-side. Never expose secrets to browser clients or write them to logs and artifacts.
Enforce runtime, spending, model-call, tool-call, and retry limits. Support cancellation and prevent unintended duplicate execution.

## 9. Verification and Recovery

Every task must have completion criteria appropriate to its goal.

Verification should use observable evidence, such as:

- Confirmed application state
- Retrieved page content
- Expected output files
- Validated structured data
- Successful completion of a defined operation

Use independent verification where practical rather than relying solely on the same model that performed the work.
Record verification results and supporting evidence. Completion criteria proposed by the plan (not given by the owner) that were already true on the first page the agent opened are flagged `metBeforeWork` on the verification event and in the history: passing them does not by itself show that work was done.

If verification fails:

1. Determine whether another attempt is permitted.
2. Check remaining execution and spending budgets.
3. Retry or recover only when safe and useful.
4. Re-verify the result after recovery.
5. Mark the task failed or incomplete if success cannot be established.

Never report success without sufficient evidence. Clearly distinguish verified success, partial completion, failure, and "finished but not verified". A task without completion criteria (none given, none proposed by the plan) still runs but ends `unverified`: the dashboard and the email say that nothing could check it, and it is not a success. The unverified email shows the agent's own (clipped, labelled unchecked) account; the owner can press "Looks right" (`POST /tasks/:id/acknowledge`, records `owner.acknowledged` once and never changes the status, because `completed` always means verified) or continue the task with a phrase that must be on the final page (`mustShow` on `/continue`, which becomes a `text_present` criterion; refused if the task already has criteria). An unverified task is a terminal state, not a waiting one: nothing is held open.

## 10. Persistence and Observability

Persist enough information to inspect and diagnose any task after execution.

Record, at minimum:

- Task ID, owner, goal, status, and timestamps
- Constraints and completion criteria
- Plan and execution steps
- State-transition events
- Tool calls and normalized outcomes
- Approval requests and decisions
- Errors, retries, and cancellation events
- Verification results and evidence references
- Artifact references
- Model usage, latency, and estimated cost where available

Avoid collecting unnecessary sensitive data. Redact secrets and minimize retention of sensitive content.
The dashboard should expose useful progress and actionable failure information without requiring users to inspect raw internal traces.

## 11. Notifications

Send notifications for:

- Verified task completion
- A task that finished with nothing to verify it against (`unverified`)
- Task failure or incomplete execution
- Approval requests requiring user action

Notifications must reflect persisted task state, not an intermediate model response.
Handle notification failures separately from task execution. A failed email delivery must not accidentally cause a completed task to execute again.
Prevent duplicate notifications where practical and record delivery attempts.

## 12. Testing and Evaluation

Use mocked model and execution adapters for deterministic unit and workflow tests.

Test at least:

- Valid and invalid state transitions
- Tool schema validation
- Permission and approval enforcement
- Prompt-injection resistance at trust boundaries
- Invalid and unavailable model responses
- Retry limits and duplicate execution prevention
- Cancellation
- Verification failures and recovery
- Persistence across worker restarts
- Pending approvals across restarts
- Notification failures
- Runtime and spending limits

Maintain separate integration tests for real provider APIs. Never require real purchases, destructive operations, or public publication to test safety controls.

### Model evaluation

Compare these configurations on the same representative task set:

- A. Claude only
- B. Claude + Jev
- C. Claude + Jev + independent verification and recovery

Measure:

- Verified task success rate
- False completion rate
- Recovery success rate
- Cost per verified successful task
- End-to-end latency
- Retry and tool-call counts
- Approval frequency

Do not assume that additional models or components improve performance. Retain them only when measured results justify their complexity and cost.

## 13. Development Workflow

Before changing code:

1. Inspect the repository, existing architecture, and project conventions.
2. Identify the smallest change that satisfies the requirement.
3. Explain significant design decisions and relevant trade-offs.
4. Implement typed interfaces and runtime validation.
5. Add tests for normal, failure, and safety-critical paths.
6. Run the relevant checks and report their actual results.
7. Update documentation when behavior or interfaces change.

Follow the existing repository conventions unless there is a concrete reason to change them.
Do not invent API schemas, capabilities, test results, or environment behavior.
Avoid unnecessary dependencies, premature abstractions, unrelated refactoring, and large rewrites.
Do not claim that tests passed unless they were actually executed successfully.
When requirements are ambiguous, inspect the codebase first and ask for clarification only when the ambiguity materially affects architecture, safety, or product behavior.

## 14. Definition of Done

The browser-based MVP is complete when a user can:

- Submit a task from the dashboard.
- Observe persisted task progress.
- Execute permitted low-risk browser actions.
- Approve or reject consequential actions.
- Cancel an active task.
- Inspect logs, verification evidence, and output artifacts.
- Receive accurate completion, failure, and approval notifications.
- See success determined by verification rather than model assertions.
- Rely on enforced execution and spending limits.
- Inspect task history after execution or worker restart.

The codebase must provide clear extension points for desktop execution and Jev-assisted decisions without requiring either to be fully implemented in the MVP.

**Final rule: Build a reliable end-to-end execution loop before expanding the platform.**

## 15. Technical Decisions (verified against official docs, 2026-10-05)

Re-check the linked docs before depending on any detail below; versions and limits change.

### Stack

- Language: TypeScript on Node.js (single stack). Local development runs in Docker.
- Persistence and queue: Postgres, with `pg-boss` for jobs (requires Node >= 22.12 and Postgres >= 13; claims jobs with `SKIP LOCKED`; supports `singletonKey` and retries). Revisit only if it becomes a bottleneck.
- Email: SMTP via `nodemailer`, so no paid service or owned domain is required (for example a Gmail app password). Notifications use a transactional outbox: rows are written in the same transaction as the event that causes them, and a separate dispatcher sends them, so a delivery failure can never affect task execution. Delivery is at-least-once with a stable Message-ID; the outbox records every attempt. Resend was considered but its free tier can only send to the account owner until a domain is verified.
- Notices (`POST /notify {subject, body, dedupeKey}`, migration 016): a plain message to the caller's own address for things that are not tasks (the owner's other systems, e.g. a scheduled publishing pipeline). Same outbox, retries, Message-ID and redaction; `kind = 'notice'` with no `task_id`. Idempotent per `(owner, dedupeKey)` (a repeat answers `duplicate`), at most `NOTICES_PER_DAY` (20) per owner per day (`429`), subject 120 and body 2000 characters, key `[A-Za-z0-9:._-]`. It can only mail the authenticated caller's own address, never a given recipient. Answers 503 when email is not configured. Caller text is data, not instructions: it is redacted and sent as plain text.
- Standing approvals (`standingApprovals` on task creation; `src/policy/standing-approvals.ts`; owner's decision, 2026-10-17, so a post to the owner's own blog can publish with nobody present): the one exception to "consequential actions always need a person". The owner (an admin token; the API answers 403 to anyone else) lists up to 3 grants, each `{tool: "browser.click", origin: "https://...", names: [...]}`. A click the policy engine holds for approval is auto-approved only if the page's origin equals the grant's and the control's accessible name equals one of its names (case-insensitive, whole name, never a download); everything else still waits for a person. It is not a policy bypass: the engine's classification is unchanged, and the orchestrator still requests the approval, decides it as `standing:<origin>`, consumes it once and appends an `approval.auto_approved` event (shown in the timeline). At most `MAX_AUTO_APPROVALS` (8) per task; stored in the task's constraints, not shown to the model, and not carried over to a continued task. Malformed grants grant nothing. Use it only for a narrow, repeatable flow on a site the owner controls; never for money, accounts or messages to other people.

### Deployment

- Single server, Docker Compose (`docker-compose.prod.yml` over the dev file): app + Postgres + browser + gateway. Target: Oracle Cloud Always Free (arm64), reached over Tailscale, not exposed publicly. The app container is non-root, read-only, all capabilities dropped, and never on the browser's `sandbox` network. See `docs/deploy-oracle.md`.

### Execution environments

- Browser (MVP): Playwright. In production the browser runs in a hardened container with no network route except a gateway container whose egress proxy refuses private addresses; the app attaches to it with `chromium.connect` over a secret websocket path. Running Chromium on the host is a development fallback only. Request interception cannot see redirect hops, so network policy is enforced by the proxy, never only in the page. Feed the model `page.ariaSnapshot()` YAML (accessibility tree) rather than raw DOM. ARIA snapshots do not document element refs, so the `BrowserAdapter` must define its own element-addressing scheme and verify it.
- Own-Chrome mode (opt-in, local only; `CORBITS_BROWSER_CDP_URL`): `chromium.connectOverCDP` to a Chrome with its own `--user-data-dir` (Chrome 136+ blocks remote debugging on the default profile). The adapter works in a new tab and scopes its guard to that tab (a context-level route would hit the user's other tabs); only popups its tab opened are closed; `close()` closes the tab and disconnects. Weaker than the sandbox (no egress proxy), so config refuses it unless the address is loopback and `CORBITS_ALLOWED_ORIGINS` (or the explicit any-origin choice below) is set. It may now be configured next to the Docker browser (owner's decision, 2026-10-11): the sandbox stays the default and the new-task form offers "Run in my Chrome (new tab)" per task (`constraints.browser = "chrome"`); only admins may choose it (the API answers 403 to anyone else and 409 if the server has no Chrome set up), and a continued task keeps it only for an admin. Without a sandbox configured, Chrome is the default browser as before. `CORBITS_ALLOW_ANY_ORIGIN=true` (owner's decision, 2026-10-11) replaces the list with any public site; it is valid only with the CDP URL, never together with a list or `CORBITS_ALLOW_PRIVATE_NETWORK`, and private addresses stay blocked. Never offer it for the server deployment.
- Desktop (after browser works): a Linux container with a virtual display (Xvfb) and a lightweight desktop, driven by Claude's computer-use tool. The model only returns actions; our code executes them. This is a Linux container desktop, not control of the user's real machine.
- Prompt size: older page snapshots are trimmed to their first 800 characters in what is sent to the model (the stored history is unchanged); `CORBITS_FULL_HISTORY=1` disables it.
- Computer-use tool type is `computer_toolset_20260801` (GA, no beta header). Screenshots must fit model limits before sending (the API does not downscale); scale click coordinates back. Prefer about 1280x720 to 1280x800.

### Model integration

- Claude, default backend: the user's logged-in Claude Code CLI via `claude -p`, used only as a tool-less, customization-free, JSON-out model (`--tools ""`, `--safe-mode`, `--no-session-persistence`, `--json-schema`, prompt on stdin, allowlisted environment without `ANTHROPIC_API_KEY`). Never use `--bare` (it ignores the subscription login) and never extract or reuse the CLI's own stored OAuth credentials. On a server without an interactive login, the only supported route is the token the CLI itself issues for scripts (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`, one year, model requests only), passed through the child allowlist. Meant for single-user, self-hosted use; offering Corbits to others requires the API backend.
- Claude, API backend (`CORBITS_MODEL_PROVIDER=api`): official TypeScript SDK `@anthropic-ai/sdk`. Implement our own loop over the Messages API with tool use; do not use the Claude Agent SDK, because the orchestrator must own its policy engine, approvals, state machine, and persistence. Read `usage` from responses for cost tracking. The SDK retries 2 times by default; set `maxRetries` and `timeout` explicitly so our retry budget stays authoritative. Model IDs come from configuration, never hardcoded.
- Jev (optional): HTTP `POST https://api.typesafe.ai/v1/systemone` with env `TYPESAFE_API_KEY` (we call it with plain `fetch` through `src/model/jev-client.ts`, so no SDK dependency; the SDK is `@typesafe-ai/sdk`, Node >= 20). Implemented as `JevAssistedModel`, a wrapper around the main model (the orchestrator does not know about Jev): it answers only "which link next" steps, as a `choice` over a closed set with an explicit `none`, acts at confidence >= 0.75 (lowered from 0.9 on the owner's decision, 2026-10-11, without re-running the evaluation; never configurable below 0.6), and otherwise defers to the main model. Its pick is a proposal that goes through the policy engine like any other. On whenever `TYPESAFE_API_KEY` is set; there is no switch to turn it off (owner's decision, 2026-10-16: the `CORBITS_JEV` variable and the per-task `off` mode were removed; without the key the main model does everything, and `pnpm eval` without a Jev flag is still the Claude-only benchmark); it was enabled after `pnpm eval` showed a measured gain with no accuracy loss (docs/eval-jev-comparison.md). Re-run the evaluation after changing anything that affects its choices. Question types: `choice`, `score`, `noul`. Context limit is 32k tokens for state plus the longest question.
  - Jev-first mode (`CORBITS_JEV_MODE=first`, the default mode since the owner's decision of 2026-10-11 although `pnpm eval --jev-first` has only one run per case; `CORBITS_JEV_MODE=assist` returns to the measured setup; design from browser-use/jev-ultrafast): `JevFirstModel` (`src/model/jev-first.ts`) inverts the control for browser steps. One Jev request (`chooseMany`) answers `operation` (CLICK, TYPE_TEXT, DONE, ESCALATE) plus a target per operation (each with an explicit `none`); only the chosen operation's target is used, and operation and target must each reach the confidence threshold (default 0.6 in this mode, lowered from 0.9 and then 0.75 on the owner's decisions (2026-10-11: 0.5 raised one case of 17 with no wrong click, a set too small to show safety, so 0.6 was chosen); the floor is 0.6). The main model is still used for planning and finishing, and takes any step that code hands over: first step or a step not ending on a read page, no page change after the last action, a checkpoint every 20 steps, Jev answering ESCALATE/DONE/unsure/invalid or being unreachable, and typing a value that is not in the goal when no `TextWriter` is configured. Jev cannot write text, so a typed value is cut word for word out of the goal: a second Jev request (after the field is chosen, so it can name the field) picks the first and last word of the span, each at the confidence threshold, at most 12 words, `none` when the goal does not say; code cuts it out and strips quotes and trailing punctuation. Page text is never typed this way. Values that must be derived (a date in the field's format, a translation) go to the `TextWriter` if there is one, else to the main model. Risky-named controls and credential-looking fields are never offered to Jev. Handing over is decided by code first; Jev's ESCALATE is only an extra signal, and every Jev proposal still goes through the policy engine. Keep it off until `pnpm eval --jev-first` shows no loss in verified success or false-completion rate against `--jev` and Claude only.
  - Consensus (optional, `CORBITS_JEV_CONSENSUS=1`, `pnpm eval --jev-first --consensus`; off, not yet measured): every Jev question is asked twice in the same request, the second time with its options in the opposite order, and a step is taken only when both answers pick the same option, each at the confidence threshold; a disagreement or a missing second answer hands the step over (`stats.disagreed`). It answers Jev's known preference for the first option; the cost is about twice the Jev tokens per step. Enable it by default only if the evaluation shows fewer wrong steps without losing verified successes.
  - Lean settings for Jev-first (cost per task): the per-task spending default is $0.10 (`maxSpendUsd`; a request may ask for more, up to `CORBITS_MAX_SPEND_USD`). ESCALATE is not offered among Jev's operations (code decides hand-overs; the option took probability from CLICK and lowered Jev's confidence in clear steps). The planning call is skipped when the task already carries completion criteria (`skipPlan`; the plan is just the goal). Optional `CORBITS_SUMMARY_MODEL` (a cheaper model, same provider and credentials as the main model, including a person's own key) writes only the final summary when Jev judges the goal reached; it gets no tools, and anything but a summary is replaced by a fixed sentence. Verification, not the summary, decides success.
  - Jev finishes by itself (owner's decision, 2026-10-11): when Jev answers DONE at the confidence threshold the run ends with a finish built by code from the last page, with no main-model call, unless `CORBITS_SUMMARY_MODEL` names a real model. Verification still decides success, so a wrong DONE becomes a failed or recovered task, not a reported success. More operations are offered to Jev: SCROLL_UP (after scrolling down) and GO_BACK (to the previous page's address, taken from history and checked by the policy engine like any `goto`). An action that left the page unchanged is not handed over at once: Jev chooses again without that control, twice at most. Not yet re-measured with `pnpm eval --jev-first`.
  - Jev-only mode (owner's decision, 2026-10-11, chosen per task on the dashboard, `jevMode: "only"`): no Claude call at all and no confidence threshold (Jev's best-supported answer is taken; this is the one place below the 0.6 floor, and it is opt-in per task). It needs completion criteria, either owner-given or taken from the goal (`400` when neither exists) and stops with a plain finish when Jev cannot continue, so verification fails the task rather than reporting success. Risky controls are still never offered to Jev, and every proposal still goes through the policy engine and approvals. Not yet measured with `pnpm eval`. `jevMode: "summary"` is the same plus one tool-less model call that writes only the final summary (the summary model if configured, else the main model; its text is only shown, verification still decides). The dashboard offers: server default, Jev-first, Jev only, Jev + summary.
  - Criteria from the goal (2026-10-16): when the owner gives no criteria, `deriveGoalCriteria` (`src/verification/goal-criteria.ts`, plain code, no model) turns each phrase the goal puts in quotes (at most 3) into a `text_present` criterion. Only the goal is read, never page content; addresses and bare numbers are not used (an address is where to start, a number is as often an input as a result). They are passed to the model as given criteria (so planning is skipped where it is skipped for given criteria), recorded with `criteriaSource: "goal"`, and flagged `metBeforeWork` like plan-proposed ones when the first page already met them. Owner criteria win, then the goal's, then the plan's. A goal with no quoted phrase still ends `unverified` (or uses the plan's criteria). Not yet measured with `pnpm eval`.
  - Plan gate (opt-in, `CORBITS_JEV_PLAN_GATE=1`, `pnpm eval --jev-first --plan-gate`; 2026-10-16, not yet measured): for a new task with no criteria at all, Jev answers one `choice` (`plan` / `no_plan`, options shuffled) on the goal alone. `no_plan` at the confidence threshold skips the planning call, and since the plan call is where criteria get proposed, such a task ends `unverified` (never completed). Any doubt, error or `plan` means the normal planning call. It never gates a task that has criteria (owner's or the goal's), a note, a prior attempt, secrets, saved logins or an attached document. Jev does not decide anything about permissions here; the plan only gives context.
  - No-model path: with `CORBITS_SUMMARY_MODEL=template` the finish is built by code from the last page (URL and visible text), and the very first step opens the address named in the goal (`via: "code"`). Together with the skipped plan, a task whose goal names a URL and carries criteria can run with no main-model call at all. The trade-off: the summary is the page's own text, not a written answer. Verification still decides success.
  - Fallback model: `CORBITS_FALLBACK_MODEL` (a cheaper model, same provider and credentials as the main model) takes the steps Jev hands over instead of the main model, which then only plans tasks that have no criteria. Its proposals go through the policy engine like any other; consequential actions still need human approval.
  - Tools beyond click/type: `browser.scroll`, `browser.select` (native dropdown by label) and `browser.find` (text on the page, read-only, reads the full snapshot) are registered like any other tool. Tool output is stored clipped to 8,000 characters, so on a long page only the start is visible to any model; `find` is how a model or Jev reaches the rest, and code uses it when the goal names something (a quoted phrase or a number of 3+ digits) that the visible part does not contain. Controls offered to Jev are ranked by how rare their words are in the goal.
  - Control parsing must accept frame-prefixed refs (`f1e12`); before this was fixed Jev saw no controls on most pages.
  - Jev does not treat its input as hostile and can be steered by injected instructions, so never pass raw page content to it without sanitization, and never use it for permission or approval decisions.
  - It is unreliable at counting, numeric comparison, and date comparison; do those in code.
  - It favors the first option in a `choice`; randomize or rotate option order where it matters.
  - Use `confidence` as a routing signal with risk-scaled thresholds. Default: above 0.9 may proceed for low-risk actions; 0.5 to 0.9 asks for confirmation or more evidence; below 0.5 does not act. Consequential actions always require human approval regardless of confidence (the only exception is an owner's standing approval, see below).

### Credentials and continuing tasks

- Saved credentials are encrypted at rest (AES-256-GCM, authenticated with owner, name and site) and write-only. The model sees a credential's name and site only, never its value. The single tool that can use one (`browser.type_secret`) works only in password fields on exactly the site it was saved for, rechecks that at the moment of use, and always requires a fresh human approval bound to the field, page and credential name. Wrong-site or wrong-field uses are refused by the policy engine before any approval is requested. Add any new secret-handling path to the tests that scan history, approvals, evidence files and API output for the value.
- A password can also be entered on the approval card itself (`browser.ask_password`): it is sent with the approval decision, held encrypted (bound to the approval and site) until the approved action types it, deleted on use, and purged if unused; optionally also saved under a name. The model supplies only the field. After an approval the orchestrator executes the approved call directly (and retires it if it no longer matches), instead of relying on the model to repeat it.
- Help requests: the model can return `request_help` (a step result, not a tool, so it never goes through tool permissions). It only pauses the task into `human_control` and notifies the owner (outbox kind `help_requested`, one per request, skipped if already handed back). It is capped at 3 per task (`MAX_HELP_REQUESTS`); further ones are recorded as `help.declined` and the model is told not to ask again. The reason is model-written, so it is clipped, shown only as text, and kept to one line in email subjects.
- Human takeover: a running task can be handed to its owner (`human_control` state; only reachable from `running`). The agent run is aborted and must have stopped before the state changes, so a person and the agent never act on the page together. Human input is a closed set (click, text, named key, scroll), validated, only accepted in `human_control`, and never recorded: history keeps counts and the optional hand-back note, not content. The browser methods for it (`HumanControllable`) are not part of `BrowserAdapter`, so agent tools cannot reach them. On hand-back the agent is told the page may have changed and must re-snapshot.
- Attached documents (`document: {title, markdown}` on task creation, stored in `constraints.document`): the owner hands the task a finished text, and `browser.paste_document` (registered only when a document exists and the adapter can `pasteRich`) puts it into an editor field exactly as written: `part: "title"` fills the title, `part: "body"` pastes the Markdown converted to HTML (`src/tools/markdown-html.ts`, escapes everything, keeps only http(s) links) as a paste event, so the page's editor converts headings, lists, bold and links. The text never passes through a model: the tool takes only a ref and a part, the model is told only the title and size (`<document>`), and the result never echoes the text. `pasteRich` is a separate capability (`RichPasteable`), not part of `BrowserAdapter`. Risk is classified like `browser.type` (password fields are consequential). Verified live on a Substack draft (2026-10-13); this does not publish: clicking Publish stays consequential and needs approval.
- Scheduled tasks: a schedule (`schedules`, `schedule_runs`) is only a reason to create an ordinary task; each run goes through `TaskService.createTask`, so limits, quotas, approvals, saved logins and notifications are unchanged, and the task carries `constraints.scheduleId` and a `task.scheduled` event. Times are one of three shapes (every N min >= 15, daily, weekly) as wall-clock times in the schedule's IANA zone (`nextOccurrence`, DST-safe). The scheduler claims each due moment inside a transaction by advancing `next_run_at` first (at-most-once, safe with two servers); a lost run is preferred to a doubled one. Skipped, with the reason recorded: more than an hour late, previous run still active, over quota, disabled user, no usable model. A run waiting for a person over 12 h is cancelled; 5 consecutive failed runs pause the schedule. Runs only while the process is up; no catch-up of missed moments.
- Saved browser logins: after the owner signs in by hand under human control, `captureLoginState` keeps only the open page's own site (cookies by RFC 6265 domain match, local storage for the exact origin; https or loopback only) and stores it encrypted in `login_states` (AES-256-GCM, bound to owner|name|site, write-only). A task starts with a login only if its `constraints.logins` names it (validated against the owner's own logins; a continued task keeps the ones that still exist). The runner loads them into the new browser context (not into own-Chrome mode), tells the model the site and name only (`<signed_in>`), records `logins.applied` / `login.saved` without values, and adds the values to the redactor. No automatic write-back: a login that expired is re-saved by hand.
- Bring your own key: a person's own Anthropic API key is stored encrypted (AES-256-GCM, bound to the owner, `user_api_keys`), write-only (the API returns only its last four characters), checked with Anthropic's `GET /v1/models` before saving (rejected only on 401/403), and used only by the model adapter running that person's tasks (`createModelRouter`). Admins use the server's model; anyone else uses their own key if they have one, else the server's model only if it is an API key, else the task is refused (never the owner's personal Claude login). A key is added to the redactor when used. People on their own key skip the daily spend limit but not the concurrency and hourly limits.
- Multiple people: the tokens in `CORBITS_API_TOKENS` are admins; others live in the `users` table (token stored as a hash, shown once; roles admin/user; disable cuts access including sessions; names are 2-32 chars and cannot collide with `.env` owners). Data is isolated by `owner` as before, and admins get no extra view of others' tasks. `QuotaService` limits non-admins (tasks at once, estimated spend per day, tasks per hour), counted from stored events so it survives restarts. While the model backend is the owner's personal Claude login (`claude-code` provider), only admins may use it: that login must not be shared, so other users need their own API key (or the server must run on an API key). There is no self-service sign-up.
- Dashboard sign-in codes (`/auth/code`, `/auth/redeem`): only an API token can mint a one-time code (random, 60 s, single use, hash-keyed, in memory); redeeming returns a 12 h session token that is accepted like an API token except that it cannot mint codes. Sessions are in memory only, so a restart signs everyone out. This exists so the macOS menu bar app (`macos/CorbitsMenuBar.swift`, token read from `.env`, never written elsewhere) can open the dashboard without a token in a URL.
- Continuing a failed task creates a new linked task. Finished tasks are never reopened; their history is immutable. Carry-over text is untrusted data and is labeled as such in prompts.

### Evaluation harness

- `pnpm eval` (`src/eval/`): ten cases against a local site, real model, real browser. Success is decided from the site's own records (visits, subscriptions, wrong codes, hits on a trap origin), not from the agent's or the verifier's claims, so false completions are measurable. The harness plays the owner (approves or rejects per case; does the human step when the agent asks for help). It reports the measures in section 12 for configuration A (Claude only); Jev and independent-verification variants plug in through the model factory and `--recovery`. Run it under `caffeinate`.

### Security design (inspired by Meta Muse's published architecture)

- Keep the permission authority outside the agent process (Policy Engine), including network egress allowlisting.
- The agent never holds real credentials; inject them at the boundary only after approval.
- The model sees a sanitized page representation, never a handle that can run arbitrary JavaScript in the page.

### Sources

- Jev: https://docs.typesafe.ai/introduction
- jev-ultrafast (design reference for Jev-first; comparison and what to adopt in `docs/jev-ultrafast-comparison.md`): https://github.com/browser-use/jev-ultrafast
- Claude computer use: https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- Claude TypeScript SDK: https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript
- Claude Code CLI reference and headless mode: https://code.claude.com/docs/en/cli-reference , https://code.claude.com/docs/en/headless
- Playwright ARIA snapshots: https://playwright.dev/docs/aria-snapshots
- pg-boss: https://github.com/timgit/pg-boss
- Resend (considered, not used): https://resend.com/docs/send-with-nodejs
- pg-boss: https://pgboss.io/
- Fastify: https://fastify.dev/docs/latest/
- Muse security: https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse
