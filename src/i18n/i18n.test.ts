import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildTimeline } from "../api/timeline.js";
import { TASK_STATES } from "../domain/task-state.js";
import { renderApproval, renderCompleted, renderFailed } from "../notifications/render.js";
import type { TaskEvent } from "../persistence/task-store.js";
import { catalogs, createTranslator, interpolate, reasonText, roleLabel, uiMessages, type MessageKey } from "./messages.js";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
const appJs = readFileSync(path.join(WEB, "app.js"), "utf8");
const keys = Object.keys(catalogs.en) as MessageKey[];
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
const hasHangul = (s: string) => /[가-힣]/.test(s);

describe("message catalogs", () => {
  it("Korean has exactly the English keys, and the same placeholders in each", () => {
    expect(Object.keys(catalogs.ko).sort()).toEqual([...keys].sort());
    for (const k of keys) expect(placeholders(catalogs.ko[k]), k).toEqual(placeholders(catalogs.en[k]));
  });

  it("every Korean message is actually translated", () => {
    const allowedAsIs = new Set<MessageKey>(["ui.brand", "call.target"]); // brand name; pure placeholders
    for (const k of keys) if (!allowedAsIs.has(k)) expect(hasHangul(catalogs.ko[k]), `${k}: ${catalogs.ko[k]}`).toBe(true);
  });

  it("leaves unknown placeholders visible instead of printing 'undefined'", () => {
    expect(interpolate("a {x} b {y}", { x: 1 })).toBe("a 1 b {y}");
    expect(createTranslator("ko")("call.open", { url: "https://a.example" })).toBe("https://a.example 열기");
  });

  it("explains known failure reasons in Korean and still shows unknown ones", () => {
    const t = createTranslator("ko");
    expect(reasonText(t, "limit_exceeded")).toContain("한도");
    expect(reasonText(t, "brand_new_reason")).toContain("brand_new_reason");
    expect(roleLabel(t, "button")).toBe("버튼");
    expect(roleLabel(t, "treeitem")).toBe("treeitem");
  });
});

describe("dashboard text", () => {
  it("only uses keys that exist, including every task status and action kind", () => {
    const used = new Set([...appJs.matchAll(/\bt\(\s*"([^"]+)"/g)].map((m) => m[1]!));
    for (const k of used) expect(k in catalogs.en, `app.js uses unknown key ${k}`).toBe(true);
    for (const s of TASK_STATES) expect(`ui.status.${s}` in catalogs.en, s).toBe(true);
    for (const kind of ["send_message", "publish", "delete_or_modify_data", "purchase", "change_permissions"]) expect(`kind.${kind}` in catalogs.en, kind).toBe(true);
  });

  it("has no hard-coded user-facing English left in the script", () => {
    const code = appJs
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n")
      // the table that maps English labels stored in history to catalog keys is data, not UI text
      .replace(/const STORED_LABELS = \{[\s\S]*?\n\};/, "");
    const sentences = [...code.matchAll(/"([A-Z][a-z]+(?: [A-Za-z’']+)+[^"]*)"/g)].map((m) => m[1]);
    expect(sentences).toEqual([]);
  });

  it("sends the dashboard its own text and the vocabulary it displays, not server-only messages", () => {
    const ui = uiMessages("ko");
    expect(ui["ui.signIn"]).toBe("로그인");
    expect(ui["kind.purchase"]).toBe("구매");
    expect(ui["timeline.submitted"]).toBeUndefined();
    expect(ui["email.goal"]).toBeUndefined();
  });
});

let seq = 0;
const ev = (type: string, payload: Record<string, unknown> = {}): TaskEvent => ({ id: String(++seq), taskId: "t", seq, type, payload, createdAt: new Date(1_700_000_000_000 + seq * 1000) });

describe("server-written text in Korean", () => {
  const t = createTranslator("ko");

  it("tells the story of a task in Korean with no unfilled placeholders", () => {
    seq = 0;
    const events = [
      ev("task.created"),
      ev("plan.created", { steps: ["페이지 열기"], criteria: [{ kind: "text_present", value: "완료" }, { kind: "url_contains", value: "/done" }] }),
      ev("tool.started", { callId: "c1", tool: "browser.click", input: { ref: "e1" }, target: { role: "button", name: "다음" } }),
      ev("tool.completed", { callId: "c1", tool: "browser.click", input: { ref: "e1" }, outcome: { status: "ok", output: { url: "https://a.example/" } } }),
      ev("approval.requested", { approvalId: "ap", tool: "browser.click", input: { ref: "e2" }, context: { page: { url: "https://a.example/" }, target: { role: "button", name: "구독" } } }),
      ev("approval.decided", { decision: "approved", tool: "browser.click", input: { ref: "e2" }, target: { role: "button", name: "구독" } }),
      ev("model.finished", { summary: "끝났습니다" }),
      ev("verification.completed", { attempt: 1, verdict: "failed", results: [{ passed: false, detail: "x" }], evidence: { url: "https://a.example/" } }),
      ev("recovery.started", { attempt: 1, failedCriteria: ["x"] }),
      ev("task.state_changed", { to: "failed", reason: "verification_failed", outcome: "partial", failedCriteria: ["x"] }),
    ];
    const tl = buildTimeline(events, undefined, t);
    const text = tl.items.flatMap((i) => [i.title, ...i.lines]).join("\n");
    expect(tl.items.find((i) => i.title.includes("버튼 “다음” 클릭"))).toBeTruthy();
    expect(text).toContain("승인 필요: 버튼 “구독” 클릭");
    expect(text).toContain("작업을 승인했습니다");
    expect(text).toContain("완료 조건: 페이지에 “완료” 표시");
    expect(text).not.toMatch(/\{\w+\}/);
    expect(tl.outcome).toMatchObject({ tone: "warn", headline: "미완료 — 일부만 달성" });
    expect(tl.outcome!.detail).toContain("완료 조건");
  });

  it("writes the emails in Korean without losing safety wording or details", () => {
    const task = { id: "t1", goal: "구독하기" };
    const done = renderCompleted(task, "https://corbits.example/", t);
    expect(done.subject).toBe("[Corbits] 작업 완료 (검증됨): 구독하기");
    expect(done.text).toContain("자세히 보기: https://corbits.example/tasks/t1");

    const partial = renderFailed(task, { reason: "verification_failed", outcome: "partial", failedCriteria: ["x"] }, undefined, t);
    expect(partial.subject).toContain("작업 미완료");
    expect(partial.text).toContain("성공으로 보지 않습니다");
    expect(partial.text).toContain("충족하지 못한 조건:");

    const approval = renderApproval(
      task,
      { id: "ap1", tool: "browser.click", input: { ref: "e7" }, consequentialKind: "send_message", context: { page: { url: "https://a.example/" }, target: { role: "button", name: "구독", formAction: "https://a.example/s" } } },
      undefined,
      t,
    );
    expect(approval.subject).toBe("[Corbits] 승인 필요: 버튼 “구독”");
    expect(approval.text).toContain("아직 아무것도 실행되지 않았으며");
    expect(approval.text).toContain("제출 대상: https://a.example/s");
    expect(approval.text).toContain("종류: 메시지 전송");
    expect(approval.text).toContain("승인 ID: ap1");
    for (const r of [done, partial, approval]) expect(r.text).not.toMatch(/\{\w+\}/);
  });
});
