import { describe, expect, it } from "vitest";
import { MockBrowser } from "../testing/mock-browser.js";
import { DEFAULT_PERMISSIONS, taskDocument } from "../runtime/task-runner.js";
import { CreateTaskRequestSchema } from "../runtime/task-service.js";
import { renderContext } from "../model/context.js";
import { createBrowserTools } from "./browser-tools.js";

const page = {
  "http://s/": {
    content: '- textbox "Title" [ref=e1]\n- textbox "Start writing..." [ref=e2]\n- textbox "Password" [ref=e3]',
    elements: [
      { role: "textbox" as const, name: "Title", tag: "textarea" },
      { role: "textbox" as const, name: "Start writing...", tag: "div" },
      { role: "textbox" as const, name: "Password", tag: "input", inputType: "password" },
    ],
  },
};
const doc = { title: "오늘의 종목", markdown: "## IONQ\n\n본문 **굵게**\n\n- 하나" };
const ctx = { signal: new AbortController().signal };

const setup = (withDoc = true) => {
  const browser = new MockBrowser(page);
  const tools = createBrowserTools(browser, withDoc ? { document: doc } : {});
  return { browser, tool: tools.find((t) => t.name === "browser.paste_document") };
};

describe("browser.paste_document", () => {
  it("exists only when the task carries a document", () => {
    expect(setup(true).tool).toMatchObject({ risk: "low", permissions: ["browser.paste"] });
    expect(setup(false).tool).toBeUndefined();
    expect(DEFAULT_PERMISSIONS.has("browser.paste")).toBe(true);
  });

  it("takes a ref and a part, never text", () => {
    const schema = setup().tool!.inputSchema;
    expect(schema.safeParse({ ref: "e1", part: "title" }).success).toBe(true);
    expect(schema.safeParse({ ref: "e2", part: "body" }).success).toBe(true);
    expect(schema.safeParse({ ref: "e2", part: "footer" }).success).toBe(false);
    expect(schema.safeParse({ ref: "e2", part: "body", text: "anything" }).success).toBe(true); // extra keys are ignored, never used
  });

  it("fills the title and pastes the body as rich text from the attached document only", async () => {
    const { browser, tool } = setup();
    await browser.goto("http://s/");
    await tool!.handler({ ref: "e1", part: "title" }, ctx);
    const out = await tool!.handler({ ref: "e2", part: "body", text: "ignored" } as never, ctx);
    expect(browser.typed).toEqual([{ ref: "e1", text: "오늘의 종목" }]);
    expect(browser.pasted).toHaveLength(1);
    expect(browser.pasted[0]!.html).toBe("<h2>IONQ</h2><p>본문 <strong>굵게</strong></p><ul><li>하나</li></ul>");
    expect(browser.pasted[0]!.text).toContain("본문 굵게");
    expect(JSON.stringify(out)).not.toContain("본문"); // the result never echoes the document back to the model
  });

  it("treats a password field as consequential, like browser.type", async () => {
    const { browser, tool } = setup();
    await browser.goto("http://s/");
    const inspection = await tool!.inspect!({ ref: "e3", part: "body" });
    expect(tool!.classifyRisk!({ ref: "e3", part: "body" }, inspection)).toBe("consequential");
  });
});

describe("document on the task", () => {
  it("is accepted by the request schema with limits on size and unknown keys", () => {
    const base = { goal: "g" };
    expect(CreateTaskRequestSchema.safeParse({ ...base, document: doc }).success).toBe(true);
    expect(CreateTaskRequestSchema.safeParse({ ...base, document: { title: "", markdown: "x" } }).success).toBe(false);
    expect(CreateTaskRequestSchema.safeParse({ ...base, document: { ...doc, extra: 1 } }).success).toBe(false);
    expect(CreateTaskRequestSchema.safeParse({ ...base, document: { title: "t", markdown: "x".repeat(100_001) } }).success).toBe(false);
  });

  it("is read back only when well formed", () => {
    expect(taskDocument({ document: doc })).toEqual(doc);
    expect(taskDocument({ document: { title: 1 } })).toBeUndefined();
    expect(taskDocument({})).toBeUndefined();
  });

  it("tells the model the title and size but not the body", () => {
    const text = renderContext({ document: { title: doc.title, chars: doc.markdown.length } }).join("\n");
    expect(text).toContain("오늘의 종목");
    expect(text).toContain(`${doc.markdown.length} characters`);
    expect(text).not.toContain("굵게");
  });
});
