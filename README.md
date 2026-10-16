# Corbits

An autonomous browser agent that does not take its own word for it. You submit a goal; Corbits
plans, acts in a sandboxed browser, **pauses for your approval before anything consequential**, and
reports success only after code checks the real page against completion criteria. See
[CLAUDE.md](CLAUDE.md) for the design rules.

- **Verified, not claimed.** A task is `completed` only when its criteria hold on the final page.
  No criteria means it ends `unverified`, never as a success.
- **Approval for consequential actions** (sending, publishing, deleting, buying), enforced in code,
  tied to the exact element and page you are shown.
- **Sandboxed browser.** Chromium runs in a locked-down container whose only exit is a proxy that
  refuses private addresses.
- **Inspectable.** Every step, approval, verification result and screenshot is stored and shown in the dashboard.
- **Optional Jev** (a fast decision model) can take plain click steps to cut Claude calls and cost.

Status: early, built for one person (or a few) running it themselves. Read [Known limits](#known-limits) first.

## Run it locally

### You need

- **Node.js 22.12+** and **pnpm** (`corepack enable` gives you pnpm)
- **Docker** (Postgres and the browser sandbox run in containers; the first build pulls a ~3.5 GB image)
- **A Claude login**: [Claude Code](https://code.claude.com) installed and signed in (`claude auth login`).
  Corbits uses that login by default, so no API key is needed. To use an API key instead, set
  `CORBITS_MODEL_PROVIDER=api` and `ANTHROPIC_API_KEY` in `.env`.

### Start it

```bash
git clone https://github.com/jin-codes/corbits-public.git
cd corbits-public
pnpm install
cp .env.example .env
```

Fill in three values in `.env` (each command prints a value; paste it after the `=`):

```bash
# CORBITS_API_TOKENS  -> your sign-in token, as owner:token
node -e "console.log('me:'+require('crypto').randomBytes(32).toString('hex'))"
# CORBITS_SECRETS_KEY -> encrypts saved logins; back it up
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# CORBITS_BROWSER_WS_SECRET -> guards the browser sandbox
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Then:

```bash
pnpm docker:up      # Postgres + the sandboxed browser (first run builds images, a few minutes)
pnpm start          # the API, dashboard and worker on http://127.0.0.1:8787
```

Open <http://127.0.0.1:8787/> and sign in with the part of `CORBITS_API_TOKENS` **after** `me:`.

### Try a first task

In the dashboard, submit:

- **Goal:** `Open https://example.com and tell me, in one sentence, what the page says this domain is for.`
- **Completion criteria:** page text contains `documentation examples`

You should see it open the page, then `Completed and verified`. Change the criterion to something the
page does not contain and the same run ends `Failed`, even though the agent says it is done: that is the point.

The same thing over the API:

```bash
TOKEN=...   # the part of CORBITS_API_TOKENS after "me:"
curl -s -X POST http://127.0.0.1:8787/tasks \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"goal":"Open https://example.com and tell me what this domain is for.",
       "completionCriteria":[{"kind":"text_present","value":"documentation examples"}]}'
```

Tip: put a phrase in quotes in the goal (`... find "Pro plan"`) and, with no criteria given, Corbits
requires that phrase to be on the final page.

### Stop and clean up

```bash
pnpm docker:down            # stop the containers (your data stays in the Postgres volume)
docker compose down -v      # also delete the database volume: all tasks and saved logins are lost
```

### If something goes wrong

| Symptom | Likely cause |
|---|---|
| `set CORBITS_BROWSER_WS_SECRET in .env` when running `pnpm docker:up` | The secret in `.env` is empty. |
| Port already in use (5432, 9222, 8787) | Another Postgres or Corbits is running. Stop it, or change `PORT` and `CORBITS_BROWSER_PORT` in `.env` (the Postgres port is in `docker-compose.yml`). |
| Tasks fail at once with a model error | Claude Code is not signed in (`claude auth login`), or use an API key as above. |
| `Invalid configuration` at start | `.env` is missing a value or a token is shorter than 32 characters; the message names it. |
| Task ends `Failed` although the page looks right | The criteria are checked against the page's accessibility tree, which can differ from what you see (for example a heading that exists only in `<title>`). Open the task to read what the verifier saw. |

`pnpm test` runs the deterministic suite (needs the Postgres container). `pnpm test:live` runs the
tests that call the real Claude API and cost a few cents. `npx playwright install chromium` is only
needed if you run without the sandbox (no `CORBITS_BROWSER_WS_SECRET`), which is for development only.

## Running on a server

`docker-compose.prod.yml` runs the whole stack (app, Postgres, sandboxed browser, gateway) on one
machine so Corbits keeps working when your laptop is off. It builds on arm64 and x86. Step-by-step
instructions for Oracle Cloud Always Free plus Tailscale access are in
[docs/deploy-oracle.md](docs/deploy-oracle.md). On a server without an interactive login, the model
backend uses `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`; subscription accounts, personal use).

## Model access: your Claude login, not an API key

By default Corbits asks your locally installed, logged-in Claude Code (`claude -p`) for each decision,
so usage counts against your Claude subscription and no API key is needed. Corbits keeps its own
loop, policy engine, approvals and limits; Claude Code is used only as a text-in, JSON-out model:
all of its built-in tools are disabled, all customizations (CLAUDE.md, hooks, MCP servers, memory)
are switched off, nothing is saved, it runs in an empty directory, and it is given a minimal
environment (no `ANTHROPIC_API_KEY`, none of Corbits' secrets). The history records which backend
decided each step.

- Costs shown are Claude Code's own estimate at API prices; they are what spending limits enforce,
  not what you are billed. Subscription usage limits still apply, and hitting one fails the task
  with a clear message.
- Each step starts a CLI process, which adds a second or two per step compared with the API.
- Subscription logins are for your own use. If you ever offer Corbits to other people, switch to
  `CORBITS_MODEL_PROVIDER=api` with API keys: Anthropic does not allow third-party products to offer
  claude.ai login.

## Language

The dashboard, the readable task history, outcome explanations, and emails are written in Korean by
default. Set `CORBITS_LOCALE=en` for English. All of this text lives in one catalog
(`src/i18n/messages.ts`); TypeScript requires every message to exist in both languages, and tests
check placeholders, that nothing is left untranslated, and that the dashboard script has no
hard-coded English. The AI is told to write its plan and final report in the language of your goal,
so a Korean goal gets a Korean plan and report. API error codes and server logs stay in English.

## Browser sandbox

With `CORBITS_BROWSER_WS_SECRET` set (24+ random characters, same value `docker compose` sees from `.env`),
tasks run Chromium inside a container instead of on your machine:

- **browser** container: non-root, read-only root filesystem, all capabilities dropped except
  `SYS_CHROOT` (Chromium's own sandbox needs it), a seccomp profile, no-new-privileges, memory and
  process limits, no host mounts, and **no route to the internet or your machine**.
- **gateway** container: the browser's only exit. Its egress proxy refuses private networks (your
  machine, other containers, cloud metadata) and pins each connection to the address it vetted. It
  also relays `127.0.0.1:9222` to the browser's control socket, which sits behind your secret path.

Without the secret the app falls back to a Chromium on your machine and says so at startup; use that
only for development. `pnpm test:docker` starts a separate copy of the sandbox and checks these
properties against real containers (needs Docker and internet).

Sandbox limits: all tasks share one Chromium process (each in its own browser context), the proxy
filters by host and address rather than URL path, and the first `pnpm docker:up` pulls a 3.5 GB image.

## Continuing a failed task

A failed or cancelled task has a **Continue** section on its page. It starts a *new* task linked to
the old one (the old task and its history never change) with the same goal and completion criteria,
a compact summary of what was already done and why it stopped, the last page it was on, an optional
note from you ("this time use the saved password"), and a fresh budget (never above the server
maximum). Logins in the earlier browser are not carried over. `POST /tasks/:id/continue` does the
same through the API. If the earlier attempt stopped in the middle of an action that cannot be
repeated safely, the summary says so and the agent is told to check the page before acting.

## Saved credentials (login vault)

Some tasks need a password. Save it once under **Credentials** (or `POST /secrets`) with a name and
the site it is for. Then a task can log in without anyone pasting a password into a goal:

- The AI only knows the **name** (and which site it is for), never the value. The browser types it
  itself, using a separate tool that works **only in password fields on exactly that site**, and
  only for credentials of the task's owner.
- **Every use needs your approval.** The approval card shows the field, the page, the site and the
  credential name, plus a screenshot, and is bound to them; if the page changes, you are asked again.
  A use on the wrong site, or in a non-password field, is refused outright without asking you.
- Values are encrypted with AES-256-GCM (key from `CORBITS_SECRETS_KEY`, bound to owner, name and
  site) and are write-only: no API returns them, and they are scrubbed from history, approvals and
  logs. Typed passwords show as dots in screenshots.
- Usernames and emails are not secret: write them in the goal.
- **No need to save anything first.** If no saved credential fits, the agent asks for the password
  while asking for approval: the approval card shows a password box. What you type goes to the
  browser once and is then deleted (it is held encrypted only until the approved action runs, and
  purged after 30 minutes if never used). Tick "save it for next time" to also keep it under a name
  for that site. The AI, the history and the screenshots never contain it.
- Enable it by setting `CORBITS_SECRETS_KEY` (see `.env.example`). **Back the key up**: without it
  saved credentials cannot be recovered. It does not cover 2-step verification codes or CAPTCHAs.

## Approved actions run as approved

When you approve an action, the system carries out exactly that action next, rather than asking the
AI again and hoping it proposes the same thing. If the page or target changed in the meantime, the
approval is retired and you are asked once more; an approval is never retried in a loop.

## Evidence and files

While a task runs, Corbits keeps evidence you can inspect later: a screenshot after every browser
action, a screenshot of the page at the moment an approval was requested (shown in the approval
card, so you see what you are approving), and, at each verification, a screenshot plus the full page
text the verifier saw. A screenshot of the final state is added when a task stops early. Identical
consecutive screenshots are stored once.

- Files live in Postgres (`artifacts` table) behind an `ArtifactStore` interface. Limits apply per
  file (2 MB), per task (80 files, 40 MB); a full quota is reported once in the history.
- Screenshots can show sensitive content, so they expire after `CORBITS_ARTIFACT_RETENTION_DAYS`
  (default 30) and the owner can delete any of them (`DELETE /artifacts/:id`). Captured page text is
  scrubbed of secrets; screenshots cannot be.
- Capturing evidence is best effort and time-limited: a failed capture is noted in the history and
  never changes a task's outcome.
- `GET /tasks/:id/artifacts` lists them and `GET /artifacts/:id` serves the bytes (owner only, with a
  locked-down CSP, nosniff, and text served as a download).

## Dashboard

Open http://127.0.0.1:8787/ and sign in with one of your API tokens (it is kept only for that
browser tab). From there you can submit tasks with completion criteria and limits, watch progress
live, approve or reject paused actions (with the exact element and form target shown), cancel, and
read a plain-language history with the evidence used for verification. The "Agent's report" on a
finished task is written by the AI; only the completion criteria are checked by code.

## API

All routes except `/healthz` need `Authorization: Bearer <token>`. Tasks belonging to other
owners look like they do not exist (404).

| Method | Path | Purpose |
|---|---|---|
| POST | `/tasks` | Submit `{ goal, completionCriteria?, limits? }` |
| GET | `/tasks` | Your tasks, newest first (`limit`, `before`) |
| GET | `/tasks/:id` | Status, pending approvals, and why the task last changed state |
| GET | `/tasks/:id/events` | Raw execution history (`after`, `limit`) |
| GET | `/tasks/:id/timeline` | Readable history, cost, and outcome (what the dashboard shows) |
| GET | `/tasks/:id/artifacts` | Screenshots and captured page text for a task |
| GET | `/artifacts/:id` | One file (owner only) |
| DELETE | `/artifacts/:id` | Delete one file |
| GET/POST | `/schedules` | List your schedules / create one `{ name, goal, schedule, timezone, completionCriteria?, limits?, logins? }` |
| PATCH/DELETE | `/schedules/:id` | Pause or resume (`{ enabled }`), rename / delete |
| POST | `/schedules/:id/run` | Run it now |
| GET | `/schedules/:id/runs` | What happened each time it came due, including skips and why |
| GET | `/me` | Who you are, your role, your limits and today's usage, and whether your own API key is saved |
| PUT/DELETE | `/me/api-key` | Save (after Anthropic confirms it works) or remove your own Anthropic API key |
| GET/POST | `/admin/users` | Admins: list people / add one (the token is returned once) |
| PATCH | `/admin/users/:owner` | Admins: disable or enable, change email, role or limits |
| POST | `/admin/users/:owner/token` | Admins: issue a new token (the old one stops working) |
| POST | `/auth/code` | API token only: a one-time dashboard sign-in code (60 s, single use) |
| POST | `/auth/redeem` | `{ code }` (no token needed): trade the code for a 12-hour session token |
| POST | `/tasks/:id/cancel` | Cancel |
| GET | `/tasks/:id/live` | A JPEG of the task's browser (running, awaiting approval, or under human control) |
| POST | `/tasks/:id/control/take` | Pause the agent and take over the browser (running tasks only) |
| POST | `/tasks/:id/control/input` | While in control: `{type:"click",x,y}`, `{type:"text",text}`, `{type:"key",key}`, `{type:"scroll",x,y,dx,dy}` |
| POST | `/tasks/:id/control/release` | Hand the browser back, optionally with `{ "note" }` for the agent |
| GET | `/approvals` | Actions waiting for your decision |
| POST | `/approvals/:id/decision` | `{ "decision": "approved" \| "rejected" }` |

Completion criteria are checked by code against the final page, never by the model:
`{"kind":"url_contains","value":"/done"}` or `{"kind":"text_present","value":"Order confirmed"}`.
For tasks whose result is an answer, `{"kind":"answer_grounded"}` looks up every number (two or more digits, or with a
decimal point) and every double-quoted text in the agent's final summary on the final page. It checks that the stated
values are on the page, not that the answer is right. A task with no criteria at all still runs but ends `unverified`.
Requested `limits` (`maxToolCalls`, `maxRuntimeMinutes`, `maxSpendUsd`, `maxSteps`,
`maxRecoveryAttempts`) can only be lower than the server maximums.

```bash
curl -s -X POST http://127.0.0.1:8787/tasks \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"goal":"Open https://example.com and confirm it says Example Domain",
       "completionCriteria":[{"kind":"text_present","value":"Example Domain"}]}'
```

## Scheduled tasks

A schedule starts a task by itself, on time, so work happens while you are away. Open **Schedules** (예약),
give it a name, say what to do, set the completion criteria, and pick when: every day at a time, on chosen weekdays
at a time, or every N minutes (at least 15). Times are wall-clock times in the schedule's time zone (it defaults to your
browser's), so 08:30 stays 08:30 across daylight-saving changes.

- **Each run is an ordinary task**: its own history, evidence, limits, approvals and notification emails, marked
  "Started by the schedule ...". Ask for a spending limit on the schedule itself; it is applied to every run.
  A schedule can also start signed in with saved logins you tick.
- **Nothing piles up.** If the previous run is still going, the new moment is skipped and the reason recorded. A run that
  has waited more than 12 hours for your approval or help is cancelled so it cannot block every later run.
- **Missed moments are not made up.** If the server was off for more than an hour past a time, that run is skipped and
  noted (a time the server was off for a few minutes is run when it comes back). Resuming a paused schedule looks ahead
  from now.
- **It stops itself when it keeps failing**: after 5 failed runs in a row the schedule pauses (the reason is shown) instead
  of spending on something that does not work; turn it back on when fixed.
- People's limits apply as usual (tasks at once, daily spend, tasks per hour, the model they may use). A run that is
  over a limit, or for a person who is disabled or has no API key, starts nothing and says why in **Recent runs**.
- **Run now** starts one immediately without changing the schedule. At most 20 schedules each.
- The schedule is checked by the server process every 30 seconds, so it only runs while Corbits is running: on a
  laptop that sleeps, runs are late or skipped (see above); on the server deployment it just works. `CORBITS_SCHEDULER=0`
  turns it off.

## Saved browser logins

Sign in to a site once by hand and later tasks can start already signed in, without typing a password.

1. Start a task (or use one that is running), press **Take control**, and sign in on the live browser,
   including any CAPTCHA or two-step code.
2. Open **Keep this login**, give it a name (for example `mail`) and press **Save this login**.
3. When you start a new task, tick that login under **Start already signed in to**. The task's browser starts
   with it and the agent is told it is signed in there. Nothing is loaded unless you tick it.

- Only the open page's own site is saved (its cookies and its local storage), never the other sites a browser
  happens to hold. A login can be saved only from an `https` page (or this machine, for development).
- It is stored encrypted with `CORBITS_SECRETS_KEY`, bound to you, the name and the site, and it is
  write-only: the list shows names, sites and dates, never the session. The agent is told the site and
  name only. The history records that a login was saved or used (name, site, number of cookies), never values,
  and the values are scrubbed from logs and evidence if they ever appeared.
- It is only a copy of what the site gave your browser, so it expires when the site says so (or if you sign out
  elsewhere). When a task finds a sign-in page anyway, the agent asks for your help; sign in again and save it
  again. Delete a login any time on the **Saved logins** page. Continuing a task keeps the same logins.
- Anything signed in can act as you on that site, so tick logins only for tasks that need them; consequential
  actions still need your approval as always. Needs the sandbox browser or local Chromium: it is not loaded into
  "your own Chrome" mode (that would change your real cookies).

## Evaluating the agent

`pnpm eval` runs a set of ten small tasks with your real model and a real browser against a local test
site, and reports how often Corbits got it right. It judges by the site's own records (which pages
were visited, what was subscribed, whether a planted instruction was followed), never by what the agent
or the verifier said, so it can tell a real success from a false completion.

```bash
pnpm eval --list                                  # the cases
pnpm eval                                         # all of them, once (about 10 minutes)
pnpm eval --cases read-price,impossible --repeat 3
pnpm eval --recovery 0 --label no-recovery        # compare settings: label the run, compare the files
```

- The cases cover reading, navigation, forms, search, a record lookup, an action the owner approves, the
  same action the owner rejects (it must not happen), a page that tries to hijack the agent, a task that
  cannot be done (it must not claim success), and a step only a person can do (it should ask for help).
- The report gives success rate, false completion rate, recovery success, cost per correct task, latency,
  tool and model calls, approvals, help requests, and safety counts. It is printed and saved under
  `eval-results/` (git-ignored) as Markdown and JSON.
- Each task is capped at about $0.50 of estimated usage. The cost shown is Claude Code's estimate at API
  prices, not what a subscription bills; subscription limits still apply.
- Keep the Mac awake while it runs (`caffeinate -i pnpm eval`): a sleep in the middle makes times and
  limits meaningless. Needs the local Postgres (`pnpm db:up`) and Chromium.

## More than one person

The tokens in `CORBITS_API_TOKENS` are **admins**. An admin opens **Users** in the dashboard, adds a person
(a name, optionally an email for notifications and different limits), and gets that person's token once.
Hand it over privately; they paste it on the sign-in page.

- Everyone sees only their own tasks, history, evidence, approvals and saved logins. Admins do not see other
  people's tasks either. Notification emails go to each person's own address.
- Each non-admin has limits so no one uses up everyone's share: tasks at once (default 2), estimated model
  spend per day (default $2, resetting at midnight UTC) and tasks per hour (default 30). Change the defaults
  in `.env` (`CORBITS_USER_*`) or per person on the Users page. They see their usage on the task list, and a
  clear message when they hit a limit.
- An admin can disable a person (cuts access at once, including open dashboard sessions), enable them again, or
  issue a new token (the old one stops working immediately). Only a hash of each token is stored, so a lost
  token cannot be looked up, only replaced. Admins cannot disable or demote themselves.
- **Whose Claude account runs a task (bring your own key).** The default backend is your personal Claude
  login (`claude -p`), which is for your own use and is not something to lend out. So admins' tasks run on it,
  but anyone else must add **their own Anthropic API key** (the **My API key** page): the key is checked with
  Anthropic, stored encrypted, shown only as its last four characters, never written to history, logs or
  evidence, and used only for that person's tasks, so what they use is billed to their own Anthropic account.
  Without a key they can sign in and look around but cannot start tasks, and are told why. A person with a key
  is not subject to the daily spend limit (it is their money); tasks at once and per hour still apply because
  the server and browser are shared. If you instead run the server on an API key
  (`CORBITS_MODEL_PROVIDER=api`), people without their own key use that key, within their daily limit. Keys need
  the saved-logins key (`CORBITS_SECRETS_KEY`) so they can be encrypted. Anyone who controls the server could in
  principle use a stored key, so tell people to create one just for this with a spending limit.
- **Reaching the server.** Tokens travel in requests, so use HTTPS or a private network: giving people access over
  Tailscale (share the machine or invite them to your tailnet) is the simplest safe way. Do not expose the plain
  HTTP port to the internet. There is no sign-up page: only an admin can add people.
- They all use the same browser sandbox and server resources (each task gets its own isolated browser
  context). For a handful of people that is fine; heavier use would need per-task containers (see the Roadmap).

## Saving tokens: trimmed history, and Jev

- **Older page snapshots are trimmed in the prompt** (on by default). A page snapshot can be tens of
  thousands of characters and every step used to resend every earlier one. Now only the latest is sent in
  full, and older pages keep their first 800 characters. The recorded history is untouched. Set
  `CORBITS_FULL_HISTORY=1` to turn it off (for comparing).
- **Jev (on whenever `TYPESAFE_API_KEY` is set).** [Jev](https://docs.typesafe.ai/introduction) is a decision
  model: it picks one of a closed set of options and says how sure it is, but cannot write text. It makes the
  plain "which link do I click next" steps, and the main model keeps everything else (planning, typing,
  finishing, anything unclear). It applies to every model a task runs on, including people's own keys, and
  is billed to the TypeSafe key in `.env`. It is on whenever the key is set; remove the key to run on the main model alone.
  - Jev only proposes a click. It goes through the same policy engine, approvals and limits as any other
    action, so Jev never decides what is allowed, and it is never used for approvals or permissions.
  - On the dashboard's new-task form you can pick the Jev mode per task (server default, Jev-first, assist, or off);
    the choice is stored with the task and kept when a failed task is continued. It does nothing without a Jev key.
  - **Jev only** (per task, dashboard or `jevMode: "only"`): no Claude call at all (no planning, no step, no summary). Jev takes its best-supported answer whatever its confidence (no threshold; risky controls are still never offered and every action still goes through the policy engine and approvals), and the task stops when Jev cannot continue (nothing fits, a value that is not in the goal must be typed). The request must carry `completionCriteria` (the API answers 400 otherwise) and the goal should name a start address. Verification stays deterministic code. Not measured yet. **Jev + summary** (`jevMode: "summary"`) is the same, plus one tool-less Claude call (`CORBITS_SUMMARY_MODEL` if set, else the main model) that writes only the final summary, for research tasks. The dashboard offers four choices: server default, Jev-first, Jev only, Jev + summary (the API still accepts `assist` and `off`).
  - The default mode is `first` (since 2026-10-11): Jev decides the browser steps and acts at confidence >= 0.6 (never
    configurable below 0.6); the main model plans, finishes, writes text and takes risky or unclear steps. Set
    `CORBITS_JEV_MODE=assist` for the description in this list, where it acts at confidence >= 0.75 (configurable). Below that, on "none", on a Jev error or
    timeout, after three clicks in a row, after any denial, rejection or failed verification, the main model
    decides. A Jev outage never stops a task.
  - Page text is untrusted, so Jev sees only short one-line element names and where links lead (never raw
    page text), element names that sound like actions (delete, buy, subscribe, log in, ...) are never offered,
    and the options are shuffled because Jev leans toward the first one.
  - Jev steps are marked in the history (`via: jev`) and counted separately. Jev's price is not published in
    its docs, so costs shown exclude it.
  - It was turned on after measuring: on the easy and hard cases it made 6-8% of steps, never clicked wrongly,
    and cut the main model's tokens by about 11% overall (21-30% on the tasks where it acted); see
    `docs/eval-jev-comparison.md`. Re-check with `pnpm eval --jev --label jev` against `pnpm eval --label baseline`
    (`--jev` forces it on in the harness).

## Menu bar app (macOS)

A small menu bar item shows how many tasks are running and how many wait for your approval (a
macOS notification appears when a new approval arrives), and opens the dashboard, already signed in,
straight to the task you click: "Take control" is one click away.

```bash
pnpm menubar install     # builds it (needs the Xcode command line tools), starts it, and starts it at every login
pnpm menubar uninstall   # stops it and removes what it installed
pnpm menubar run         # try it in the terminal first
```

- It reads your API token from this project's `.env` and keeps it in memory only.
- It does not put the token in a URL. It asks the server for a one-time code (valid for a minute, usable once)
  and the dashboard swaps that for a session token that lasts 12 hours and is forgotten when the server restarts.
  A session can open the dashboard but cannot mint more codes.
- Quitting from its menu keeps it quit until the next login. It talks to `127.0.0.1:8787` by default
  (`PORT` in `.env`; `CORBITS_MENUBAR_URL` to point it elsewhere, for example a Tailscale address).

## Using your own Chrome (local only, optional)

By default the agent works in the sandboxed container. If you want it to use sites you are already
logged in to, it can instead drive a Chrome on this machine. This trades protection for
convenience, so it is off by default and refuses to start unless it is set up safely.

```bash
pnpm chrome        # opens a separate Chrome profile (~/.corbits-chrome) with remote debugging on 127.0.0.1:9223
```

Log in to the sites you want the agent to use in that window (once; the profile remembers), then in `.env`:

```
CORBITS_BROWSER_CDP_URL=http://127.0.0.1:9223
CORBITS_ALLOWED_ORIGINS=https://mail.example.com,https://app.example.com
```

- It must be a **dedicated profile**, not your everyday one. Chrome 136+ refuses remote debugging on
  the default profile on purpose, because it was being used to steal cookies
  ([Chrome's announcement](https://developer.chrome.com/blog/remote-debugging-port)).
- The agent opens its **own tab** and only touches that tab. It never closes or alters your other
  tabs, and stopping a task closes just its tab. You can watch it in that Chrome window.
- **Required**: `CORBITS_ALLOWED_ORIGINS`. The agent can only navigate to the sites you list, so it
  cannot wander to other sites where that profile is logged in. Corbits refuses to start without it,
  and the address must be on this machine.
- **Any site, on purpose**: instead of the list you can set `CORBITS_ALLOW_ANY_ORIGIN=true`. The agent
  may then visit any public site, so text injected into one page can steer it to another site where
  that profile is logged in. Private addresses stay blocked (it refuses to start together with
  `CORBITS_ALLOW_PRIVATE_NETWORK`, or together with a site list). Approvals still gate consequential
  actions. Prefer the list when you can.
- What is weaker than the sandbox: there is no container and no egress proxy, so a redirect from an
  allowed site to a private address is not stopped by the network layer, downloads land in your real
  download folder (a download click still needs your approval), and anything logged in in that
  profile is reachable from the allowed sites. Approvals, limits and verification work as usual.
- If the sandbox is also set up, it stays the default and the dashboard's new-task form shows **Run in my Chrome
  (new tab)** (admins only). Without a sandbox, every task uses your Chrome.
- Any program on this machine can control that Chrome while it is open. Close it when not in use.
- Local use only: it does not work from the Docker/server setup, and it needs Chrome running.

## Taking over the browser

For a CAPTCHA, two-step verification, or a step the agent cannot do, open the task, press "Take
control", and drive the agent's sandboxed browser from the dashboard (click the picture, type with
your keyboard or the text box, which also works on a phone). The agent is stopped before you get
control, so you and the agent never act on the page at once; time under your control does not count
toward the task's runtime. "Hand back to the agent" resumes the task from whatever page you left,
and the agent is told the page may have changed (and shown your optional note).

- This is the same sandboxed Chromium the agent uses, not your computer. Your input goes through the
  same network rules (egress proxy, no private addresses), and there is no way to run script or
  read the page back, only a picture of it.
- What you type is never stored. The history records only that control happened, how long, and
  counts of clicks, text entries, key presses and scrolls, plus your note.
- The agent can also ask for you. When it hits a CAPTCHA, a verification code, or a login it has no
  credential for, it calls `request_help` with a reason: the task pauses under your control (a
  "Needs your help" badge and the reason on top of the live view), you get an email and a menu bar
  notification, and handing back resumes it. It may ask at most three times per task; after that it is
  told to carry on or finish and explain. A help request only pauses: it never approves anything.
- Only a running task can be taken over (reject or wait out a pending approval first). The live
  picture refreshes about three times a second under control and once a second when just watching.
- The live view needs the browser session to be in the same server process; after a restart the
  session is gone and you can only hand back (the agent then reloads the last page).

## Email notifications

Corbits emails the task owner when a task is verified complete, fails or ends incomplete, or needs
an approval. Messages are plain text, built from the persisted task state (never from model output),
and never contain a one-click approve link. Configure SMTP and `CORBITS_OWNER_EMAILS` in `.env`
(see `.env.example`); a Gmail app password works and costs nothing. Without configuration,
notifications are still recorded and will be sent once email is set up. Delivery is at-least-once
and every attempt is stored in `notification_attempts`.

## Roadmap

Not built yet, in rough priority order:

1. Smoother streaming than screenshot polling, and takeover while an approval is pending.
2. One container per task instead of one shared Chromium, for stronger isolation.
3. Jev-assisted decisions behind the model-adapter boundary, with the A/B/C evaluation from CLAUDE.md.
4. Desktop (non-browser) execution behind a `DesktopAdapter`.
5. Credential key rotation, a way to hand the agent one-time codes safely, and refreshing a saved login automatically when a site renews it.
6. Stronger multi-user hardening: built-in HTTPS, self-service sign-up and token reset, per-user model keys, request rate limits.

## Known limits

- Cancelling from another process interrupts the run only at the next step boundary.
- Browser sessions live in the worker process. After a restart the last page is reloaded, but typed
  form state is lost and the model must take a fresh snapshot.
- Verification evidence is page-controlled text.

## License

[MIT](LICENSE). Corbits drives a real browser on your behalf: read [Known limits](#known-limits) and the
safety notes above before pointing it at accounts you care about. It comes with no warranty.
