import { z } from "zod";
import { canPasteRich, type BrowserAdapter, type ElementInfo } from "../execution/browser-adapter.js";
import { markdownToHtml, markdownToText } from "./markdown-html.js";
import { defineTool, type AnyTool, type RiskLevel } from "./types.js";

// Name heuristics are one signal among several; unknown or ambiguous means consequential.
const CONSEQUENTIAL_NAME =
  /\b(buy|purchase|order|pay|checkout|delete|remove|send|submit|publish|post|confirm|subscribe|sign ?up|accept|agree|unsubscribe)\b/i;
const SENSITIVE_FIELD = /pass(word|code)|card|cvv|cvc|ssn|social security|one-time|otp|2fa/i;

const Url = z.url().refine((u) => /^https?:\/\//i.test(u), "only http(s) URLs are allowed");
export const Ref = z.string().regex(/^(f\d+)?e\d+$/, "ref must come from the latest snapshot, e.g. e12");

export const PageResult = z.object({ url: z.string(), ariaSnapshot: z.string() });
const MAX_SNAPSHOT_CHARS = 30_000;

const EMPTY_NODE = /^\s*- (?:paragraph|generic|group|cell|row|listitem) \[ref=[a-z0-9]+\]\s*$/;

/**
 * Makes a snapshot shorter without changing what it says: one space per nesting level instead of two (only
 * the relative depth matters), and a run of nodes with no name, text or children becomes one line. Refs of
 * everything that has a name, text or children are untouched, so every ref the model can use is still there.
 */
export function compactSnapshot(yaml: string): string {
  const out: string[] = [];
  let empty = 0;
  const flush = (indent: string) => {
    if (empty > 0) out.push(`${indent}- (${empty} empty ${empty === 1 ? "element" : "elements"})`);
    empty = 0;
  };
  let runIndent = "";
  for (const line of yaml.split("\n")) {
    const lead = line.length - line.trimStart().length;
    const indent = " ".repeat(Math.ceil(lead / 2));
    if (EMPTY_NODE.test(line)) {
      if (empty === 0) runIndent = indent;
      empty++;
      continue;
    }
    flush(runIndent);
    out.push(indent + line.trimStart());
  }
  flush(runIndent);
  return out.join("\n");
}

export async function pageAfter(browser: BrowserAdapter) {
  const s = { ...(await browser.snapshot()) };
  s.ariaSnapshot = compactSnapshot(s.ariaSnapshot);
  const ariaSnapshot = s.ariaSnapshot.length > MAX_SNAPSHOT_CHARS ? `${s.ariaSnapshot.slice(0, MAX_SNAPSHOT_CHARS)}\n…[snapshot truncated]` : s.ariaSnapshot;
  return { url: s.url, ariaSnapshot };
}

function asInfo(inspection: Record<string, unknown> | undefined): ElementInfo | undefined {
  if (!inspection || inspection.inspectionFailed) return undefined;
  return inspection as unknown as ElementInfo;
}

const MAX_FIND_MATCHES = 30;

/** The lines of a snapshot that contain `query` (any case), each with its `/url` line when it has one. Refs stay valid: they come from this very snapshot. */
export function matchingLines(ariaSnapshot: string, query: string): string {
  const q = query.toLowerCase();
  const lines = ariaSnapshot.split("\n");
  const out: string[] = [];
  let found = 0;
  for (let i = 0; i < lines.length && found < MAX_FIND_MATCHES; i++) {
    const line = lines[i]!;
    if (!/\[ref=/.test(line) || !line.toLowerCase().includes(q)) continue;
    found++;
    out.push(line);
    if (/^\s*- \/url:/.test(lines[i + 1] ?? "")) out.push(lines[i + 1]!);
  }
  const header = `# ${found} match${found === 1 ? "" : "es"} for the search text (only the matching lines are shown)`;
  return [header, ...out].join("\n");
}

export function classifyClick(inspection: Record<string, unknown> | undefined): RiskLevel {
  const el = asInfo(inspection);
  if (!el) return "consequential";
  if (CONSEQUENTIAL_NAME.test(el.name)) return "consequential";
  // Anything that can submit a form: a bare <button> in a form defaults to type=submit. The exception is
  // a plain lookup (GET, same site, no password or file field), which is a navigation like following a link.
  if (el.insideForm && (el.tag === "button" || el.tag === "input") && (el.inputType === "submit" || el.inputType === "image")) {
    return el.formSameOriginGet === true ? "low" : "consequential";
  }
  if (el.download) return "consequential";
  return "low";
}

export function classifyType(inspection: Record<string, unknown> | undefined): RiskLevel {
  const el = asInfo(inspection);
  if (!el) return "consequential";
  if (el.inputType === "password" || SENSITIVE_FIELD.test(el.name)) return "consequential";
  return "low";
}

/** A finished document the owner attached to the task. Trusted text: it never passes through the model. */
export interface TaskDocument {
  title: string;
  markdown: string;
}

export function createBrowserTools(browser: BrowserAdapter, opts: { document?: TaskDocument } = {}): AnyTool[] {
  const doc = opts.document;
  const paste: AnyTool[] =
    doc && canPasteRich(browser)
      ? [
          defineTool({
            name: "browser.paste_document",
            description:
              "Put the finished document the owner attached to this task into the editor field with the given ref from the latest snapshot: part \"title\" fills a title field, part \"body\" pastes the whole body as rich text (headings, lists, bold and links are converted by the page's editor). The text is inserted exactly as written; you cannot read or change it, so never type it yourself. It replaces what the field held. Returns only the page address, not the page: take a snapshot to see the result.",
            inputSchema: z.object({ ref: Ref, part: z.enum(["title", "body"]) }),
            outputSchema: PageResult,
            handler: async ({ ref, part }) => {
              if (part === "title") await browser.type(ref, doc.title);
              else await browser.pasteRich(ref, markdownToHtml(doc.markdown), markdownToText(doc.markdown));
              return { url: browser.currentUrl(), ariaSnapshot: `(the document ${part} was inserted; take a snapshot to see the page)` };
            },
            inspect: async ({ ref }) => ({ ...(await browser.inspect(ref)) }),
            classifyRisk: (_i, inspection) => classifyType(inspection),
            permissions: ["browser.paste"],
            risk: "low",
            timeoutMs: 45_000,
            retry: { maxAttempts: 1, backoffMs: 0 },
          }),
        ]
      : [];
  return [
    ...paste,
    defineTool({
      name: "browser.goto",
      description:
        "Navigate the browser to an http(s) URL and return the new page as an accessibility snapshot. Element refs in the snapshot are valid only until the next snapshot or navigation.",
      inputSchema: z.object({ url: Url }),
      outputSchema: PageResult,
      handler: async ({ url }) => {
        await browser.goto(url);
        return pageAfter(browser);
      },
      permissions: ["browser.navigate"],
      risk: "low",
      timeoutMs: 45_000,
      retry: { maxAttempts: 2, backoffMs: 500 },
      verification: "Page URL reflects the requested navigation.",
    }),
    defineTool({
      name: "browser.click",
      description:
        "Click the element with the given ref from the latest snapshot and return the resulting page. Use only refs from the most recent snapshot. Clicking submit buttons, purchase, send, delete, or similar controls requires human approval.",
      inputSchema: z.object({ ref: Ref }),
      outputSchema: PageResult,
      handler: async ({ ref }) => {
        await browser.click(ref);
        return pageAfter(browser);
      },
      inspect: async ({ ref }) => ({ ...(await browser.inspect(ref)) }),
      classifyRisk: (_i, inspection) => classifyClick(inspection),
      permissions: ["browser.click"],
      risk: "low",
      timeoutMs: 30_000,
      // A click can have effects; never retry it automatically.
      retry: { maxAttempts: 1, backoffMs: 0 },
    }),
    defineTool({
      name: "browser.type",
      description:
        "Type text into the input with the given ref from the latest snapshot and return the resulting page. Never type passwords, card numbers, or other credentials; those fields require human approval.",
      inputSchema: z.object({ ref: Ref, text: z.string().max(2000) }),
      outputSchema: PageResult,
      handler: async ({ ref, text }) => {
        await browser.type(ref, text);
        return pageAfter(browser);
      },
      inspect: async ({ ref }) => ({ ...(await browser.inspect(ref)) }),
      classifyRisk: (_i, inspection) => classifyType(inspection),
      permissions: ["browser.type"],
      risk: "low",
      timeoutMs: 30_000,
      retry: { maxAttempts: 1, backoffMs: 0 },
    }),
    defineTool({
      name: "browser.scroll",
      description:
        "Scroll the page down or up by about one screen and return the page. Use it when content loads as the page is scrolled (feeds, long lists); the snapshot of a normal page already includes parts that are off screen.",
      inputSchema: z.object({ direction: z.enum(["down", "up"]) }),
      outputSchema: PageResult.extend({ moved: z.boolean() }),
      handler: async ({ direction }) => {
        const { moved } = await browser.scroll(direction);
        // `moved` first: a long page is clipped from the end when stored, and the model must still see it.
        return { moved, ...(await pageAfter(browser)) };
      },
      permissions: ["browser.scroll"],
      risk: "low",
      timeoutMs: 15_000,
      retry: { maxAttempts: 2, backoffMs: 200 },
    }),
    defineTool({
      name: "browser.select",
      description:
        "Choose an option, by its visible label, in the dropdown (select) with the given ref from the latest snapshot and return the resulting page. This only sets the field; submitting a form is a separate click and follows the click rules.",
      inputSchema: z.object({ ref: Ref, option: z.string().min(1).max(200) }),
      outputSchema: PageResult,
      handler: async ({ ref, option }) => {
        await browser.select(ref, option);
        return pageAfter(browser);
      },
      inspect: async ({ ref }) => ({ ...(await browser.inspect(ref)) }),
      classifyRisk: (_i, inspection) => classifyType(inspection),
      permissions: ["browser.select"],
      risk: "low",
      timeoutMs: 30_000,
      // Choosing an option can have effects (an onchange handler); never retry it automatically.
      retry: { maxAttempts: 1, backoffMs: 0 },
    }),
    defineTool({
      name: "browser.find",
      description:
        "Look for text on the current page, including parts the page snapshot cut off, and return only the matching lines with fresh element refs. Use it on a long page to reach an item you know by name or number, then click the ref from the result.",
      inputSchema: z.object({ query: z.string().min(1).max(100) }),
      outputSchema: PageResult,
      handler: async ({ query }) => {
        const s = await browser.snapshot();
        return { url: s.url, ariaSnapshot: matchingLines(s.ariaSnapshot, query) };
      },
      permissions: ["browser.read"],
      risk: "low",
      timeoutMs: 15_000,
      retry: { maxAttempts: 2, backoffMs: 200 },
    }),
    defineTool({
      name: "browser.snapshot",
      description: "Read the current page as an accessibility snapshot with fresh element refs.",
      inputSchema: z.object({}),
      outputSchema: PageResult,
      handler: async () => pageAfter(browser),
      permissions: ["browser.read"],
      risk: "low",
      timeoutMs: 15_000,
      retry: { maxAttempts: 2, backoffMs: 200 },
    }),
  ];
}
