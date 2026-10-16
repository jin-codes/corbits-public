import nodemailer from "nodemailer";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApprovalStore } from "../persistence/approval-store.js";
import { TaskStore } from "../persistence/task-store.js";
import { Redactor } from "../security/redact.js";
import { createTestDb } from "../testing/test-db.js";
import { NotificationDispatcher } from "./dispatcher.js";
import { SmtpSender, type EmailMessage, type EmailSender } from "./email.js";
import { NOTICES_PER_DAY, enqueueNotice, notificationOutbox } from "./outbox.js";
import { renderApproval, renderCompleted, renderFailed } from "./render.js";

let db: Awaited<ReturnType<typeof createTestDb>>;
let pool: Pool;
let store: TaskStore;
let approvals: ApprovalStore;

beforeAll(async () => {
  db = await createTestDb();
  pool = db.connect();
  store = new TaskStore(pool, undefined, notificationOutbox);
  approvals = new ApprovalStore(pool);
});
afterAll(async () => db.cleanup());

class FakeSender implements EmailSender {
  sent: EmailMessage[] = [];
  failTimes = 0;
  calls = 0;
  async send(m: EmailMessage) {
    this.calls++;
    if (this.failTimes > 0) {
      this.failTimes--;
      throw new Error("SMTP 421 try later");
    }
    this.sent.push(m);
  }
}

const EMAILS = new Map([["alice", "alice@example.com"]]);
const mkDispatcher = (sender: EmailSender, over: Partial<ConstructorParameters<typeof NotificationDispatcher>[0]> = {}) =>
  new NotificationDispatcher({ pool, store, approvals, sender, ownerEmails: EMAILS, backoffBaseMs: 1, ...over });

const newTask = (owner = "alice", goal = "open example.com") => store.createTask({ owner, goal });
const finish = async (id: string, to: "completed" | "failed", payload: Record<string, unknown> = {}) => {
  await store.transition(id, "planning");
  await store.transition(id, "running");
  if (to === "completed") {
    await store.transition(id, "verifying");
    await store.transition(id, "completed", { payload: { outcome: "verified", ...payload } });
  } else {
    await store.transition(id, "failed", { payload });
  }
};
const rows = async (taskId: string) => (await pool.query("SELECT * FROM notifications WHERE task_id = $1 ORDER BY created_at", [taskId])).rows;
const drain = async (d: NotificationDispatcher) => {
  while ((await d.tick()) > 0) {
    /* keep going until nothing is due */
  }
};

describe("outbox", () => {
  it("creates exactly one notification for completion and for failure", async () => {
    const a = await newTask();
    await finish(a.id, "completed");
    const b = await newTask();
    await finish(b.id, "failed", { reason: "limit_exceeded" });
    expect((await rows(a.id)).map((r) => r.kind)).toEqual(["task_completed"]);
    expect((await rows(b.id)).map((r) => r.kind)).toEqual(["task_failed"]);
  });

  it("does not notify for cancellation or ordinary progress", async () => {
    const t = await newTask();
    await store.transition(t.id, "planning");
    await store.appendEvent(t.id, "tool.completed", { tool: "browser.goto" });
    await store.transition(t.id, "cancelled");
    expect(await rows(t.id)).toHaveLength(0);
  });

  it("creates one per approval request and collapses repeats of the same request", async () => {
    const t = await newTask();
    await store.transition(t.id, "planning");
    await store.transition(t.id, "running");
    await store.appendEvent(t.id, "approval.requested", { approvalId: "ap-1", tool: "browser.click" });
    await store.appendEvent(t.id, "approval.requested", { approvalId: "ap-1", tool: "browser.click" });
    await store.appendEvent(t.id, "approval.requested", { approvalId: "ap-2", tool: "browser.click" });
    expect((await rows(t.id)).map((r) => r.ref_id).sort()).toEqual(["ap-1", "ap-2"]);
  });

  it("is atomic with the event: a rolled-back transition leaves no notification", async () => {
    const t = await newTask();
    await expect(store.transition(t.id, "completed")).rejects.toThrow(); // illegal from queued
    expect(await rows(t.id)).toHaveLength(0);
  });
});

describe("dispatcher", () => {
  it("sends a completion email once, built from persisted state", async () => {
    const t = await newTask("alice", "Check the pricing page");
    await finish(t.id, "completed");
    const sender = new FakeSender();
    const d = mkDispatcher(sender);
    await drain(d);
    await drain(d);
    const mine = sender.sent.filter((m) => m.text.includes(t.id));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ to: "alice@example.com" });
    expect(mine[0]!.subject).toContain("completed (verified)");
    expect(mine[0]!.text).toContain("Check the pricing page");
    const [row] = await rows(t.id);
    expect(row).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("says an unverified end is not a success, in its own notification kind", async () => {
    const t = await newTask("alice", "Look at the docs");
    await store.transition(t.id, "planning");
    await store.transition(t.id, "running");
    await store.transition(t.id, "verifying");
    await store.transition(t.id, "unverified", { payload: { reason: "no_completion_criteria" } });
    expect((await rows(t.id)).map((r) => r.kind)).toEqual(["task_unverified"]);
    const sender = new FakeSender();
    await drain(mkDispatcher(sender));
    const m = sender.sent.find((x) => x.text.includes("Look at the docs"))!;
    expect(m.subject).toContain("NOT verified");
    expect(m.text).toContain("NOT counted as a success");
    expect(`${m.subject} ${m.text}`).not.toContain("completed");
  });

  it("shows the agent's own account in the unverified email, labelled as unchecked and clipped", async () => {
    const t = await newTask("alice", "Read the changelog");
    await store.transition(t.id, "planning");
    await store.transition(t.id, "running");
    await store.appendEvent(t.id, "model.finished", { summary: "Found version 4.2. " + "x".repeat(2000) });
    await store.transition(t.id, "verifying");
    await store.transition(t.id, "unverified", { payload: { reason: "no_completion_criteria" } });
    const sender = new FakeSender();
    await drain(mkDispatcher(sender));
    const m = sender.sent.find((x) => x.text.includes("Read the changelog"))!;
    expect(m.text).toContain("not checked");
    expect(m.text).toContain("Found version 4.2.");
    expect(m.text.length).toBeLessThan(1600);
    expect(m.text).toContain("Looks right");
  });

  it("reports partial results and the reason honestly", async () => {
    const t = await newTask("alice", "Buy it");
    await finish(t.id, "failed", { reason: "verification_failed", outcome: "partial", failedCriteria: ['text_present "Order confirmed": not found'] });
    const sender = new FakeSender();
    await drain(mkDispatcher(sender));
    const m = sender.sent.find((x) => x.text.includes("Buy it"))!;
    expect(m.subject).toContain("incomplete");
    expect(m.text).toContain("NOT counted as a success");
    expect(m.text).toContain("did not meet the completion criteria");
    expect(m.text).toContain("Order confirmed");
  });

  it("retries failures with backoff and records every attempt, then succeeds", async () => {
    const t = await newTask();
    await finish(t.id, "completed");
    const sender = new FakeSender();
    sender.failTimes = 2;
    const d = mkDispatcher(sender);
    for (let i = 0; i < 6; i++) {
      await d.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(sender.sent).toHaveLength(1);
    const attempts = (await pool.query("SELECT ok FROM notification_attempts WHERE notification_id = (SELECT id FROM notifications WHERE task_id = $1) ORDER BY id", [t.id])).rows;
    expect(attempts.map((a) => a.ok)).toEqual([false, false, true]);
    expect((await rows(t.id))[0]).toMatchObject({ status: "sent", attempts: 3, last_error: null });
  });

  it("gives up after max attempts, and a delivery failure never touches the task", async () => {
    const t = await newTask();
    await finish(t.id, "completed");
    const before = (await store.listEvents(t.id)).length;
    const sender = new FakeSender();
    sender.failTimes = 99;
    const d = mkDispatcher(sender, { maxAttempts: 3 });
    for (let i = 0; i < 8; i++) {
      await d.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(sender.calls).toBe(3);
    const [row] = await rows(t.id);
    expect(row).toMatchObject({ status: "failed", attempts: 3 });
    expect(row.last_error).toContain("SMTP 421");
    expect((await store.getTask(t.id)).status).toBe("completed");
    expect(await store.listEvents(t.id)).toHaveLength(before);
  });

  it("two dispatchers racing never send the same notification twice", async () => {
    const tasks = await Promise.all(Array.from({ length: 6 }, () => newTask()));
    for (const t of tasks) await finish(t.id, "completed");
    const sender = new FakeSender();
    const a = mkDispatcher(sender, { batchSize: 3 });
    const b = mkDispatcher(sender, { batchSize: 3 });
    await Promise.all([drain(a), drain(b)]);
    const ours = sender.sent.filter((m) => tasks.some((t) => m.text.includes(t.id)));
    expect(ours).toHaveLength(6);
    expect(new Set(ours.map((m) => m.messageId)).size).toBe(6);
  });

  it("takes over a row whose dispatcher died mid-send, but not before the lock expires", async () => {
    const t = await newTask();
    await finish(t.id, "completed");
    await pool.query("UPDATE notifications SET status = 'sending', attempts = 1, locked_until = now() + interval '1 hour' WHERE task_id = $1", [t.id]);
    const sender = new FakeSender();
    await drain(mkDispatcher(sender));
    expect(sender.sent.filter((m) => m.text.includes(t.id))).toHaveLength(0);
    await pool.query("UPDATE notifications SET locked_until = now() - interval '1 second' WHERE task_id = $1", [t.id]);
    await drain(mkDispatcher(sender));
    expect(sender.sent.filter((m) => m.text.includes(t.id))).toHaveLength(1);
  });

  it("skips owners without an address and records why", async () => {
    const t = await newTask("nobody");
    await finish(t.id, "completed");
    const sender = new FakeSender();
    await drain(mkDispatcher(sender));
    expect(sender.sent.filter((m) => m.text.includes(t.id))).toHaveLength(0);
    expect((await rows(t.id))[0]).toMatchObject({ status: "skipped", skip_reason: "no_email_for_owner" });
  });

  it("sends an approval email with the real target, and skips it if already decided", async () => {
    const t = await newTask("alice", "Subscribe me");
    await store.transition(t.id, "planning");
    await store.transition(t.id, "running");
    const { approval } = await approvals.request(t.id, {
      tool: "browser.click",
      input: { ref: "e7" },
      context: { page: { url: "http://shop.example/pricing" }, target: { role: "button", name: "Subscribe to newsletter", formAction: "http://shop.example/s" } },
      actionFingerprint: `a-${t.id}`,
      effectFingerprint: `e-${t.id}`,
      consequentialKind: "send_message",
    });
    await store.appendEvent(t.id, "approval.requested", { approvalId: approval.id, tool: "browser.click" });
    await store.transition(t.id, "awaiting_approval");

    const sender = new FakeSender();
    await drain(mkDispatcher(sender));
    const m = sender.sent.find((x) => x.text.includes(approval.id))!;
    expect(m.subject).toContain('button “Subscribe to newsletter”');
    expect(m.text).toContain("Submits to: http://shop.example/s");
    expect(m.text).toContain("Nothing has been done yet");
    expect(m.text).not.toMatch(/https?:\/\/\S*approve/i); // never a one-click approval link

    // A second approval that is decided before the email goes out is skipped.
    const { approval: second } = await approvals.request(t.id, { tool: "browser.click", input: { ref: "e8" }, actionFingerprint: `b-${t.id}`, effectFingerprint: `f-${t.id}` });
    await store.appendEvent(t.id, "approval.requested", { approvalId: second.id, tool: "browser.click" });
    await approvals.decide(second.id, "approved", "alice");
    await drain(mkDispatcher(sender));
    const skipped = (await pool.query("SELECT status, skip_reason FROM notifications WHERE ref_id = $1", [second.id])).rows[0];
    expect(skipped).toMatchObject({ status: "skipped", skip_reason: "approval_already_decided" });
  });

  it("scrubs secrets from the outgoing message", async () => {
    const t = await newTask("alice", "Use key sk-ant-api03-abcdefghijklmnopqrstuv to log in");
    await finish(t.id, "completed");
    const sender = new FakeSender();
    await drain(mkDispatcher(sender, { redactor: new Redactor().addSecret("log in") }));
    const m = sender.sent.find((x) => x.text.includes("Task ID: " + t.id))!;
    expect(m.text).not.toContain("abcdefghijklmnop");
  });
});

describe("rendering", () => {
  it("keeps the subject on one line even if the goal has newlines (no header injection)", () => {
    const r = renderCompleted({ id: "t", goal: "line one\r\nBcc: attacker@example.com" });
    expect(r.subject).not.toMatch(/[\r\n]/);
  });
  it("does not invent success: unknown reasons are shown as-is", () => {
    const r = renderFailed({ id: "t", goal: "g" }, { reason: "something_new" });
    expect(r.text).toContain("NOT counted as a success");
    expect(r.text).toContain("something_new");
  });
  it("links to the dashboard only when a public URL is configured", () => {
    expect(renderCompleted({ id: "t1", goal: "g" }).text).not.toContain("Details:");
    expect(renderCompleted({ id: "t1", goal: "g" }, "https://corbits.example/").text).toContain("Details: https://corbits.example/tasks/t1");
  });
  it("clips very large action inputs", () => {
    const r = renderApproval({ id: "t", goal: "g" }, { id: "a", tool: "browser.type", input: { text: "x".repeat(5000) }, context: null, consequentialKind: null });
    expect(r.text.length).toBeLessThan(1500);
  });
});

describe("SmtpSender", () => {
  it("passes the stable Message-ID, recipient and plain-text body to the transport", async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    let captured = "";
    const spy = { sendMail: async (m: Parameters<typeof transport.sendMail>[0]) => {
      const info = (await transport.sendMail(m)) as { message: string };
      captured = info.message;
      return info;
    } };
    const sender = new SmtpSender(spy as never, "Corbits <bot@example.com>");
    await expect(sender.send({ to: "alice@example.com", subject: "s", text: "hello", messageId: "<x@corbits.local>" })).resolves.toBeUndefined();
    const sent = JSON.parse(captured);
    expect(sent).toMatchObject({ messageId: "<x@corbits.local>", subject: "s", text: "hello" });
    expect(JSON.stringify(sent.to)).toContain("alice@example.com");
    expect(JSON.stringify(sent.from)).toContain("bot@example.com");
  });
  it("treats rejected recipients as failures", async () => {
    const fake = { sendMail: async () => ({ accepted: [], rejected: ["alice@example.com"] }) } as never;
    await expect(new SmtpSender(fake, "bot@example.com").send({ to: "alice@example.com", subject: "s", text: "t", messageId: "<m@x>" })).rejects.toThrow(/rejected/);
  });
});

describe("help requests", () => {
  const ask = async (id: string, reason = "CAPTCHA on the login page") => {
    await store.appendEvent(id, "help.requested", { reason });
    await store.transition(id, "human_control", { payload: { reason: "agent_requested_help" } });
  };
  const toRunning = async (id: string) => {
    await store.transition(id, "planning");
    await store.transition(id, "running");
  };

  it("creates one notification per request, even if the same task asks twice", async () => {
    const t = await newTask();
    await toRunning(t.id);
    await ask(t.id);
    await store.appendEvent(t.id, "human.control_ended", {});
    await store.transition(t.id, "running");
    await ask(t.id, "a code is required");
    expect((await rows(t.id)).map((r) => r.kind)).toEqual(["help_requested", "help_requested"]);
  });

  it("emails what the agent needs, built from the stored request", async () => {
    const t = await newTask("alice", "log in to the shop");
    await toRunning(t.id);
    await ask(t.id, "CAPTCHA on the login page");
    const sender = new FakeSender();
    await drain(mkDispatcher(sender, { publicUrl: "https://corbits.example" }));
    // Other tests' notifications may still be due in the shared database: look only at this task's.
    const mine = sender.sent.filter((m) => m.text.includes(t.id));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toContain("Needs your help");
    expect(mine[0]!.text).toContain("CAPTCHA on the login page");
    expect(mine[0]!.text).toContain(`https://corbits.example/tasks/${t.id}`);
  });

  it("does not send once the browser was handed back or the task moved on", async () => {
    const t = await newTask();
    await toRunning(t.id);
    await ask(t.id);
    await store.appendEvent(t.id, "human.control_ended", {});
    await store.transition(t.id, "running");
    const sender = new FakeSender();
    await drain(mkDispatcher(sender));
    expect(sender.sent.filter((m) => m.text.includes(t.id))).toHaveLength(0);
    expect((await rows(t.id))[0]!.skip_reason).toMatch(/task_is_running|help_already_handled/);
  });

  it("keeps the subject on one line even if the model's reason has newlines", async () => {
    const t = await newTask();
    await toRunning(t.id);
    await ask(t.id, "line one\nBcc: attacker@example.com");
    const sender = new FakeSender();
    await drain(mkDispatcher(sender));
    const mine = sender.sent.filter((m) => m.text.includes(t.id));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).not.toMatch(/[\r\n]/);
    expect(mine[0]!.text.split("\n").some((l) => l.startsWith("Bcc:"))).toBe(false);
  });
});

describe("notices (not about a task)", () => {
  it("are mailed to the owner's own address with the caller's subject and body, once per key", async () => {
    expect(await enqueueNotice(pool, "alice", { subject: "[x] needs a look", body: "line one\nline two", dedupeKey: "n1" })).toBe("queued");
    expect(await enqueueNotice(pool, "alice", { subject: "[x] needs a look", body: "again", dedupeKey: "n1" })).toBe("duplicate");
    const sender = new FakeSender();
    await mkDispatcher(sender).tick();
    const mine = sender.sent.filter((m) => m.subject === "[x] needs a look");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ to: "alice@example.com", text: "line one\nline two" });
    await mkDispatcher(sender).tick();
    expect(sender.sent.filter((m) => m.subject === "[x] needs a look")).toHaveLength(1);
  });

  it("the same key from two owners is two notices, and an owner without an address is skipped", async () => {
    expect(await enqueueNotice(pool, "carol", { subject: "s", body: "b", dedupeKey: "same" })).toBe("queued");
    expect(await enqueueNotice(pool, "dave", { subject: "s", body: "b", dedupeKey: "same" })).toBe("queued");
    await mkDispatcher(new FakeSender()).tick();
    const { rows } = await pool.query("SELECT owner, status, skip_reason FROM notifications WHERE kind = 'notice' AND owner IN ('carol','dave') ORDER BY owner");
    expect(rows).toEqual([
      { owner: "carol", status: "skipped", skip_reason: "no_email_for_owner" },
      { owner: "dave", status: "skipped", skip_reason: "no_email_for_owner" },
    ]);
  });

  it("are capped per owner per day", async () => {
    for (let i = 0; i < NOTICES_PER_DAY; i++) expect(await enqueueNotice(pool, "erin", { subject: "s", body: "b", dedupeKey: `k${i}` })).toBe("queued");
    expect(await enqueueNotice(pool, "erin", { subject: "s", body: "b", dedupeKey: "over" })).toBe("limit");
  });

  it("redact secrets in the subject and body like any other email", async () => {
    await enqueueNotice(pool, "alice", { subject: "leak sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA", body: "key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA", dedupeKey: "leak" });
    const sender = new FakeSender();
    const d = mkDispatcher(sender, { redactor: new Redactor() });
    while ((await d.tick()) > 0); // earlier tests left rows in the queue; drain it
    const m = sender.sent.find((x) => x.subject.startsWith("leak"));
    expect(m).toBeDefined();
    expect(`${m!.subject}${m!.text}`).not.toContain("AAAAAAAAAAAAAAAA");
  });
});
