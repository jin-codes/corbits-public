// Corbits dashboard. Plain ES module, no dependencies, no build step.
// All text comes from the server's message catalog via /assets/i18n.js (see src/i18n/messages.ts).
//
// Security notes:
// - Everything that originates from a web page or a model is rendered with text nodes only
//   (see h()). Nothing here uses innerHTML, and links are never built from untrusted data.
// - The API token lives in sessionStorage (cleared when the tab closes). The server's CSP
//   forbids inline script and third-party origins, which is what keeps that acceptable.

import { locale, t } from "/assets/i18n.js";

const TOKEN_KEY = "corbits.token";

const STATUS = {
  queued: { tone: "", active: true },
  planning: { tone: "", active: true },
  running: { tone: "", active: true },
  awaiting_approval: { tone: "warn", active: true },
  human_control: { tone: "warn", active: true },
  needs_help: { tone: "warn", active: true },
  verifying: { tone: "", active: true },
  completed: { tone: "good", active: false },
  unverified: { tone: "warn", active: false },
  failed: { tone: "bad", active: false },
  cancelled: { tone: "", active: false },
};
const isActive = (status) => STATUS[status]?.active ?? false;

// ---- tiny DOM helper ---------------------------------------------------------------------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const root = document.getElementById("app");
const clear = (el) => el.replaceChildren();

// ---- session and API ---------------------------------------------------------------------

let token = readToken();
let owner = null;
let role = "user"; // "admin" may manage users; set from /me
let byok = false; // whether this server can store people's own API keys
let pollTimer = null;
let navToken = 0; // bumped on every navigation so stale async work never paints over a new view

function readToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function saveToken(value) {
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: the token just lasts until reload */
  }
  token = value;
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? body?.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function api(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  if (res.status === 401) {
    signOut();
    throw new ApiError(401, { error: "unauthorized" });
  }
  if (res.status === 204) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

function signOut() {
  saveToken(null);
  owner = null;
  route();
}

// ---- formatting --------------------------------------------------------------------------

const fmtTime = (iso) => new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtDateTime = (iso) => new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
const fmtMoney = (n) => `$${Number(n).toFixed(n < 0.1 ? 4 : 3)}`;
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const clipText = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Labels the server stored in English when the evidence was captured.
const STORED_LABELS = {
  "When approval was requested": "ui.artifactLabel.approval",
  "What the verifier saw": "ui.artifactLabel.verification",
  "State when the task stopped": "ui.artifactLabel.failure",
  "browser.goto": "ui.label.browser.goto",
  "browser.click": "ui.label.browser.click",
  "browser.type": "ui.label.browser.type",
  "browser.find": "ui.label.browser.find",
  "browser.scroll": "ui.label.browser.scroll",
  "browser.select": "ui.label.browser.select",
  "browser.snapshot": "ui.label.browser.snapshot",
};
const artifactLabel = (label) => (STORED_LABELS[label] ? t(STORED_LABELS[label]) : label);
const kindName = (kind) => {
  const name = t(`kind.${kind}`);
  return name === `kind.${kind}` ? kind.replaceAll("_", " ") : name;
};

// ---- artifacts (screenshots, captured page text) ------------------------------------------
// Fetched with the bearer token and shown through blob: URLs, since <img> cannot send headers.

const blobUrls = new Map();
function blobUrl(id) {
  if (!blobUrls.has(id)) {
    blobUrls.set(
      id,
      fetch(`/artifacts/${id}`, { headers: { authorization: `Bearer ${token}` } }).then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return URL.createObjectURL(await res.blob());
      }),
    );
  }
  return blobUrls.get(id);
}
function clearBlobs() {
  for (const p of blobUrls.values()) p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
  blobUrls.clear();
}
function screenshot(id, alt) {
  const wrap = h("div", { class: "shot-wrap" }, h("span", { class: "muted small" }, t("ui.loadingScreenshot")));
  blobUrl(id)
    .then((u) => wrap.replaceChildren(h("img", { class: "shot", src: u, alt })))
    .catch(() => {
      blobUrls.delete(id);
      wrap.replaceChildren(h("span", { class: "error small" }, t("ui.screenshotUnavailable")));
    });
  return wrap;
}
async function saveArtifact(id, filename) {
  const u = await blobUrl(id);
  const a = h("a", { href: u, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
}

function badge(status, outcome) {
  const s = { tone: "", active: false, ...(STATUS[status] ?? {}) };
  let label = STATUS[status] ? t(`ui.status.${status}`) : status;
  // A task that ended with only some criteria met is "incomplete", not a plain failure.
  if (status === "failed" && outcome?.tone === "warn") Object.assign(s, { tone: "warn" }), (label = t("ui.statusIncomplete"));
  return h("span", { class: `badge ${s.tone} ${s.active ? "active" : ""}`.trim(), role: "status" }, label);
}

// ---- layout ------------------------------------------------------------------------------

function shell(...content) {
  return h(
    "div",
    {},
    h(
      "header",
      { class: "top" },
      h(
        "div",
        { class: "wrap" },
        h("a", { class: "brand", href: "#/" }, t("ui.brand")),
        h("a", { class: "navlink", href: "#/schedules" }, t("ui.schedulesLink")),
        h("a", { class: "navlink", href: "#/secrets" }, t("ui.secretsLink")),
        role === "admin" ? h("a", { class: "navlink", href: "#/users" }, t("ui.usersLink")) : null,
        role !== "admin" && byok ? h("a", { class: "navlink", href: "#/settings" }, t("ui.settingsLink")) : null,
        h("span", { class: "spacer" }),
        owner ? h("span", { class: "who" }, role === "admin" ? `${owner} · ${t("ui.roleBadgeAdmin")}` : owner) : null,
        h("button", { onclick: signOut }, t("ui.signOut")),
      ),
    ),
    h("main", { class: "wrap" }, ...content),
  );
}

function mount(node) {
  clear(root);
  root.append(node);
}

function schedule(fn, ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(fn, ms);
}

// ---- login -------------------------------------------------------------------------------

function renderLogin(message) {
  const input = h("input", { type: "password", id: "token", autocomplete: "off", required: true, "aria-describedby": "login-help" });
  const error = h("p", { class: "error", role: "alert" }, message ?? "");
  const form = h(
    "form",
    {
      class: "card login stack",
      onsubmit: async (e) => {
        e.preventDefault();
        saveToken(input.value.trim());
        try {
          owner = null; // route() asks the server who this is, including their role
          route();
        } catch (err) {
          if (err.status !== 401) error.textContent = t("ui.serverUnreachable");
          else renderLogin(t("ui.tokenRejected"));
        }
      },
    },
    h("h1", {}, t("ui.brand")),
    h("p", { id: "login-help", class: "muted" }, t("ui.tokenHelp")),
    h("div", {}, h("label", { for: "token" }, t("ui.apiToken")), input),
    error,
    h("button", { class: "primary", type: "submit" }, t("ui.signIn")),
  );
  mount(form);
  input.focus();
}

// ---- task list ---------------------------------------------------------------------------

function criterionRow(onRemove) {
  const kind = h("select", { "aria-label": t("ui.criterionType") }, h("option", { value: "text_present" }, t("ui.criterionText")), h("option", { value: "url_contains" }, t("ui.criterionUrl")), h("option", { value: "answer_grounded" }, t("ui.criterionAnswer")));
  const value = h("input", { type: "text", maxlength: "500", placeholder: t("ui.criterionPlaceholder"), "aria-label": t("ui.criterionValue") });
  const row = h("div", { class: "criteria-row" }, kind, value, h("button", { type: "button", onclick: () => (row.remove(), onRemove?.()) }, t("ui.remove")));
  // "The answer's values are on the page" has nothing to type: it checks the agent's own summary.
  kind.addEventListener("change", () => (value.hidden = kind.value === "answer_grounded"));
  row.read = () => (kind.value === "answer_grounded" ? { kind: "answer_grounded" } : { kind: kind.value, value: value.value.trim() });
  return row;
}

function newTaskCard() {
  const goal = h("textarea", { id: "goal", required: true, maxlength: "10000", placeholder: t("ui.goalPlaceholder") });
  const criteria = h("div", { class: "stack" });
  const addCriterion = () => criteria.append(criterionRow());
  const spend = h("input", { type: "number", id: "spend", min: "0.01", step: "0.01", placeholder: t("ui.default") });
  const minutes = h("input", { type: "number", id: "minutes", min: "1", step: "1", placeholder: t("ui.default") });
  const tools = h("input", { type: "number", id: "tools", min: "1", step: "1", placeholder: t("ui.default") });
  const error = h("p", { class: "error", role: "alert" });
  const submit = h("button", { class: "primary", type: "submit" }, t("ui.startTask"));
  // Saved logins the task may start signed in with. Nothing is loaded unless it is ticked here.
  const loginBox = h("div", { hidden: true });
  const loginChecks = [];
  api("/logins")
    .then(({ logins }) => {
      if (!logins.length) return;
      for (const l of logins) {
        const box = h("input", { type: "checkbox", value: l.name });
        loginChecks.push(box);
        loginBox.append(h("label", { class: "row small" }, box, `${l.name} (${l.origin})`));
      }
      loginBox.prepend(h("label", {}, t("ui.useLogins")), h("p", { class: "muted small" }, t("ui.useLoginsHelp")));
      loginBox.hidden = false;
    })
    .catch(() => {}); // not enabled, or not reachable: the picker just stays hidden

  // How Jev takes part. Shown only when the server has Jev on; "" means the server's default.
  const jevBox = h("div", { hidden: true });
  const jevSelect = h(
    "select",
    { id: "jev-mode" },
    h("option", { value: "" }, t("ui.jevDefault")),
    h("option", { value: "first" }, t("ui.jevFirst")),
    h("option", { value: "only" }, t("ui.jevOnly")),
    h("option", { value: "summary" }, t("ui.jevSummary")),
  );
  jevBox.append(h("label", { for: "jev-mode" }, t("ui.jevMode")), jevSelect, h("p", { class: "muted small" }, t("ui.jevModeHelp")));
  // Your own Chrome (admins, when the server has it): a new tab there instead of the default browser.
  const chromeBox = h("div", { hidden: true });
  const chromeCheck = h("input", { type: "checkbox", id: "own-chrome" });
  chromeBox.append(h("label", { class: "row small" }, chromeCheck, t("ui.ownChrome")), h("p", { class: "muted small" }, t("ui.ownChromeHelp")));
  api("/me")
    .then((me) => {
      if (me.ownChrome) chromeBox.hidden = false;
      if (!me.jev) return;
      jevSelect.firstChild.textContent = t("ui.jevDefaultIs", { mode: t(`ui.jev.${me.jev.default}`) });
      jevBox.hidden = false;
    })
    .catch(() => {});

  return h(
    "form",
    {
      class: "card stack",
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = "";
        const completionCriteria = [...criteria.children].map((r) => r.read()).filter((c) => c.value);
        const limits = {};
        if (spend.value) limits.maxSpendUsd = Number(spend.value);
        if (minutes.value) limits.maxRuntimeMinutes = Number(minutes.value);
        if (tools.value) limits.maxToolCalls = Number(tools.value);
        const logins = loginChecks.filter((c) => c.checked).map((c) => c.value);
        const body = { goal: goal.value.trim(), ...(completionCriteria.length ? { completionCriteria } : {}), ...(Object.keys(limits).length ? { limits } : {}), ...(logins.length ? { logins } : {}), ...(jevSelect.value ? { jevMode: jevSelect.value } : {}), ...(chromeCheck.checked ? { browser: "chrome" } : {}) };
        submit.disabled = true;
        try {
          const task = await api("/tasks", { method: "POST", body: JSON.stringify(body) });
          location.hash = `#/tasks/${task.id}`;
        } catch (err) {
          error.textContent = err.body?.issues ? err.body.issues.map((i) => `${i.path || t("ui.request")}: ${i.message}`).join("; ") : err.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    h("h2", {}, t("ui.newTask")),
    h("div", {}, h("label", { for: "goal" }, t("ui.goal")), goal),
    h(
      "div",
      {},
      h("label", {}, t("ui.criteriaTitle")),
      h("p", { class: "muted small" }, t("ui.criteriaHelp")),
      criteria,
      h("button", { type: "button", class: "link", onclick: addCriterion }, t("ui.addCriterion")),
    ),
    loginBox,
    chromeBox,
    jevBox,
    h(
      "details",
      {},
      h("summary", {}, t("ui.limitsSummary")),
      h("div", { class: "limits mt-sm" }, h("div", {}, h("label", { for: "spend" }, t("ui.maxSpend")), spend), h("div", {}, h("label", { for: "minutes" }, t("ui.maxMinutes")), minutes), h("div", {}, h("label", { for: "tools" }, t("ui.maxToolCalls")), tools)),
    ),
    error,
    h("div", {}, submit),
  );
}

function approvalCard(a, onDecided) {
  const ctx = a.context ?? {};
  const target = ctx.target ?? {};
  const facts = [
    [t("ui.action"), a.summary],
    target.formAction ? [t("ui.submitsTo"), `${target.formMethod ? target.formMethod.toUpperCase() + " " : ""}${target.formAction}`] : null,
    ctx.page?.url ? [t("ui.onPage"), ctx.page.url] : null,
    a.consequentialKind ? [t("ui.kind"), kindName(a.consequentialKind)] : null,
    a.tool === "browser.type_secret" ? [t("ui.secretUsed"), a.input?.secretName ?? ""] : null,
    a.tool === "browser.type_secret" && target.secretOrigin ? [t("ui.secretAllowedSite"), target.secretOrigin] : null,
  ].filter(Boolean);
  const error = h("p", { class: "error", role: "alert" });
  let armed = null;
  const approve = h("button", { class: "good", type: "button" }, t("ui.approve"));
  const reject = h("button", { class: "danger", type: "button" }, t("ui.reject"));

  // A password request: the user types the password right here, and it goes only to the browser.
  let pw = null;
  let saveBox = null;
  let saveName = null;
  let passwordBlock = null;
  if (a.needsSecret) {
    pw = h("input", { type: "password", id: `pw-${a.id}`, autocomplete: "new-password", maxlength: "1024" });
    const host = (() => {
      try {
        return new URL(target.pageOrigin).hostname.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "");
      } catch {
        return "site";
      }
    })();
    saveBox = h("input", { type: "checkbox", id: `save-${a.id}` });
    saveName = h("input", { type: "text", id: `savename-${a.id}`, maxlength: "64", value: `${host}-password`, hidden: true, "aria-label": t("ui.askPasswordSaveName") });
    saveBox.addEventListener("change", () => (saveName.hidden = !saveBox.checked));
    passwordBlock = h(
      "div",
      { class: "stack mt-sm" },
      h("div", {}, h("label", { for: `pw-${a.id}` }, t("ui.askPasswordLabel")), pw, h("div", { class: "muted small" }, t("ui.askPasswordHelp"))),
      h("div", {}, h("label", { class: "check", for: `save-${a.id}` }, saveBox, " ", t("ui.askPasswordSave")), saveName),
    );
  }

  const decide = async (decision) => {
    error.textContent = "";
    const body = { decision };
    if (a.needsSecret && decision === "approved") {
      if (!pw.value) {
        error.textContent = t("ui.passwordRequired");
        return;
      }
      body.secret = pw.value;
      if (saveBox.checked && saveName.value.trim()) body.saveAs = saveName.value.trim();
    }
    approve.disabled = reject.disabled = true;
    try {
      await api(`/approvals/${a.id}/decision`, { method: "POST", body: JSON.stringify(body) });
      if (pw) pw.value = ""; // do not keep it in the page
      onDecided();
    } catch (err) {
      approve.disabled = reject.disabled = false;
      error.textContent = err.status === 409 ? t("ui.alreadyDecided") : err.body?.issues ? err.body.issues.map((i) => i.message).join("; ") : err.message;
    }
  };
  approve.addEventListener("click", () => {
    if (armed) return (clearTimeout(armed), decide("approved"));
    approve.textContent = t("ui.clickAgain");
    armed = setTimeout(() => ((armed = null), (approve.textContent = t("ui.approve"))), 5000);
  });
  reject.addEventListener("click", () => decide("rejected"));
  return h(
    "div",
    { class: "approval", role: "group", "aria-label": t("ui.approvalRequest") },
    h("strong", {}, t("ui.nothingDone")),
    a.tool === "browser.type_secret" ? h("p", { class: "small" }, t("ui.secretWarning")) : null,
    h("dl", { class: "facts" }, facts.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
    a.screenshotId ? h("div", {}, h("div", { class: "muted small" }, t("ui.pageWhenAsked")), screenshot(a.screenshotId, t("ui.pageWhenApprovalAlt"))) : null,
    passwordBlock,
    h("details", {}, h("summary", {}, t("ui.techDetails")), h("pre", {}, JSON.stringify({ tool: a.tool, input: a.input, target }, null, 2))),
    h("div", { class: "row mt-sm" }, approve, reject),
    error,
  );
}

function taskRow(task) {
  return h(
    "li",
    {},
    h(
      "a",
      { href: `#/tasks/${task.id}` },
      h("div", { class: "row" }, badge(task.helpRequest ? "needs_help" : task.status), h("span", { class: "muted small" }, fmtDateTime(task.createdAt))),
      h("div", { class: "goal" }, clipText(task.goal, 160)),
    ),
  );
}

async function viewList() {
  const mine = ++navToken;
  const approvalsBox = h("div");
  const tasksBox = h("div");
  const quotaBox = h("div");
  // Who may start work: a person on a server running someone's personal Claude login can only look around.
  const newTask = newTaskCard();
  mount(shell(quotaBox, approvalsBox, newTask, h("section", { class: "card" }, h("h2", {}, t("ui.yourTasks")), tasksBox)));

  let last = "";
  const load = async () => {
    try {
      const [{ approvals }, { tasks }, me] = await Promise.all([api("/approvals"), api("/tasks?limit=50"), api("/me")]);
      if (mine !== navToken) return;
      clear(quotaBox);
      newTask.hidden = Boolean(me.blocked);
      if (me.blocked) {
        quotaBox.append(h("div", { class: "banner warn", role: "status" }, h("div", {}, t("ui.needsKeyBanner")), byok ? h("a", { href: "#/settings" }, t("ui.settingsLink")) : null));
      } else if (me.limits) {
        quotaBox.append(
          h(
            "p",
            { class: "muted small", role: "status" },
            me.limits.dailySpendUsd === null
              ? t("ui.quotaLineOwnKey", { active: me.usage.activeTasks, max: me.limits.maxConcurrent })
              : t("ui.quotaLine", { spend: me.usage.spendTodayUsd.toFixed(2), cap: me.limits.dailySpendUsd.toFixed(2), active: me.usage.activeTasks, max: me.limits.maxConcurrent }),
          ),
        );
      }
      const snapshot = JSON.stringify([approvals, tasks]);
      if (snapshot !== last) {
        last = snapshot;
        clear(approvalsBox);
        if (approvals.length) {
          approvalsBox.append(
            h(
              "section",
              { class: "card", "aria-live": "polite" },
              h("h2", {}, t("ui.waitingDecision", { n: approvals.length })),
              approvals.map((a) => h("div", { class: "stack mt-sm" }, h("a", { href: `#/tasks/${a.taskId}`, class: "small" }, t("ui.viewTask")), approvalCard(a, load))),
            ),
          );
        }
        clear(tasksBox);
        tasksBox.append(tasks.length ? h("ul", { class: "task-list" }, tasks.map(taskRow)) : h("p", { class: "empty" }, t("ui.noTasks")));
      }
    } catch (err) {
      if (err.status === 401) return;
      if (mine === navToken) tasksBox.replaceChildren(h("p", { class: "error" }, t("ui.loadFailed")));
      last = "";
    }
    if (mine === navToken) schedule(load, 4000);
  };
  load();
}

// ---- task detail -------------------------------------------------------------------------

function timelineItem(item, openSet) {
  const body = [];
  if (item.lines.length) body.push(h("div", { class: "lines" }, item.lines.map((l) => h("div", {}, l))));
  if (item.snapshot) {
    const d = h("details", {}, h("summary", {}, t("ui.showPageContent")), h("pre", {}, item.snapshot));
    if (openSet.has(item.seq)) d.open = true;
    d.addEventListener("toggle", () => (d.open ? openSet.add(item.seq) : openSet.delete(item.seq)));
    body.push(d);
  }
  for (const art of item.artifacts ?? []) {
    if (art.kind === "screenshot") {
      const key = `a:${art.id}`;
      const d = h("details", {}, h("summary", {}, t("ui.showScreenshot")));
      const load = () => d.querySelector(".shot-wrap") || d.append(screenshot(art.id, artifactLabel(art.label)));
      d.addEventListener("toggle", () => {
        if (d.open) (openSet.add(key), load());
        else openSet.delete(key);
      });
      if (openSet.has(key)) ((d.open = true), load());
      body.push(d);
    } else {
      body.push(h("div", {}, h("button", { class: "link", type: "button", onclick: () => saveArtifact(art.id, `page-text-${art.id.slice(0, 8)}.txt`) }, t("ui.downloadPageText"))));
    }
  }
  return h("li", { class: item.tone === "neutral" ? "" : item.tone }, h("div", { class: "title" }, item.title, h("span", { class: "time" }, fmtTime(item.at))), ...body);
}


// ---- live browser: watch the agent's browser, or take it over ------------------------------

const KEY_NAMES = new Set(["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

/**
 * One panel per task page. It polls a JPEG of the sandboxed browser and, only while the task is
 * under human control, forwards clicks and keystrokes. It never stores what is typed.
 */
function livePanel(id, alive, onChanged) {
  let status = "";
  let watching = false;
  let loopRunning = false;
  let frameSize = { width: 1280, height: 800 };
  let haveFrame = false; // nothing to show (and no empty box) until the first picture arrives
  let queue = Promise.resolve();

  const msg = h("p", { class: "muted small" });
  const help = h("p", { class: "banner warn help-banner", role: "status", hidden: true });
  const err = h("p", { class: "error small", role: "alert" });
  const img = h("img", { class: "live-frame", alt: t("ui.live.frameAlt"), draggable: false });
  // A real (invisible) text field receives the keyboard: that is what makes phone keyboards, input
  // methods and paste work. Whatever lands in it is forwarded at once and cleared; it is never kept.
  const keys = h("textarea", { class: "live-keys", "aria-label": t("ui.live.frameAlt"), autocomplete: "off", autocapitalize: "off", spellcheck: "false", rows: "1" });
  const frameBox = h("div", { class: "live-box" }, img, keys);
  const takeBtn = h("button", { type: "button", class: "primary" }, t("ui.live.take"));
  const watchBtn = h("button", { type: "button", class: "secondary" }, t("ui.live.watch"));
  const textIn = h("input", { type: "text", autocomplete: "off", placeholder: t("ui.live.textPlaceholder"), class: "grow" });
  const hide = h("input", { type: "checkbox" });
  const sendBtn = h("button", { type: "button" }, t("ui.live.sendText"));
  const noteIn = h("input", { type: "text", maxlength: "500", placeholder: t("ui.live.notePlaceholder"), class: "grow" });
  const releaseBtn = h("button", { type: "button", class: "primary" }, t("ui.live.release"));
  const keyBtns = ["Enter", "Tab", "Backspace"].map((k) => {
    const b = h("button", { type: "button", class: "secondary" }, k === "Backspace" ? "⌫" : k);
    b.addEventListener("click", () => send({ type: "key", key: k }));
    return b;
  });
  // Keep the login made by hand: only the open page's own site is saved, under a name the owner picks.
  const loginName = h("input", { type: "text", maxlength: "64", autocomplete: "off", placeholder: t("ui.saveLoginName"), class: "grow", "aria-label": t("ui.saveLoginName") });
  const loginSave = h("button", { type: "button" }, t("ui.saveLoginButton"));
  const loginMsg = h("p", { class: "small", role: "status" });
  loginSave.addEventListener("click", async () => {
    loginMsg.textContent = "";
    err.textContent = "";
    loginSave.disabled = true;
    try {
      const saved = await api(`/tasks/${id}/control/save-login`, { method: "POST", body: JSON.stringify({ name: loginName.value.trim() }) });
      loginMsg.textContent = t("ui.saveLoginDone", { origin: saved.origin });
      loginName.value = "";
      onChanged();
    } catch (e) {
      err.textContent = e.status === 503 ? t("ui.loginsDisabled") : e.body?.issues ? e.body.issues.map((i) => i.message).join("; ") : e.message;
    } finally {
      loginSave.disabled = false;
    }
  });
  const keepLogin = h("details", { class: "stack" }, h("summary", {}, t("ui.saveLoginTitle")), h("p", { class: "muted small" }, t("ui.saveLoginHelp")), h("div", { class: "row" }, loginName, loginSave), loginMsg);
  const controls = h("div", { class: "stack" },
    h("div", { class: "row" }, textIn, h("label", { class: "small row" }, hide, t("ui.live.hideText")), sendBtn, keyBtns),
    keepLogin,
    h("div", { class: "row" }, noteIn, releaseBtn),
  );
  const root = h("section", { class: "card stack", hidden: true }, h("h2", {}, t("ui.live.title")), help, msg, h("div", { class: "row" }, takeBtn, watchBtn), frameBox, controls, err);

  const inControl = () => status === "human_control";
  const canSee = () => ["running", "awaiting_approval", "human_control"].includes(status);

  hide.addEventListener("change", () => (textIn.type = hide.checked ? "password" : "text"));

  // Input is sent one at a time, in order, so typed characters can never be reordered.
  const send = (input) => {
    if (!inControl()) return;
    queue = queue
      .then(() => api(`/tasks/${id}/control/input`, { method: "POST", body: JSON.stringify(input) }))
      .catch((e) => {
        err.textContent = e.status === 409 ? t("ui.live.unavailable") : e.message;
      });
  };

  frameBox.addEventListener("click", (ev) => {
    if (!inControl()) return;
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    keys.focus({ preventScroll: true });
    send({ type: "click", x: Math.round((ev.clientX - r.left) * (frameSize.width / r.width)), y: Math.round((ev.clientY - r.top) * (frameSize.height / r.height)) });
  });
  const flushTyped = () => {
    const text = keys.value.slice(0, 500);
    keys.value = "";
    if (text) send({ type: "text", text });
  };
  keys.addEventListener("input", (ev) => {
    if (!ev.isComposing) flushTyped();
  });
  keys.addEventListener("compositionend", flushTyped);
  keys.addEventListener("keydown", (ev) => {
    if (!inControl() || ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing || !KEY_NAMES.has(ev.key)) return;
    send({ type: "key", key: ev.key });
    ev.preventDefault();
  });
  frameBox.addEventListener(
    "wheel",
    (ev) => {
      if (!inControl()) return;
      ev.preventDefault();
      const r = img.getBoundingClientRect();
      send({ type: "scroll", x: Math.round(((ev.clientX - r.left) * frameSize.width) / (r.width || 1)), y: Math.round(((ev.clientY - r.top) * frameSize.height) / (r.height || 1)), dx: Math.round(ev.deltaX), dy: Math.round(ev.deltaY) });
    },
    { passive: false },
  );
  sendBtn.addEventListener("click", () => {
    if (!textIn.value) return;
    send({ type: "text", text: textIn.value.slice(0, 500) });
    textIn.value = "";
  });
  textIn.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") sendBtn.click();
  });

  takeBtn.addEventListener("click", async () => {
    takeBtn.disabled = true;
    err.textContent = "";
    try {
      await api(`/tasks/${id}/control/take`, { method: "POST" });
    } catch (e) {
      err.textContent = e.status === 409 ? t("ui.live.cannotTake") : e.message;
    }
    takeBtn.disabled = false;
    onChanged();
  });
  releaseBtn.addEventListener("click", async () => {
    releaseBtn.disabled = true;
    err.textContent = "";
    try {
      await api(`/tasks/${id}/control/release`, { method: "POST", body: JSON.stringify(noteIn.value.trim() ? { note: noteIn.value.trim() } : {}) });
      noteIn.value = "";
      watching = false;
    } catch (e) {
      err.textContent = e.message;
    }
    releaseBtn.disabled = false;
    onChanged();
  });
  watchBtn.addEventListener("click", () => {
    watching = !watching;
    sync();
    if (watching) loop();
  });

  let lastUrl = null;
  async function loop() {
    if (loopRunning) return;
    loopRunning = true;
    try {
      while (alive() && canSee() && (watching || inControl())) {
        try {
          const res = await fetch(`/tasks/${id}/live`, { headers: { authorization: `Bearer ${token}` } });
          if (res.status === 401) return signOut();
          if (!res.ok) {
            err.textContent = res.status === 409 ? t("ui.live.unavailable") : "";
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          err.textContent = "";
          frameSize = { width: Number(res.headers.get("x-frame-width")) || 1280, height: Number(res.headers.get("x-frame-height")) || 800 };
          const url = URL.createObjectURL(await res.blob());
          img.src = url;
          if (!haveFrame) {
            haveFrame = true;
            sync();
          }
          if (lastUrl) URL.revokeObjectURL(lastUrl);
          lastUrl = url;
        } catch {
          await new Promise((r) => setTimeout(r, 2000));
        }
        await new Promise((r) => setTimeout(r, inControl() ? 350 : 1000));
      }
    } finally {
      loopRunning = false;
    }
  }

  function sync() {
    root.hidden = !canSee();
    takeBtn.hidden = status !== "running";
    watchBtn.hidden = inControl();
    watchBtn.textContent = watching ? t("ui.live.stopWatching") : t("ui.live.watch");
    controls.hidden = !inControl();
    frameBox.hidden = !((watching || inControl()) && haveFrame);
    frameBox.classList.toggle("live-controlled", inControl());
    msg.textContent = inControl() ? t("ui.live.controlHint") : status === "running" ? t("ui.live.takeHint") : "";
  }

  return {
    node: root,
    update(task) {
      const before = status;
      status = task.status;
      help.hidden = !(task.helpRequest && inControl());
      help.textContent = task.helpRequest ? (task.helpRequest.reason ? t("ui.live.helpBanner", { reason: task.helpRequest.reason }) : t("ui.live.helpBannerNoReason")) : "";
      if (inControl() && before !== "human_control") watching = true;
      sync();
      if (watching || inControl()) loop();
    },
  };
}

async function viewTask(id) {
  const mine = ++navToken;
  const bannerBox = h("div");
  const continueBox = h("div");
  const approvalBox = h("div");
  const live = livePanel(id, () => mine === navToken, () => load());
  const headBox = h("div");
  const timelineBox = h("ol", { class: "timeline", "aria-label": t("ui.whatHappened") });
  const rawBox = h("pre", { hidden: true });
  const filesBox = h("div");
  const openSet = new Set();
  const errorBox = h("p", { class: "error", role: "alert" });

  const rawToggle = h("button", { class: "link", type: "button" }, t("ui.showRaw"));
  rawToggle.addEventListener("click", async () => {
    if (rawBox.hidden) {
      const { events } = await api(`/tasks/${id}/events?limit=500`);
      rawBox.textContent = JSON.stringify(events, null, 2);
      rawBox.hidden = false;
      rawToggle.textContent = t("ui.hideRaw");
    } else {
      rawBox.hidden = true;
      rawToggle.textContent = t("ui.showRaw");
    }
  });

  mount(
    shell(
      h("p", { class: "small mt-md" }, h("a", { href: "#/" }, t("ui.allTasks"))),
      headBox,
      bannerBox,
      continueBox,
      live.node,
      approvalBox,
      h("section", { class: "card" }, h("h2", {}, t("ui.whatHappened")), h("div", { class: "mt-sm" }, timelineBox), errorBox),
      filesBox,
      h("section", { class: "card" }, rawToggle, rawBox),
    ),
  );

  let last = "";
  const load = async () => {
    try {
      const [task, tl] = await Promise.all([api(`/tasks/${id}`), api(`/tasks/${id}/timeline`)]);
      if (mine !== navToken) return;
      errorBox.textContent = "";
      const snapshot = JSON.stringify([task, tl]);
      if (snapshot !== last) {
        last = snapshot;
        paint(task, tl);
      }
      live.update(task);
      if (isActive(task.status)) schedule(load, 2000);
    } catch (err) {
      if (err.status === 401) return;
      if (err.status === 404) return void headBox.replaceChildren(h("div", { class: "card" }, h("h2", {}, t("ui.taskNotFound"))));
      errorBox.textContent = t("ui.connectionProblem");
      if (mine === navToken) schedule(load, 3000);
    }
  };

  const paint = (task, tl) => {
    const cancel = h("button", { class: "danger", type: "button" }, t("ui.cancelTask"));
    cancel.addEventListener("click", async () => {
      if (!confirm(t("ui.cancelConfirm"))) return;
      cancel.disabled = true;
      try {
        await api(`/tasks/${id}/cancel`, { method: "POST" });
      } catch (err) {
        errorBox.textContent = err.status === 409 ? t("ui.taskAlreadyEnded") : err.message;
      }
      load();
    });
    const criteria = task.completionCriteria ?? [];
    clear(headBox);
    headBox.append(
      h(
        "section",
        { class: "card stack" },
        h("div", { class: "row" }, badge(task.helpRequest ? "needs_help" : task.status, tl.outcome), h("span", { class: "muted small" }, t("ui.startedAt", { time: fmtDateTime(task.createdAt) })), h("span", { class: "grow" }), isActive(task.status) ? cancel : null),
        h("h1", { class: "task-title" }, task.goal),
        task.parentTaskId ? h("div", { class: "small" }, `${t("ui.continuedFrom")} · `, h("a", { href: `#/tasks/${task.parentTaskId}` }, t("ui.viewEarlier"))) : null,
        task.continuations.length
          ? h("div", { class: "small" }, `${t("ui.continuedBy")}: `, task.continuations.map((c) => h("a", { href: `#/tasks/${c.id}`, class: "chip-link" }, badge(c.status)))
          )
          : null,
        criteria.length
          ? h("div", {}, h("div", { class: "muted small" }, t("ui.countsAsDone")), h("ul", { class: "tight-list" }, criteria.map((c) => h("li", {}, c.kind === "answer_grounded" ? t("ui.doneWhenGrounded") : c.kind === "url_contains" ? t("ui.doneWhenUrl", { value: c.value }) : t("ui.doneWhenText", { value: c.value })))))
          : h("div", { class: "muted small" }, t("ui.criteriaWillBeProposed")),
        h(
          "div",
          { class: "stats" },
          h("div", {}, h("span", { class: "num" }, fmtMoney(tl.summary.costUsd)), h("span", { class: "muted small" }, t("ui.aiCost"))),
          h("div", {}, h("span", { class: "num" }, tl.summary.toolCalls), h("span", { class: "muted small" }, t("ui.actionsTaken"))),
          task.limits ? h("div", {}, h("span", { class: "num" }, fmtMoney(task.limits.maxSpendUsd)), h("span", { class: "muted small" }, t("ui.spendLimit"))) : null,
        ),
      ),
    );

    clear(bannerBox);
    if (tl.outcome) {
      bannerBox.append(
        h(
          "div",
          { class: `banner ${tl.outcome.tone}`, role: "status" },
          h("h2", {}, tl.outcome.headline),
          h("div", {}, tl.outcome.detail),
          tl.outcome.unmet.length ? h("ul", {}, tl.outcome.unmet.map((u) => h("li", {}, t("ui.notMet", { text: u })))) : null,
          tl.outcome.report ? h("div", { class: "report" }, h("div", { class: "muted small" }, t("ui.agentReport")), h("div", { class: "report-text" }, tl.outcome.report)) : null,
        ),
      );
    }

    clear(continueBox);
    if (task.status === "unverified") {
      continueBox.append(
        h(
          "section",
          { class: "card" },
          task.acknowledgedAt
            ? h("p", { class: "muted small" }, t("ui.acknowledged"))
            : h("button", { type: "button", onclick: async (e) => { e.target.disabled = true; try { await api(`/tasks/${id}/acknowledge`, { method: "POST" }); await load(); } catch (ex) { e.target.disabled = false; alert(ex.message); } } }, t("ui.acknowledge")),
        ),
      );
    }
    if (task.status === "failed" || task.status === "cancelled" || task.status === "unverified") {
      const mustShow = task.status === "unverified" ? h("input", { id: "cmust", type: "text", maxlength: "200" }) : null;
      const note = h("textarea", { id: "cnote", maxlength: "2000", placeholder: t("ui.continueNotePlaceholder") });
      const err = h("p", { class: "error", role: "alert" });
      const go = h("button", { class: "primary", type: "submit" }, t("ui.continueStart"));
      continueBox.append(
        h(
          "section",
          { class: "card" },
          h(
            "details",
            {},
            h("summary", {}, t("ui.continueTask")),
            h(
              "form",
              {
                class: "stack mt-sm",
                onsubmit: async (e) => {
                  e.preventDefault();
                  err.textContent = "";
                  go.disabled = true;
                  try {
                    const body = note.value.trim() ? { note: note.value.trim() } : {};
                    if (mustShow && mustShow.value.trim()) body.mustShow = mustShow.value.trim();
                    const next = await api(`/tasks/${id}/continue`, { method: "POST", body: JSON.stringify(body) });
                    location.hash = `#/tasks/${next.id}`;
                  } catch (ex) {
                    err.textContent = ex.status === 409 ? t("ui.taskAlreadyEnded") : ex.message;
                    go.disabled = false;
                  }
                },
              },
              h("p", { class: "muted small" }, t("ui.continueHelp")),
              mustShow ? h("div", {}, h("label", { for: "cmust" }, t("ui.continueCriterion")), mustShow) : null,
              h("div", {}, h("label", { for: "cnote" }, t("ui.continueNote")), note),
              err,
              h("div", {}, go),
            ),
          ),
        ),
      );
    }

    clear(approvalBox);
    if (task.pendingApprovals.length) {
      approvalBox.append(h("section", { class: "card", "aria-live": "polite" }, h("h2", {}, t("ui.yourDecisionNeeded")), h("div", { class: "mt-sm" }, task.pendingApprovals.map((a) => approvalCard(a, load)))));
    }

    clear(timelineBox);
    timelineBox.append(...tl.items.map((i) => timelineItem(i, openSet)));

    clear(filesBox);
    if (task.artifacts.length) {
      filesBox.append(
        h(
          "section",
          { class: "card" },
          h("h2", {}, t("ui.evidenceAndFiles", { n: task.artifacts.length })),
          h("p", { class: "muted small" }, t("ui.evidenceNote")),
          h(
            "ul",
            { class: "files" },
            task.artifacts.map((a) =>
              h(
                "li",
                {},
                h("span", { class: "file-name" }, t(a.kind === "screenshot" ? "ui.fileScreenshot" : "ui.filePageText", { label: artifactLabel(a.label) })),
                h("span", { class: "muted small" }, `${fmtBytes(a.sizeBytes)} · ${fmtTime(a.createdAt)}`),
                a.kind === "page_text" ? h("button", { class: "link", type: "button", onclick: () => saveArtifact(a.id, `page-text-${a.id.slice(0, 8)}.txt`) }, t("ui.download")) : null,
                h(
                  "button",
                  {
                    class: "link danger-link",
                    type: "button",
                    onclick: async () => {
                      if (!confirm(t("ui.deleteConfirm"))) return;
                      try {
                        await api(`/artifacts/${a.id}`, { method: "DELETE" });
                      } catch (err) {
                        errorBox.textContent = err.message;
                      }
                      last = "";
                      load();
                    },
                  },
                  t("ui.delete"),
                ),
              ),
            ),
          ),
        ),
      );
    }
  };

  load();
}

// ---- saved credentials -------------------------------------------------------------------


// ---- users (admin) -----------------------------------------------------------------------

async function viewUsers() {
  const mine = ++navToken;
  const listBox = h("div");
  const tokenBox = h("div");
  const formError = h("p", { class: "error", role: "alert" });
  const name = h("input", { type: "text", id: "uname", maxlength: "32", autocomplete: "off", required: true, pattern: "[a-z0-9][a-z0-9_-]{1,31}" });
  const email = h("input", { type: "email", id: "uemail", maxlength: "200", autocomplete: "off" });
  const roleSel = h("select", { id: "urole" }, h("option", { value: "user" }, t("ui.roleUser")), h("option", { value: "admin" }, t("ui.roleAdmin")));
  const maxC = h("input", { type: "number", id: "umax", min: "1", max: "50", step: "1" });
  const spend = h("input", { type: "number", id: "uspend", min: "0", max: "1000", step: "0.01" });
  const create = h("button", { class: "primary", type: "submit" }, t("ui.createUser"));

  // The token exists only on this screen, only now: it is not stored anywhere that can show it again.
  const showToken = (who, token) => {
    const field = h("input", { type: "text", readonly: true, value: token, "aria-label": who, class: "grow mono" });
    const copyBtn = h("button", { type: "button" }, t("ui.copy"));
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(token);
        copyBtn.textContent = t("ui.copied");
      } catch {
        field.select();
      }
    });
    clear(tokenBox);
    tokenBox.append(h("section", { class: "card stack banner warn" }, h("h2", {}, who), h("p", { class: "small" }, t("ui.tokenShownOnce")), h("div", { class: "row" }, field, copyBtn), h("p", { class: "muted small" }, t("ui.shareHow"))));
    field.focus();
    field.select();
  };

  const num = (el) => (el.value.trim() === "" ? null : Number(el.value));
  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: async (e) => {
        e.preventDefault();
        formError.textContent = "";
        create.disabled = true;
        try {
          const body = { name: name.value.trim(), role: roleSel.value, maxConcurrent: num(maxC), dailySpendUsd: num(spend) };
          if (email.value.trim()) body.email = email.value.trim();
          const res = await api("/admin/users", { method: "POST", body: JSON.stringify(body) });
          showToken(res.user.owner, res.token);
          for (const el of [name, email, maxC, spend]) el.value = "";
          await load();
        } catch (err) {
          formError.textContent = err.body?.issues ? err.body.issues.map((i) => i.message).join("; ") : err.message;
        } finally {
          create.disabled = false;
        }
      },
    },
    h("div", {}, h("label", { for: "uname" }, t("ui.userName")), name, h("div", { class: "muted small" }, t("ui.userNameHelp"))),
    h("div", {}, h("label", { for: "uemail" }, t("ui.userEmail")), email),
    h("div", {}, h("label", { for: "urole" }, t("ui.userRole")), roleSel),
    h("div", { class: "row" }, h("div", {}, h("label", { for: "umax" }, t("ui.userMaxConcurrent")), maxC), h("div", {}, h("label", { for: "uspend" }, t("ui.userDailySpend")), spend)),
    formError,
    h("div", {}, create),
  );

  mount(shell(h("section", { class: "card stack" }, h("h2", {}, t("ui.users")), h("p", { class: "muted small" }, t("ui.usersIntro")), h("h3", {}, t("ui.addUser")), form), tokenBox, h("section", { class: "card" }, listBox)));

  const patch = async (u, body) => {
    formError.textContent = "";
    try {
      await api(`/admin/users/${encodeURIComponent(u.owner)}`, { method: "PATCH", body: JSON.stringify(body) });
    } catch (err) {
      formError.textContent = err.body?.message ?? err.message;
    }
    load();
  };
  const askNumber = (message, current, integer) => {
    const answer = prompt(message, current ?? "");
    if (answer === null) return undefined; // cancelled
    if (answer.trim() === "") return null; // back to the server default
    const n = Number(answer);
    return Number.isFinite(n) && n >= (integer ? 1 : 0) ? (integer ? Math.round(n) : n) : undefined;
  };

  const row = (u) => {
    const usage = u.limits
      ? t("ui.userUsage", { active: u.usage.activeTasks, max: u.limits.maxConcurrent, spend: u.usage.spendTodayUsd.toFixed(2), cap: u.limits.dailySpendUsd === null ? "∞" : u.limits.dailySpendUsd.toFixed(2) })
      : t("ui.userUnlimited");
    return h(
      "li",
      { class: "user-row" },
      h(
        "div",
        { class: "grow stack-tight" },
        h("div", {}, h("strong", {}, u.owner), " ", u.role === "admin" ? h("span", { class: "badge" }, t("ui.roleBadgeAdmin")) : null, u.disabled ? h("span", { class: "badge bad" }, t("ui.userDisabled")) : null),
        h("div", { class: "muted small" }, [u.email, usage, u.lastSeenAt ? t("ui.userLastSeen", { time: fmtDateTime(u.lastSeenAt) }) : t("ui.userNeverSeen")].filter(Boolean).join(" · ")),
      ),
      h("button", { type: "button", class: "link", onclick: () => patch(u, { disabled: !u.disabled }) }, u.disabled ? t("ui.enableUser") : t("ui.disableUser")),
      h(
        "button",
        {
          type: "button",
          class: "link",
          onclick: async () => {
            const c = askNumber(t("ui.limitsPromptConcurrent", { name: u.owner }), u.maxConcurrent, true);
            if (c === undefined) return;
            const s = askNumber(t("ui.limitsPromptSpend", { name: u.owner }), u.dailySpendUsd, false);
            if (s === undefined) return;
            patch(u, { maxConcurrent: c, dailySpendUsd: s });
          },
        },
        t("ui.editLimits"),
      ),
      h(
        "button",
        {
          type: "button",
          class: "link",
          onclick: async () => {
            if (!confirm(t("ui.rotateConfirm", { name: u.owner }))) return;
            try {
              const res = await api(`/admin/users/${encodeURIComponent(u.owner)}/token`, { method: "POST" });
              showToken(u.owner, res.token);
            } catch (err) {
              formError.textContent = err.message;
            }
          },
        },
        t("ui.rotateToken"),
      ),
    );
  };

  const load = async () => {
    try {
      const { users, envAdmins } = await api("/admin/users");
      if (mine !== navToken) return;
      clear(listBox);
      listBox.append(
        users.length ? h("ul", { class: "files" }, users.map(row)) : h("p", { class: "empty" }, t("ui.noUsers")),
        envAdmins.length ? h("p", { class: "muted small" }, t("ui.envAdmins", { names: envAdmins.join(", ") })) : null,
      );
    } catch (err) {
      if (err.status === 401) return;
      listBox.replaceChildren(h("p", { class: "error" }, err.status === 409 ? err.body?.message ?? err.message : t("ui.connectionProblem")));
    }
  };
  load();
}


// ---- my API key (bring your own key) ------------------------------------------------------

async function viewSettings() {
  const mine = ++navToken;
  const statusBox = h("p", { class: "small", role: "status" });
  const formError = h("p", { class: "error", role: "alert" });
  const formOk = h("p", { class: "small", role: "status" });
  const key = h("input", { type: "password", id: "apikey", maxlength: "400", autocomplete: "off", required: true, spellcheck: "false" });
  const save = h("button", { class: "primary", type: "submit" }, t("ui.apiKeySave"));
  const remove = h("button", { type: "button", class: "danger", hidden: true }, t("ui.apiKeyDelete"));

  const show = (status) => {
    statusBox.textContent = status.saved ? t("ui.apiKeySaved", { hint: status.hint }) : t("ui.apiKeyNone");
    remove.hidden = !status.saved;
  };
  const load = async () => {
    try {
      const me = await api("/me");
      if (mine === navToken) show(me.apiKey ?? { saved: false });
    } catch (err) {
      if (err.status !== 401) formError.textContent = t("ui.connectionProblem");
    }
  };

  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: async (e) => {
        e.preventDefault();
        formError.textContent = "";
        formOk.textContent = "";
        save.disabled = true;
        try {
          const res = await api("/me/api-key", { method: "PUT", body: JSON.stringify({ apiKey: key.value.trim() }) });
          key.value = ""; // never keep it around in the page
          show(res.apiKey);
          formOk.textContent = t("ui.apiKeyDone");
        } catch (err) {
          formError.textContent = err.status === 503 ? t("ui.apiKeyDisabled") : err.body?.issues ? err.body.issues.map((i) => i.message).join("; ") : err.message;
        } finally {
          save.disabled = false;
        }
      },
    },
    h("div", {}, h("label", { for: "apikey" }, t("ui.apiKeyField")), key),
    formError,
    formOk,
    h("div", { class: "row" }, save, remove),
  );
  remove.addEventListener("click", async () => {
    if (!confirm(t("ui.apiKeyDeleteConfirm"))) return;
    formError.textContent = "";
    try {
      await api("/me/api-key", { method: "DELETE" });
      formOk.textContent = "";
      show({ saved: false });
    } catch (err) {
      formError.textContent = err.message;
    }
  });

  mount(shell(h("section", { class: "card stack" }, h("h2", {}, t("ui.settings")), h("p", { class: "muted small" }, t("ui.apiKeyIntro")), statusBox, form, h("p", { class: "muted small" }, t("ui.apiKeyPrivacy")))));
  load();
}


// ---- schedules: tasks that start themselves ----------------------------------------------

async function viewSchedules() {
  const mine = ++navToken;
  const listBox = h("div");
  const formError = h("p", { class: "error", role: "alert" });
  const formOk = h("p", { class: "small", role: "status" });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const name = h("input", { type: "text", id: "sname2", maxlength: "80", required: true });
  const goal = h("textarea", { id: "sgoal", required: true, maxlength: "10000", placeholder: t("ui.goalPlaceholder") });
  const criteria = h("div", { class: "stack" });
  const kind = h("select", { id: "skind" }, h("option", { value: "daily" }, t("ui.schedDaily")), h("option", { value: "weekly" }, t("ui.schedWeekly")), h("option", { value: "interval" }, t("ui.schedInterval")));
  const time = h("input", { type: "time", id: "stime", value: "08:00", required: true });
  const days = [0, 1, 2, 3, 4, 5, 6].map((d) => h("input", { type: "checkbox", value: String(d), ...(d >= 1 && d <= 5 ? { checked: true } : {}) }));
  const dayRow = h("div", { class: "row small" }, days.map((box, d) => h("label", { class: "row" }, box, t(`ui.schedDay${d}`))));
  const every = h("input", { type: "number", id: "severy", min: "15", max: "10080", step: "5", value: "60" });
  const tz = h("input", { type: "text", id: "stz", maxlength: "64", value: zone, required: true });
  const spend = h("input", { type: "number", id: "sspend", min: "0.01", step: "0.01", placeholder: t("ui.default") });
  const create = h("button", { class: "primary", type: "submit" }, t("ui.schedCreate"));
  const timeRow = h("div", {}, h("label", { for: "stime" }, t("ui.schedTime")), time);
  const dayWrap = h("div", { hidden: true }, h("label", {}, t("ui.schedDays")), dayRow);
  const everyWrap = h("div", { hidden: true }, h("label", { for: "severy" }, t("ui.schedEvery")), every);
  const syncKind = () => {
    timeRow.hidden = kind.value === "interval";
    dayWrap.hidden = kind.value !== "weekly";
    everyWrap.hidden = kind.value !== "interval";
  };
  kind.addEventListener("change", syncKind);

  // Saved logins a scheduled task may start signed in with (ticked ones only).
  const loginBox = h("div", { hidden: true });
  const loginChecks = [];
  api("/logins")
    .then(({ logins }) => {
      if (!logins.length) return;
      for (const l of logins) {
        const box = h("input", { type: "checkbox", value: l.name });
        loginChecks.push(box);
        loginBox.append(h("label", { class: "row small" }, box, `${l.name} (${l.origin})`));
      }
      loginBox.prepend(h("label", {}, t("ui.useLogins")));
      loginBox.hidden = false;
    })
    .catch(() => {});

  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: async (e) => {
        e.preventDefault();
        formError.textContent = "";
        formOk.textContent = "";
        create.disabled = true;
        try {
          const schedule =
            kind.value === "interval"
              ? { type: "interval", everyMinutes: Number(every.value) }
              : kind.value === "weekly"
                ? { type: "weekly", days: days.filter((b) => b.checked).map((b) => Number(b.value)), time: time.value }
                : { type: "daily", time: time.value };
          const completionCriteria = [...criteria.children].map((r) => r.read()).filter((c) => c.value);
          const picked = loginChecks.filter((c) => c.checked).map((c) => c.value);
          const body = {
            name: name.value.trim(),
            goal: goal.value.trim(),
            schedule,
            timezone: tz.value.trim(),
            ...(completionCriteria.length ? { completionCriteria } : {}),
            ...(spend.value ? { limits: { maxSpendUsd: Number(spend.value) } } : {}),
            ...(picked.length ? { logins: picked } : {}),
          };
          await api("/schedules", { method: "POST", body: JSON.stringify(body) });
          name.value = "";
          goal.value = "";
          criteria.replaceChildren();
          await load();
        } catch (err) {
          formError.textContent = err.status === 503 ? t("ui.connectionProblem") : err.body?.issues ? err.body.issues.map((i) => `${i.path || t("ui.request")}: ${i.message}`).join("; ") : err.body?.message ?? err.message;
        } finally {
          create.disabled = false;
        }
      },
    },
    h("div", {}, h("label", { for: "sname2" }, t("ui.schedName")), name),
    h("div", {}, h("label", { for: "sgoal" }, t("ui.schedGoal")), goal),
    h("div", {}, h("label", {}, t("ui.criteriaTitle")), h("p", { class: "muted small" }, t("ui.criteriaHelp")), criteria, h("button", { type: "button", class: "link", onclick: () => criteria.append(criterionRow()) }, t("ui.addCriterion"))),
    h("div", { class: "row" }, h("div", {}, h("label", { for: "skind" }, t("ui.schedWhen")), kind), timeRow, everyWrap, h("div", {}, h("label", { for: "stz" }, t("ui.schedZone")), tz)),
    dayWrap,
    loginBox,
    h("div", {}, h("label", { for: "sspend" }, t("ui.maxSpend")), spend),
    formError,
    formOk,
    h("div", {}, create),
  );

  mount(shell(h("section", { class: "card stack" }, h("h2", {}, t("ui.schedules")), h("p", { class: "muted small" }, t("ui.schedulesIntro")), h("h3", {}, t("ui.newSchedule")), form), h("section", { class: "card" }, listBox)));

  const describe = (spec) =>
    spec.type === "interval"
      ? t("ui.schedDescInterval", { n: spec.everyMinutes })
      : spec.type === "daily"
        ? t("ui.schedDescDaily", { time: spec.time })
        : t("ui.schedDescWeekly", { days: [...spec.days].sort().map((d) => t(`ui.schedDay${d}`)).join("·"), time: spec.time });
  const outcome = (o) => t(`ui.schedOut.${o}`);

  const act = async (fn) => {
    formError.textContent = "";
    formOk.textContent = "";
    try {
      await fn();
    } catch (err) {
      formError.textContent = err.body?.message ?? err.message;
    }
    load();
  };

  const row = (s) => {
    const runsBox = h("div", { class: "small" });
    const details = h("details", {}, h("summary", { class: "small" }, t("ui.schedRuns")), runsBox);
    details.addEventListener("toggle", async () => {
      if (!details.open) return;
      try {
        const { runs } = await api(`/schedules/${s.id}/runs`);
        runsBox.replaceChildren(
          runs.length
            ? h("ul", { class: "tight-list" }, runs.map((r) => h("li", {}, `${fmtDateTime(r.ranAt)} · ${outcome(r.outcome)}`, r.taskId ? [" · ", h("a", { href: `#/tasks/${r.taskId}` }, r.taskStatus ?? "")] : null, r.detail ? h("div", { class: "muted" }, r.detail) : null)))
            : h("p", { class: "empty" }, t("ui.schedNoRuns")),
        );
      } catch {
        runsBox.replaceChildren(h("p", { class: "error" }, t("ui.connectionProblem")));
      }
    });
    const last = s.lastRun
      ? [t("ui.schedLast", { outcome: outcome(s.lastRun.outcome) }), s.lastRun.taskId ? h("a", { href: `#/tasks/${s.lastRun.taskId}` }, ` (${s.lastRun.taskStatus ?? "…"})`) : null]
      : [t("ui.schedNever")];
    return h(
      "li",
      { class: "user-row" },
      h(
        "div",
        { class: "grow stack-tight" },
        h("div", {}, h("strong", {}, s.name), " ", s.enabled ? null : h("span", { class: "badge bad" }, t("ui.schedPaused"))),
        h("div", { class: "muted small" }, `${describe(s.schedule)} (${s.timezone})${s.nextRunAt ? ` · ${t("ui.schedNext", { time: fmtDateTime(s.nextRunAt) })}` : ""}`),
        h("div", { class: "muted small" }, s.goal.length > 140 ? `${s.goal.slice(0, 139)}…` : s.goal),
        h("div", { class: "muted small" }, ...last),
        s.pausedReason === "too_many_failures" ? h("div", { class: "error small" }, t("ui.schedPausedFailures")) : null,
        details,
      ),
      h("button", { type: "button", class: "link", onclick: () => act(async () => { await api(`/schedules/${s.id}/run`, { method: "POST" }); formOk.textContent = t("ui.schedStarted"); }) }, t("ui.schedRunNow")),
      h("button", { type: "button", class: "link", onclick: () => act(() => api(`/schedules/${s.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !s.enabled }) })) }, s.enabled ? t("ui.schedPause") : t("ui.schedResume")),
      h("button", { type: "button", class: "link danger-link", onclick: () => confirm(t("ui.schedDeleteConfirm", { name: s.name })) && act(() => api(`/schedules/${s.id}`, { method: "DELETE" })) }, t("ui.schedDelete")),
    );
  };

  const load = async () => {
    try {
      const { schedules } = await api("/schedules");
      if (mine !== navToken) return;
      listBox.replaceChildren(schedules.length ? h("ul", { class: "files" }, schedules.map(row)) : h("p", { class: "empty" }, t("ui.noSchedules")));
    } catch (err) {
      if (err.status === 401) return;
      listBox.replaceChildren(h("p", { class: "error" }, t("ui.connectionProblem")));
    }
  };
  load();
}

async function viewSecrets() {
  const mine = ++navToken;
  const listBox = h("div");
  const formError = h("p", { class: "error", role: "alert" });
  const formOk = h("p", { class: "small", role: "status" });
  const name = h("input", { type: "text", id: "sname", maxlength: "64", autocomplete: "off", required: true });
  const site = h("input", { type: "url", id: "ssite", maxlength: "300", autocomplete: "off", placeholder: "https://", required: true });
  const value = h("input", { type: "password", id: "svalue", maxlength: "1024", autocomplete: "new-password", required: true });
  const save = h("button", { class: "primary", type: "submit" }, t("ui.saveSecret"));

  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: async (e) => {
        e.preventDefault();
        formError.textContent = "";
        formOk.textContent = "";
        save.disabled = true;
        try {
          await api("/secrets", { method: "POST", body: JSON.stringify({ name: name.value.trim(), origin: site.value.trim(), value: value.value }) });
          value.value = ""; // never keep it around in the page
          formOk.textContent = t("ui.secretSaved");
          await load();
        } catch (err) {
          formError.textContent = err.body?.issues ? err.body.issues.map((i) => i.message).join("; ") : err.message;
        } finally {
          save.disabled = false;
        }
      },
    },
    h("div", {}, h("label", { for: "sname" }, t("ui.secretName")), name, h("div", { class: "muted small" }, t("ui.secretNameHelp"))),
    h("div", {}, h("label", { for: "ssite" }, t("ui.secretSite")), site, h("div", { class: "muted small" }, t("ui.secretSiteHelp"))),
    h("div", {}, h("label", { for: "svalue" }, t("ui.secretValue")), value, h("div", { class: "muted small" }, t("ui.secretReplaceNote"))),
    formError,
    formOk,
    h("div", {}, save),
  );

  // Logins kept from a browser session you signed in to by hand (see "Keep this login" while in control).
  const loginsBox = h("div");
  const loadLogins = async () => {
    try {
      const { logins } = await api("/logins");
      if (mine !== navToken) return;
      clear(loginsBox);
      loginsBox.append(
        logins.length
          ? h(
              "ul",
              { class: "files" },
              logins.map((l) =>
                h(
                  "li",
                  {},
                  h("span", { class: "file-name" }, `${l.name} — ${l.origin}`),
                  h("span", { class: "muted small" }, [t("ui.loginSavedAt", { time: fmtDateTime(l.savedAt) }), l.lastUsedAt ? t("ui.loginLastUsed", { time: fmtDateTime(l.lastUsedAt) }) : t("ui.loginNeverUsed")].join(" · ")),
                  h(
                    "button",
                    {
                      class: "link danger-link",
                      type: "button",
                      onclick: async () => {
                        if (!confirm(t("ui.loginDeleteConfirm", { name: l.name }))) return;
                        try {
                          await api(`/logins/${encodeURIComponent(l.name)}`, { method: "DELETE" });
                        } catch (err) {
                          formError.textContent = err.message;
                        }
                        loadLogins();
                      },
                    },
                    t("ui.delete"),
                  ),
                ),
              ),
            )
          : h("p", { class: "empty" }, t("ui.noLogins")),
      );
    } catch (err) {
      if (err.status === 401) return;
      loginsBox.replaceChildren(h("p", { class: err.status === 503 ? "muted small" : "error" }, err.status === 503 ? t("ui.loginsDisabled") : t("ui.connectionProblem")));
    }
  };

  mount(
    shell(
      h("section", { class: "card stack" }, h("h2", {}, t("ui.secrets")), h("p", { class: "muted small" }, t("ui.secretsIntro")), form),
      h("section", { class: "card" }, listBox),
      h("section", { class: "card stack" }, h("h2", {}, t("ui.logins")), h("p", { class: "muted small" }, t("ui.loginsIntro")), loginsBox),
    ),
  );
  loadLogins();

  const load = async () => {
    try {
      const { secrets } = await api("/secrets");
      if (mine !== navToken) return;
      clear(listBox);
      listBox.append(
        secrets.length
          ? h(
              "ul",
              { class: "files" },
              secrets.map((s) =>
                h(
                  "li",
                  {},
                  h("span", { class: "file-name" }, `${s.name} — ${s.origin}`),
                  h("span", { class: "muted small" }, s.lastUsedAt ? t("ui.secretLastUsed", { time: fmtDateTime(s.lastUsedAt) }) : t("ui.secretNeverUsed")),
                  h(
                    "button",
                    {
                      class: "link danger-link",
                      type: "button",
                      onclick: async () => {
                        if (!confirm(t("ui.deleteSecretConfirm", { name: s.name }))) return;
                        try {
                          await api(`/secrets/${encodeURIComponent(s.name)}`, { method: "DELETE" });
                        } catch (err) {
                          formError.textContent = err.message;
                        }
                        load();
                      },
                    },
                    t("ui.delete"),
                  ),
                ),
              ),
            )
          : h("p", { class: "empty" }, t("ui.noSecrets")),
      );
    } catch (err) {
      if (err.status === 401) return;
      if (err.status === 503) return void listBox.replaceChildren(h("p", { class: "error" }, t("ui.vaultDisabled")));
      listBox.replaceChildren(h("p", { class: "error" }, t("ui.connectionProblem")));
    }
  };
  load();
}

// ---- router ------------------------------------------------------------------------------

// A sign-in link from the menu bar app: #/login/<one-time code>[?to=/tasks/<id>]. The code is spent
// right away and removed from the address bar; the page then runs on a short-lived session token.
async function redeemLoginLink() {
  const m = /^#\/login\/([0-9a-f]{32})(?:\?to=\/tasks\/([0-9a-f-]{36}))?$/.exec(location.hash);
  if (!m) return false;
  history.replaceState(null, "", location.pathname);
  try {
    const res = await fetch("/auth/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: m[1] }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const session = await res.json();
    saveToken(session.token);
    owner = null;
    history.replaceState(null, "", `${location.pathname}${m[2] ? `#/tasks/${m[2]}` : "#/"}`);
  } catch {
    saveToken(null);
    owner = null;
  }
  return true;
}

async function route() {
  clearTimeout(pollTimer);
  navToken++;
  clearBlobs();
  if (await redeemLoginLink()) return route();
  if (!token) return renderLogin();
  if (!owner) {
    try {
      const me = await api("/me");
      owner = me.owner;
      role = me.role;
      byok = Boolean(me.byok);
    } catch (err) {
      return err.status === 401 ? renderLogin(t("ui.signInAgain")) : renderLogin(t("ui.serverUnreachable"));
    }
  }
  if (location.hash === "#/secrets") return viewSecrets();
  if (location.hash === "#/schedules") return viewSchedules();
  if (location.hash === "#/users") return role === "admin" ? viewUsers() : viewList();
  if (location.hash === "#/settings") return role !== "admin" && byok ? viewSettings() : viewList();
  const m = /^#\/tasks\/([0-9a-f-]{36})$/.exec(location.hash);
  if (m) return viewTask(m[1]);
  return viewList();
}

window.addEventListener("hashchange", route);
route();
