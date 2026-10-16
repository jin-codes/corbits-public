import { describe, expect, it } from "vitest";
import { MockBrowser } from "../testing/mock-browser.js";
import { DEFAULT_PERMISSIONS } from "../runtime/task-runner.js";
import { createBrowserTools, matchingLines } from "./browser-tools.js";

const setup = () => {
  const browser = new MockBrowser({ "http://s/": { content: '- combobox "Plan" [ref=e1]', elements: [{ role: "textbox", name: "Plan", tag: "select" }] } });
  const tools = createBrowserTools(browser);
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  return { browser, tool };
};

describe("browser.scroll", () => {
  it("is registered, low risk, and allowed by default", () => {
    const { tool } = setup();
    expect(tool("browser.scroll")).toMatchObject({ risk: "low", permissions: ["browser.scroll"] });
    expect(DEFAULT_PERMISSIONS.has("browser.scroll")).toBe(true);
  });

  it("accepts only down or up", () => {
    const { tool } = setup();
    expect(tool("browser.scroll").inputSchema.safeParse({ direction: "down" }).success).toBe(true);
    expect(tool("browser.scroll").inputSchema.safeParse({ direction: "up" }).success).toBe(true);
    expect(tool("browser.scroll").inputSchema.safeParse({ direction: "sideways" }).success).toBe(false);
    expect(tool("browser.scroll").inputSchema.safeParse({}).success).toBe(false);
  });

  it("scrolls the browser and returns the page", async () => {
    const { browser, tool } = setup();
    await browser.goto("http://s/");
    const out = (await tool("browser.scroll").handler({ direction: "down" }, { signal: new AbortController().signal })) as { url: string; moved: boolean };
    expect(browser.scrolls).toEqual(["down"]);
    expect(out).toMatchObject({ url: "http://s/", moved: true });
    browser.canScroll = false;
    expect(await tool("browser.scroll").handler({ direction: "down" }, { signal: new AbortController().signal })).toMatchObject({ moved: false });
  });
});

describe("browser.select", () => {
  it("is registered, low risk, and allowed by default", () => {
    const { tool } = setup();
    expect(tool("browser.select")).toMatchObject({ risk: "low", permissions: ["browser.select"] });
    expect(DEFAULT_PERMISSIONS.has("browser.select")).toBe(true);
  });

  it("validates its input before anything runs", () => {
    const { tool } = setup();
    const schema = tool("browser.select").inputSchema;
    expect(schema.safeParse({ ref: "e1", option: "Team" }).success).toBe(true);
    expect(schema.safeParse({ ref: "f2e7", option: "Team" }).success).toBe(true);
    expect(schema.safeParse({ ref: "javascript:1", option: "Team" }).success).toBe(false);
    expect(schema.safeParse({ ref: "e1", option: "" }).success).toBe(false);
    expect(schema.safeParse({ ref: "e1", option: "x".repeat(201) }).success).toBe(false);
  });

  it("chooses the option, and is never retried automatically", async () => {
    const { browser, tool } = setup();
    await browser.goto("http://s/");
    await tool("browser.select").handler({ ref: "e1", option: "Team" }, { signal: new AbortController().signal });
    expect(browser.selected).toEqual([{ ref: "e1", option: "Team" }]);
    expect(tool("browser.select").retry.maxAttempts).toBe(1);
  });

  it("rejects an unknown ref instead of acting", async () => {
    const { browser, tool } = setup();
    await browser.goto("http://s/");
    await expect(tool("browser.select").handler({ ref: "e9", option: "Team" }, { signal: new AbortController().signal })).rejects.toThrow(/Unknown ref/);
    expect(browser.selected).toEqual([]);
  });
});

describe("browser.find", () => {
  const yaml = ['- link "Catalog item 236" [ref=e5]:', "  - /url: /catalog/236", '- link "Catalog item 237" [ref=e6]:', "  - /url: /catalog/237", '- heading "Catalog" [ref=e7]'].join("\n");

  it("returns only the matching lines, with their address lines, and says how many", () => {
    const out = matchingLines(yaml, "ITEM 237");
    expect(out).toContain('link "Catalog item 237" [ref=e6]');
    expect(out).toContain("/url: /catalog/237");
    expect(out).not.toContain("236");
    expect(out.split("\n")[0]).toContain("1 match");
    expect(matchingLines(yaml, "nothing like this")).toContain("0 matches");
  });

  it("is read-only and low risk, validates its query, and searches the page it is on", async () => {
    const browser = new MockBrowser({ "http://s/": { content: yaml, elements: [] } });
    const find = createBrowserTools(browser).find((t) => t.name === "browser.find")!;
    expect(find).toMatchObject({ risk: "low", permissions: ["browser.read"] });
    expect(find.inputSchema.safeParse({ query: "" }).success).toBe(false);
    expect(find.inputSchema.safeParse({ query: "x".repeat(101) }).success).toBe(false);
    await browser.goto("http://s/");
    const out = (await find.handler({ query: "237" }, { signal: new AbortController().signal })) as { ariaSnapshot: string };
    expect(out.ariaSnapshot).toContain("Catalog item 237");
  });
});
