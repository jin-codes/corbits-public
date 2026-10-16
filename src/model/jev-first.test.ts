import { describe, expect, it } from "vitest";
import { JevClient } from "./jev-client.js";
import { JevFirstModel, circling, firstUrl, parseControls, pickByPrice, rankControls, seekQuery, templateSummary, type TextWriter } from "./jev-first.js";
import { pageOf } from "./jev-assisted.js";
import type { ModelAdapter, Observation, PlanResult, StepRequest, StepResult } from "./types.js";

const USAGE = { inputTokens: 10, outputTokens: 5, costUsd: 0.01 };
const signal = new AbortController().signal;

const PAGE = [
  '- navigation "Main":',
  '  - link "Docs" [ref=e1]:',
  "    - /url: /docs",
  '  - link "Pricing" [ref=e2]:',
  "    - /url: /pricing",
  '  - button "Delete everything" [ref=e3]',
  '  - textbox "Search" [ref=e4]: cats',
  '  - textbox "Password" [ref=e5]',
  '  - link "About" [ref=e6]:',
  "    - /url: /about",
].join("\n");

const page = (yaml = PAGE, tool = "browser.goto"): Observation => ({ kind: "tool_result", tool, input: {}, outcome: { status: "ok", output: { url: "http://s/", ariaSnapshot: yaml } } });
const req = (observations: Observation[], goal = "Find the pricing page"): StepRequest => ({ goal, plan: ["open pricing"], criteria: [], tools: [], observations });

class Inner implements ModelAdapter {
  steps = 0;
  async plan(): Promise<PlanResult> {
    return { steps: [], criteria: [], usage: USAGE };
  }
  async step(): Promise<StepResult> {
    this.steps++;
    return { type: "finish", summary: "main model decided", usage: USAGE };
  }
}

type Answer = { choice: string; confidence?: number };
/** A Jev stand-in: one request, several scripted answers. Records every request body. */
function fakeJev(answers: Record<string, Answer>, status = 200) {
  const calls: any[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    const out: Record<string, unknown> = {};
    for (const [name, q] of Object.entries<any>(body.questions)) {
      const a = answers[name];
      if (!a) continue;
      out[name] = { type: "choice", choice: a.choice, confidence: a.confidence ?? 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === a.choice ? 1 : 0])) };
    }
    return new Response(JSON.stringify({ model: "jev-test", answers: out, usage: { input_tokens: 400, output_tokens: 40 } }), { status });
  }) as unknown as typeof fetch;
  return { client: new JevClient({ apiKey: "k-test-0123456789", fetch: fetchFn }), calls };
}
const model = (jev: JevClient, extra: { textWriter?: TextWriter; checkpointEvery?: number; offerEscalate?: boolean; consensus?: boolean } = {}) => {
  const inner = new Inner();
  return { m: new JevFirstModel({ inner, jev, random: () => 0.5, ...extra }), inner };
};
const writer = (text: string | null): TextWriter & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return { calls, write: async (r) => (calls.push(r), { text, usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.001 } }) };
};

describe("parsing controls", () => {
  it("separates clickable links/buttons from fields, and keeps risky names and credential fields out", () => {
    const { clicks, fields } = parseControls(PAGE);
    expect(clicks.map((c) => c.ref)).toEqual(["e1", "e2", "e6"]); // not "Delete everything"
    expect(fields.map((f) => f.ref)).toEqual(["e4"]); // not the Password field
    expect(fields[0]).toMatchObject({ name: "Search", value: "cats" });
  });
});

describe("parsing controls: frame-prefixed refs", () => {
  it("reads refs such as f1e3 (the form Playwright uses in real snapshots)", () => {
    const yaml = ['- navigation "Main" [ref=f1e2]:', '  - link "Docs" [ref=f1e4] [cursor=pointer]:', "    - /url: /docs", '  - textbox "Search" [ref=f2e7]'].join("\n");
    const { clicks, fields } = parseControls(yaml);
    expect(clicks.map((c) => c.ref)).toEqual(["f1e4"]);
    expect(clicks[0]!.href).toBe("/docs");
    expect(fields.map((f) => f.ref)).toEqual(["f2e7"]);
  });
});

describe("offerEscalate: false", () => {
  it("leaves ESCALATE out of the operation question and still acts on a clear click", async () => {
    const { client, calls } = fakeJev({ operation: { choice: "CLICK" }, click_target: { choice: "e2" } });
    const { m, inner } = model(client, { offerEscalate: false });
    const r = await m.step(req([page()]), signal);
    expect(r).toMatchObject({ type: "tool_call", tool: "browser.click", input: { ref: "e2" }, via: "jev" });
    expect(inner.steps).toBe(0);
    expect(JSON.stringify(calls)).not.toContain("ESCALATE");
  });
});

describe("cheaper plan and summary", () => {
  const criteria = [{ kind: "text_present" as const, value: "Team: $99/month" }];
  const planReq = { goal: "Find the pricing page", constraints: {}, tools: [], givenCriteria: criteria };

  it("skips the planning call when the task carries criteria and skipPlan is on; otherwise plans normally", async () => {
    class Planner extends Inner {
      plans = 0;
      override async plan(): Promise<PlanResult> {
        this.plans++;
        return { steps: ["x"], criteria, usage: USAGE };
      }
    }
    const inner = new Planner();
    const { client } = fakeJev({});
    const skip = new JevFirstModel({ inner, jev: client, skipPlan: true });
    const r = await skip.plan(planReq, signal);
    expect(inner.plans).toBe(0);
    expect(r).toMatchObject({ steps: ["Find the pricing page"], criteria, usage: { costUsd: 0 } });
    await skip.plan({ ...planReq, givenCriteria: undefined }, signal);
    expect(inner.plans).toBe(1);
    await new JevFirstModel({ inner, jev: client }).plan(planReq, signal);
    expect(inner.plans).toBe(2);
  });

  describe("plan gate", () => {
    class Planner extends Inner {
      plans = 0;
      override async plan(): Promise<PlanResult> {
        this.plans++;
        return { steps: ["x"], criteria, usage: USAGE };
      }
    }
    const bare = { goal: "Open the docs", constraints: {}, tools: [] };
    const gated = (answer: Record<string, Answer>, extra: { planGate?: boolean } = {}) => {
      const inner = new Planner();
      const { client, calls } = fakeJev(answer);
      return { inner, calls, m: new JevFirstModel({ inner, jev: client, random: () => 0.5, minConfidence: 0.6, planGate: true, ...extra }) };
    };

    it("skips the plan call, with no criteria, when Jev says no plan at enough confidence", async () => {
      const { inner, m, calls } = gated({ pick: { choice: "no_plan", confidence: 0.9 } });
      const r = await m.plan(bare, signal);
      expect(inner.plans).toBe(0);
      expect(r).toMatchObject({ steps: ["Open the docs"], criteria: [], usage: { costUsd: 0 } });
      expect(m.stats.planSkipped).toBe(1);
      expect(Object.keys(calls[0].questions.pick.criteria).sort()).toEqual(["no_plan", "plan"]);
    });

    it("plans as usual when Jev is unsure, says plan, errs, or the gate is off", async () => {
      for (const answer of [{ pick: { choice: "no_plan", confidence: 0.3 } }, { pick: { choice: "plan", confidence: 1 } }, {}]) {
        const g = gated(answer);
        await g.m.plan(bare, signal);
        expect(g.inner.plans).toBe(1);
      }
      const off = gated({ pick: { choice: "no_plan", confidence: 1 } }, { planGate: false });
      await off.m.plan(bare, signal);
      expect(off.inner.plans).toBe(1);
      expect(off.calls).toHaveLength(0);
      const down = new JevFirstModel({ inner: new Planner(), jev: fakeJev({}, 500).client, planGate: true });
      await expect(down.plan(bare, signal)).resolves.toMatchObject({ steps: ["x"] });
    });

    it("never gates a task that has criteria, a note, a prior attempt or an attached document", async () => {
      for (const extra of [{ givenCriteria: criteria }, { userNote: "n" }, { priorAttempt: "p" }, { document: { title: "t", chars: 5 } }]) {
        const g = gated({ pick: { choice: "no_plan", confidence: 1 } });
        await g.m.plan({ ...bare, ...extra }, signal);
        expect(g.calls).toHaveLength(0);
      }
    });
  });

  const doneJev = () => fakeJev({ operation: { choice: "DONE" } });
  class Summarizer implements ModelAdapter {
    seenTools: unknown[] | undefined;
    constructor(private readonly result: () => Promise<StepResult>) {}
    async plan(): Promise<PlanResult> {
      throw new Error("never plans");
    }
    async step(r: StepRequest): Promise<StepResult> {
      this.seenTools = r.tools;
      return this.result();
    }
  }

  it("lets the summarizer write the finish when Jev says DONE, without calling the main model", async () => {
    const summarizer = new Summarizer(async () => ({ type: "finish", summary: "Found the Team plan: $99/month.", usage: USAGE }));
    const inner = new Inner();
    const m = new JevFirstModel({ inner, jev: doneJev().client, summarizer });
    const r = await m.step({ ...req([page()]), tools: [{ name: "browser.click" } as never] }, signal);
    expect(r).toMatchObject({ type: "finish", summary: "Found the Team plan: $99/month." });
    expect(inner.steps).toBe(0);
    expect(summarizer.seenTools).toEqual([]); // it is given no tools
    expect(m.stats.escalated).toEqual({ done: 1 });
  });

  it("uses a fixed sentence when the summarizer fails or tries to act", async () => {
    for (const result of [
      async (): Promise<StepResult> => ({ type: "tool_call", tool: "browser.click", input: { ref: "e1" }, usage: USAGE }),
      async (): Promise<StepResult> => {
        throw new Error("down");
      },
    ]) {
      const inner = new Inner();
      const m = new JevFirstModel({ inner, jev: doneJev().client, summarizer: new Summarizer(result) });
      const r = await m.step(req([page()]), signal);
      expect(r.type).toBe("finish");
      expect(inner.steps).toBe(0);
    }
  });

  it("without a summarizer, DONE ends with a finish built by code from the page, with no main-model call", async () => {
    const inner = new Inner();
    const r = await new JevFirstModel({ inner, jev: doneJev().client }).step(req([page()]), signal);
    expect(r.type).toBe("finish");
    expect(inner.steps).toBe(0);
  });

  it("goes back to the main model for the finish only when the code-built finish is turned off and nothing else can write it", async () => {
    const inner = new Inner();
    await new JevFirstModel({ inner, jev: doneJev().client, templateSummary: false }).step(req([page()]), signal);
    expect(inner.steps).toBe(1);
  });
});

describe("first step and template summary, without a model", () => {
  it("finds the first http(s) address in a goal and drops trailing punctuation", () => {
    expect(firstUrl("Go to http://127.0.0.1:8799/, then find the price.")).toBe("http://127.0.0.1:8799/");
    expect(firstUrl("Open (https://example.com/docs/api).")).toBe("https://example.com/docs/api");
    expect(firstUrl("no address here")).toBeUndefined();
    expect(firstUrl("file:///etc/passwd and javascript:alert(1)")).toBeUndefined();
  });

  it("opens the goal's address on the very first step with no model call, and not later", async () => {
    const { client, calls } = fakeJev({});
    const inner = new Inner();
    const m = new JevFirstModel({ inner, jev: client });
    const r = await m.step(req([], "On http://s/ find the pricing page"), signal);
    expect(r).toMatchObject({ type: "tool_call", tool: "browser.goto", input: { url: "http://s/" }, via: "code", usage: { costUsd: 0 } });
    expect(inner.steps).toBe(0);
    expect(calls).toHaveLength(0);
    // With history, the same goal goes through the normal path (here: nothing readable, so the main model)
    await m.step(req([{ kind: "tool_denied", tool: "browser.goto", input: {}, reason: "x" }], "On http://s/ find the pricing page"), signal);
    expect(inner.steps).toBe(1);
  });

  it("builds a summary from a real snapshot: URL plus visible text, bounded, no tags", () => {
    const yaml = [
      "- generic [active] [ref=f1e1]:",
      '  - navigation "Main" [ref=f1e2]:',
      '    - link "Home" [ref=f1e3] [cursor=pointer]:',
      "      - /url: /",
      "  - main [ref=f1e9]:",
      '    - heading "Pricing" [level=1] [ref=f1e10]',
      "    - list [ref=f1e11]:",
      '      - listitem [ref=f1e12]: "Free: $0/month"',
      '      - listitem [ref=f1e14]: "Team: $99/month"',
      "      - paragraph [ref=f1e15]: Billed yearly",
    ].join("\n");
    const s = templateSummary("http://127.0.0.1:8799/pricing", yaml);
    expect(s).toContain("Reached http://127.0.0.1:8799/pricing");
    expect(s).toContain("Pricing | Free: $0/month | Team: $99/month | Billed yearly");
    expect(s.length).toBeLessThanOrEqual(600);
  });

  it("finishes from the last page when templateSummary is on and Jev says DONE", async () => {
    const inner = new Inner();
    const m = new JevFirstModel({ inner, jev: fakeJev({ operation: { choice: "DONE" } }).client, templateSummary: true });
    const r = await m.step(req([page()]), signal);
    expect(r).toMatchObject({ type: "finish", usage: { costUsd: 0 } });
    expect(inner.steps).toBe(0);
  });
});

describe("jev-only: no main-model step at all", () => {
  const only = (answers: Parameters<typeof fakeJev>[0]) => {
    const inner = new Inner();
    return { inner, m: new JevFirstModel({ inner, jev: fakeJev(answers).client, only: true, random: () => 0.5 }) };
  };

  it("decides a clear click itself", async () => {
    const { m, inner } = only({ operation: { choice: "CLICK" }, click_target: { choice: "e2" } });
    expect(await m.step(req([page()]), signal)).toMatchObject({ type: "tool_call", tool: "browser.click", via: "jev" });
    expect(inner.steps).toBe(0);
  });

  it("finishes from the last page on DONE, and reads the page itself when none was returned", async () => {
    const done = only({ operation: { choice: "DONE" } });
    expect(await done.m.step(req([page()]), signal)).toMatchObject({ type: "finish" });
    const noPage = only({});
    const afterWrite: Observation = { kind: "tool_result", tool: "browser.type", input: {}, outcome: { status: "ok", output: { ok: true } } };
    expect(await noPage.m.step(req([page(), afterWrite]), signal)).toMatchObject({ type: "tool_call", tool: "browser.snapshot", via: "code" });
    expect(noPage.inner.steps).toBe(0);
  });

  it("stops instead of handing over when Jev is unsure, and after a denial", async () => {
    const unsure = only({ operation: { choice: "CLICK", confidence: 0.4 }, click_target: { choice: "e2" } });
    const r = await unsure.m.step(req([page()]), signal);
    expect(r).toMatchObject({ type: "finish" });
    expect((r as { summary: string }).summary).toContain("jev_unsure");
    const denied = only({});
    const d = await denied.m.step(req([page(), { kind: "tool_denied", tool: "browser.click", input: {}, reason: "risky" }]), signal);
    expect(d).toMatchObject({ type: "finish" });
    expect(unsure.inner.steps + denied.inner.steps).toBe(0);
    expect(unsure.m.stats.gaveUp).toBe(1);
  });
});

describe("clipped pages, row text and price goals", () => {
  const rows = [
    '- list [ref=e3]:',
    '  - listitem [ref=e4]:',
    '    - link "Keyboard Alpha" [ref=e5] [cursor=pointer]:',
    '      - /url: /a',
    '    - text: "- $59"',
    '  - listitem [ref=e6]:',
    '    - link "Keyboard Beta" [ref=e7] [cursor=pointer]:',
    '      - /url: /b',
    '    - text: "- $1,049.50"',
    '  - listitem [ref=e8]:',
    '    - link "Keyboard Gamma" [ref=e9] [cursor=pointer]:',
    '      - /url: /c',
    '    - text: "- $49"',
  ].join("\n");

  it("reads a page that was stored clipped as the start of its JSON text, and plain objects", () => {
    const yaml = '- link "Docs" [ref=f1e4]:\n  - /url: /docs\n';
    const clipped = `${JSON.stringify({ url: "http://s/x", ariaSnapshot: yaml })}`.slice(0, -2) + "…[clipped]";
    expect(pageOf(clipped)).toMatchObject({ url: "http://s/x" });
    expect(pageOf(clipped)!.yaml).toContain('link "Docs"');
    expect(pageOf({ url: "u", ariaSnapshot: "y" })).toEqual({ url: "u", yaml: "y" });
    expect(pageOf("not a page")).toBeUndefined();
    expect(pageOf(undefined)).toBeUndefined();
  });

  it("attaches the text next to a link (its price) to the link", () => {
    const { clicks } = parseControls(rows);
    expect(clicks.map((c) => [c.name, c.note])).toEqual([
      ["Keyboard Alpha", "- $59"],
      ["Keyboard Beta", "- $1,049.50"],
      ["Keyboard Gamma", "- $49"],
    ]);
  });

  it("picks the cheapest or priciest in code, and refuses ties, single prices and unclear goals", () => {
    const { clicks } = parseControls(rows);
    expect(pickByPrice("Open the page of the cheapest keyboard", clicks)?.name).toBe("Keyboard Gamma");
    expect(pickByPrice("open the most expensive keyboard", clicks)?.name).toBe("Keyboard Beta");
    expect(pickByPrice("Open a keyboard", clicks)).toBeUndefined();
    expect(pickByPrice("the cheapest and the most expensive", clicks)).toBeUndefined();
    expect(pickByPrice("cheapest", clicks.slice(0, 1))).toBeUndefined();
    expect(pickByPrice("cheapest", clicks.map((c) => ({ ...c, note: "- $10" })))).toBeUndefined(); // tie
    expect(pickByPrice("cheapest", clicks.map((c) => ({ ...c, note: "" })))).toBeUndefined();
  });

  it("clicks the code-picked link without asking Jev", async () => {
    const { client, calls } = fakeJev({});
    const inner = new Inner();
    const m = new JevFirstModel({ inner, jev: client, random: () => 0.5 });
    const r = await m.step(req([page(rows)], "Open the page of the cheapest keyboard"), signal);
    expect(r).toMatchObject({ type: "tool_call", tool: "browser.click", input: { ref: "e9" }, via: "code" });
    expect(calls).toHaveLength(0);
    expect(inner.steps).toBe(0);
  });
});

describe("fallback model", () => {
  it("takes the steps Jev hands over, instead of the main model", async () => {
    const inner = new Inner();
    const fallback = new Inner();
    const m = new JevFirstModel({ inner, jev: fakeJev({ operation: { choice: "CLICK", confidence: 0.3 }, click_target: { choice: "e2" } }).client, fallback });
    await m.step(req([page()]), signal); // unsure: handed over
    await m.step(req([]), signal); // no page: handed over
    expect(fallback.steps).toBe(2);
    expect(inner.steps).toBe(0);
  });

  it("only writes the finish (no tools) when Jev says DONE, and the main model takes over late in a task", async () => {
    const seen: unknown[][] = [];
    class Tools extends Inner {
      override async step(r?: StepRequest): Promise<StepResult> {
        seen.push(r?.tools ?? []);
        return super.step();
      }
    }
    const inner = new Inner();
    const fallback = new Tools();
    const done = new JevFirstModel({ inner, jev: fakeJev({ operation: { choice: "DONE" } }).client, fallback, templateSummary: false });
    await done.step({ ...req([page()]), tools: [{ name: "browser.click" } as never] }, signal);
    expect(seen).toEqual([[]]); // handed no tools: it can only finish
    expect(inner.steps).toBe(0);

    const late = new JevFirstModel({ inner, jev: fakeJev({ operation: { choice: "CLICK", confidence: 0.3 }, click_target: { choice: "e2" } }).client, fallback, fallbackUntilObservations: 3 });
    const obs = [page(), page(), page()];
    await late.step(req(obs), signal);
    expect(inner.steps).toBe(1); // 3 observations: the main model
    expect(fallback.steps).toBe(1); // only the earlier DONE finish
  });

  it("is not used when Jev decides, and the main model still plans", async () => {
    const inner = new Inner();
    const fallback = new Inner();
    let planned = 0;
    inner.plan = async () => (planned++, { steps: [], criteria: [], usage: USAGE });
    const m = new JevFirstModel({ inner, jev: fakeJev({ operation: { choice: "CLICK" }, click_target: { choice: "e2" } }).client, fallback });
    await m.plan({ goal: "g", constraints: {}, tools: [] }, signal);
    await m.step(req([page()]), signal);
    expect(planned).toBe(1);
    expect(fallback.steps).toBe(0);
  });
});

describe("dropdowns, scrolling and long lists", () => {
  const FORM = [
    '- combobox "Plan" [ref=e3]:',
    '  - option "Free"',
    '  - option "Pro" [selected]',
    '  - option "Team"',
    '- combobox "City" [ref=e4]',
    '- combobox "Delete account?" [ref=e5]:',
    '  - option "Yes"',
    '  - option "No"',
    '- link "Home" [ref=e6]:',
    "  - /url: /",
  ].join("\n");

  it("tells a native dropdown (has options) from an autocomplete field, and keeps risky ones out", () => {
    const { selects, fields, clicks } = parseControls(FORM);
    expect(selects.map((s) => [s.ref, s.options, s.selected])).toEqual([["e3", ["Free", "Pro", "Team"], "Pro"]]);
    expect(fields.map((f) => f.ref)).toEqual(["e4"]);
    expect(clicks.map((c) => c.ref)).toEqual(["e6"]);
  });

  it("keeps the controls that share words with the goal when a list is too long", () => {
    const links = Array.from({ length: 300 }, (_, i) => `- link "Catalog item ${i + 1}" [ref=e${i + 10}]:\n  - /url: /catalog/${i + 1}`).join("\n");
    const { clicks } = parseControls(links);
    expect(clicks).toHaveLength(300);
    const kept = rankControls(clicks, "Find item 237 in the catalog and open its page", 80);
    expect(kept).toHaveLength(80);
    expect(kept.map((c) => c.name)).toContain("Catalog item 237");
    expect(kept.map((c) => c.name).slice(0, 3)).toEqual(["Catalog item 1", "Catalog item 2", "Catalog item 3"]); // others keep their order
    expect(rankControls(clicks.slice(0, 5), "anything", 80)).toHaveLength(5);
  });

  it("weighs rare goal words and ignores the numbers in an address", () => {
    const links = Array.from({ length: 300 }, (_, i) => `- link "Catalog item ${i + 1}" [ref=e${i + 10}]:\n  - /url: /catalog/${i + 1}`).join("\n");
    const { clicks } = parseControls(links);
    const goal = "Find item 237 in the catalog at http://127.0.0.1:55407/catalog and open its page.";
    expect(rankControls(clicks, goal, 80).map((c) => c.name)).toContain("Catalog item 237");
    expect(rankControls(clicks, goal, 5, false)[0]!.name).toBe("Catalog item 237"); // by relevance, best first
  });

  it("tells the operation question what is on the page", async () => {
    const { client, calls } = fakeJev({ operation: { choice: "CLICK" }, click_target: { choice: "e2" } });
    await new JevFirstModel({ inner: new Inner(), jev: client, offerEscalate: false }).step(req([page()]), signal);
    expect(calls[0].state.visible_controls.length).toBeGreaterThan(0);
  });

  it("selects the option Jev picks, as one browser.select call", async () => {
    const { client, calls } = fakeJev({ operation: { choice: "SELECT" }, select_choice: { choice: "e3#2" } });
    const inner = new Inner();
    const r = await new JevFirstModel({ inner, jev: client, offerEscalate: false, random: () => 0.5 }).step(req([page(FORM)], "Pick the Team plan"), signal);
    expect(r).toMatchObject({ type: "tool_call", tool: "browser.select", input: { ref: "e3", option: "Team" }, via: "jev" });
    expect(Object.keys(calls[0].questions.select_choice.criteria)).toEqual(expect.arrayContaining(["e3#0", "e3#1", "e3#2", "none"]));
    expect(inner.steps).toBe(0);
  });

  it("scrolls down when Jev picks SCROLL_DOWN, and stops offering it after twelve scrolls in a row", async () => {
    const { client, calls } = fakeJev({ operation: { choice: "SCROLL_DOWN" } });
    const inner = new Inner();
    const m = new JevFirstModel({ inner, jev: client, offerEscalate: false, random: () => 0.5 });
    const r = await m.step(req([page()], "Find the last entry in the feed"), signal);
    expect(r).toMatchObject({ type: "tool_call", tool: "browser.scroll", input: { direction: "down" }, via: "jev" });
    expect(Object.keys(calls[0].questions.operation.criteria)).toContain("SCROLL_DOWN");

    const scroll = (n: number): Observation => ({ kind: "tool_result", tool: "browser.scroll", input: { direction: "down" }, outcome: { status: "ok", output: { url: "http://s/", ariaSnapshot: `- link "Entry ${n}" [ref=e${n}]` } } });
    const many = [page(), ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(scroll)];
    const { client: c2, calls: calls2 } = fakeJev({ operation: { choice: "CLICK" }, click_target: { choice: "e1" } });
    await new JevFirstModel({ inner, jev: c2, offerEscalate: false, random: () => 0.5 }).step(req(many), signal);
    expect(Object.keys(calls2[0].questions.operation.criteria)).not.toContain("SCROLL_DOWN");
  });

  it("keeps going after a scroll that moved but loaded nothing yet, and hands over when it could not move", async () => {
    const scrolled = (moved: boolean): Observation => ({ kind: "tool_result", tool: "browser.scroll", input: { direction: "down" }, outcome: { status: "ok", output: { url: "http://s/", ariaSnapshot: PAGE, moved } } });
    const asked = fakeJev({ operation: { choice: "SCROLL_DOWN" } });
    const inner = new Inner();
    const r = await new JevFirstModel({ inner, jev: asked.client, offerEscalate: false }).step(req([page(), scrolled(true)]), signal);
    expect(r).toMatchObject({ tool: "browser.scroll" }); // same page text, but the page moved: carry on
    expect(inner.steps).toBe(0);
    await new JevFirstModel({ inner, jev: fakeJev({}).client }).step(req([page(), scrolled(false)]), signal);
    expect(inner.steps).toBe(1); // at the end of the page: hand over
  });
});

describe("looking for text on a page that was cut off", () => {
  const clipped = (text: string): Observation => ({
    kind: "tool_result",
    tool: "browser.goto",
    input: { url: "http://s/catalog" },
    outcome: { status: "ok", output: `${JSON.stringify({ url: "http://s/catalog", ariaSnapshot: text })}`.slice(0, -2) + "…[clipped]" },
  });
  const yaml = '- link "Catalog item 1" [ref=e1]:\n  - /url: /catalog/1\n';

  it("picks a quoted phrase, else a number of three digits or more, and skips what is already there or already searched", () => {
    expect(seekQuery('Find "Annual report" at http://s:8080/feed', yaml, [])).toBe("Annual report");
    expect(seekQuery("Find item 237 in the catalog at http://127.0.0.1:55407/catalog", yaml, [])).toBe("237"); // not a number of the address
    expect(seekQuery("Find item 12 in the list", yaml, [])).toBeUndefined(); // two digits: too vague
    expect(seekQuery("Find item 1 here with 237", "x Catalog item 237 y", [])).toBeUndefined(); // already on the page
    const done: Observation = { kind: "tool_result", tool: "browser.find", input: { query: "237" }, outcome: { status: "ok", output: {} } };
    expect(seekQuery("Find item 237", yaml, [done])).toBeUndefined();
  });

  it("looks for it with browser.find (from code) when the page was cut off, and not when the page is complete", async () => {
    const goal = "Find item 237 in the catalog";
    const inner = new Inner();
    const m = new JevFirstModel({ inner, jev: fakeJev({}).client, offerEscalate: false });
    const r = await m.step(req([clipped(yaml)], goal), signal);
    expect(r).toMatchObject({ type: "tool_call", tool: "browser.find", input: { query: "237" }, via: "code" });
    expect(inner.steps).toBe(0);
    const { client, calls } = fakeJev({ operation: { choice: "CLICK" }, click_target: { choice: "e2" } });
    await new JevFirstModel({ inner, jev: client, offerEscalate: false }).step(req([page()], goal), signal); // complete page: asks Jev
    expect(calls).toHaveLength(1);
  });
});

describe("circling", () => {
  const goto = (url: string): Observation => ({ kind: "tool_result", tool: "browser.goto", input: { url }, outcome: { status: "ok", output: { url, ariaSnapshot: "" } } });
  it("is true only when the same address was opened twice", () => {
    expect(circling([goto("http://s/a"), goto("http://s/b")])).toBe(false);
    expect(circling([goto("http://s/a"), goto("http://s/b"), goto("http://s/a")])).toBe(true);
    expect(circling([])).toBe(false);
  });

  it("takes the fallback's step away and gives it to the main model when circling", async () => {
    const inner = new Inner();
    const fallback = new Inner();
    const m = new JevFirstModel({ inner, jev: fakeJev({ operation: { choice: "CLICK", confidence: 0.3 }, click_target: { choice: "e2" } }).client, fallback });
    await m.step(req([goto("http://s/a"), page(), goto("http://s/a"), page()]), signal);
    expect(inner.steps).toBe(1);
    expect(fallback.steps).toBe(0);
  });
});

describe("JevFirstModel", () => {
  it("decides a click with no main-model call, in one Jev request, using only the chosen operation's target", async () => {
    const { client, calls } = fakeJev({ operation: { choice: "CLICK" }, click_target: { choice: "e2" }, type_target: { choice: "e4" } });
    const { m, inner } = model(client);
    const r = await m.step(req([page()]), signal);
    expect(r).toMatchObject({ type: "tool_call", tool: "browser.click", input: { ref: "e2" }, via: "jev" });
    expect(inner.steps).toBe(0);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].questions).sort()).toEqual(["click_target", "operation", "type_target"]);
    expect(m.stats).toMatchObject({ asked: 1, used: 1, escalated: {}, inputTokens: 400 });
  });

  it("never offers a risky-named control or a credential field to Jev", async () => {
    const { client, calls } = fakeJev({ operation: { choice: "CLICK" }, click_target: { choice: "e1" } });
    await model(client).m.step(req([page()]), signal);
    const q = calls[0].questions;
    expect(Object.keys(q.click_target.criteria)).not.toContain("e3");
    expect(Object.keys(q.type_target.criteria)).toEqual(["e4", "none"]);
  });

  it("hands over when Jev picks ESCALATE", async () => {
    const { client } = fakeJev({ operation: { choice: "ESCALATE" }, click_target: { choice: "e1" } });
    const { m, inner } = model(client);
    await m.step(req([page()]), signal);
    expect(inner.steps).toBe(1);
    expect(m.stats.escalated).toEqual({ jev_escalate: 1 });
  });

  it("hands over when the operation or the target is below the confidence threshold", async () => {
    const lowOp = model(fakeJev({ operation: { choice: "CLICK", confidence: 0.6 }, click_target: { choice: "e1" } }).client);
    await lowOp.m.step(req([page()]), signal);
    expect(lowOp.m.stats.escalated).toEqual({ jev_unsure: 1 });
    const lowTarget = model(fakeJev({ operation: { choice: "CLICK" }, click_target: { choice: "e1", confidence: 0.5 } }).client);
    await lowTarget.m.step(req([page()]), signal);
    expect(lowTarget.m.stats.escalated).toEqual({ jev_unsure: 1 });
    expect(lowTarget.inner.steps).toBe(1);
  });

  it("hands over when Jev says no listed element fits", async () => {
    const { m, inner } = model(fakeJev({ operation: { choice: "CLICK" }, click_target: { choice: "none" } }).client);
    await m.step(req([page()]), signal);
    expect(inner.steps).toBe(1);
    expect(m.stats.escalated).toEqual({ jev_unsure: 1 });
  });

  it("works on a page with a single field (a target question still has two options)", async () => {
    const { client, calls } = fakeJev({ operation: { choice: "TYPE_TEXT" }, type_target: { choice: "e4" } });
    const only = '- textbox "Search" [ref=e4]';
    const { m } = model(client, { textWriter: writer("x") });
    const r = await m.step(req([page(only)]), signal);
    expect(r).toMatchObject({ tool: "browser.type", input: { ref: "e4" } });
    expect(Object.keys(calls[0].questions.type_target.criteria)).toEqual(["e4", "none"]);
  });

  it("finishes by itself, with no main-model call, when Jev says the goal is reached", async () => {
    const { m, inner } = model(fakeJev({ operation: { choice: "DONE" } }).client);
    const r = await m.step(req([page()]), signal);
    expect(r.type).toBe("finish");
    expect(inner.steps).toBe(0);
    expect(m.stats.escalated).toEqual({ done: 1 });
  });

  it("falls back to the main model when Jev is down or answers badly", async () => {
    const down = model(fakeJev({}, 503).client);
    await down.m.step(req([page()]), signal);
    expect(down.inner.steps).toBe(1);
    expect(down.m.stats.escalated).toEqual({ jev_failed: 1 });
    // an operation answer is missing: nothing is guessed
    const missing = model(fakeJev({ click_target: { choice: "e1" } }).client);
    await missing.m.step(req([page()]), signal);
    expect(missing.m.stats.escalated).toEqual({ jev_failed: 1 });
  });

  it("does not ask Jev on the first step, or after anything other than a read page", async () => {
    const { client, calls } = fakeJev({ operation: { choice: "CLICK" }, click_target: { choice: "e1" } });
    const { m, inner } = model(client);
    await m.step(req([]), signal);
    const denied: Observation[] = [page(), { kind: "tool_denied", tool: "browser.click", input: {}, reason: "no" }];
    await m.step(req(denied), signal);
    const failed: Observation[] = [page(), { kind: "tool_result", tool: "browser.click", input: {}, outcome: { status: "error", error: "x" } }];
    await m.step(req(failed), signal);
    expect(calls).toHaveLength(0);
    expect(inner.steps).toBe(3);
    expect(m.stats.escalated).toEqual({ no_page: 3 });
  });

  it("hands over when an action left the page unchanged, instead of looping", async () => {
    const { client, calls } = fakeJev({ operation: { choice: "CLICK" }, click_target: { choice: "e1" } });
    const { m, inner } = model(client);
    await m.step(req([page(), page(PAGE, "browser.click")]), signal);
    expect(calls).toHaveLength(0);
    expect(inner.steps).toBe(1);
    expect(m.stats.escalated).toEqual({ no_progress: 1 });
  });

  it("gives the main model a checkpoint every N steps however sure Jev is", async () => {
    const { client, calls } = fakeJev({ operation: { choice: "CLICK" }, click_target: { choice: "e1" } });
    const { m, inner } = model(client, { checkpointEvery: 2 });
    const changed = (n: number) => page(`${PAGE}\n  - link "Step ${n}" [ref=e9]`, "browser.click");
    await m.step(req([page(), changed(1)]), signal); // 2 observations: checkpoint
    expect(calls).toHaveLength(0);
    expect(inner.steps).toBe(1);
    await m.step(req([page(), changed(1), changed(2)]), signal); // 3: Jev again
    expect(calls).toHaveLength(1);
    expect(m.stats.escalated).toEqual({ checkpoint: 1 });
  });

  it("hands typing to the main model when no text writer is configured", async () => {
    const { client } = fakeJev({ operation: { choice: "TYPE_TEXT" }, type_target: { choice: "e4" } });
    const { m, inner } = model(client);
    await m.step(req([page()]), signal);
    expect(inner.steps).toBe(1);
    expect(m.stats.escalated).toEqual({ needs_text: 1 });
  });

  it("types the writer's text into the field Jev chose, counting both usages", async () => {
    const w = writer("tabby cats");
    const { client } = fakeJev({ operation: { choice: "TYPE_TEXT" }, type_target: { choice: "e4" } });
    const { m, inner } = model(client, { textWriter: w });
    const r = await m.step(req([page()], "Search for tabby cats"), signal);
    expect(r).toMatchObject({ type: "tool_call", tool: "browser.type", input: { ref: "e4", text: "tabby cats" }, via: "jev", usage: { inputTokens: 407, outputTokens: 43 } });
    expect(inner.steps).toBe(0);
    expect(w.calls).toHaveLength(1);
  });

  it("hands over when the text writer has no value, and types nothing", async () => {
    const { client } = fakeJev({ operation: { choice: "TYPE_TEXT" }, type_target: { choice: "e4" } });
    const { m, inner } = model(client, { textWriter: writer(null) });
    const r = await m.step(req([page()]), signal);
    expect(r.type).toBe("finish");
    expect(inner.steps).toBe(1);
    expect(m.stats.escalated).toEqual({ no_text: 1 });
  });

  it("treats an answer outside the offered options as invalid and hands over", async () => {
    const { client } = fakeJev({ operation: { choice: "CLICK" }, click_target: { choice: "e3" } }); // e3 (Delete) was never offered
    const { m, inner } = model(client);
    await m.step(req([page()]), signal);
    expect(inner.steps).toBe(1);
    expect(m.stats.escalated).toEqual({ jev_failed: 1 });
  });
});

describe("typing a value taken from the goal", () => {
  const typeOp = { operation: { choice: "TYPE_TEXT" }, type_target: { choice: "e4" } };
  const GOAL = "Search for tabby cats on this site";

  it("types the span Jev picks out of the goal, verbatim, with no text writer and no main-model call", async () => {
    const { client, calls } = fakeJev({ ...typeOp, start: { choice: "w2" }, end: { choice: "w3" } });
    const { m, inner } = model(client);
    const r = await m.step(req([page()], GOAL), signal);
    expect(r).toMatchObject({ type: "tool_call", tool: "browser.type", input: { ref: "e4", text: "tabby cats" }, via: "jev" });
    expect(inner.steps).toBe(0);
    expect(calls).toHaveLength(2); // the decision, then the span
    expect(Object.keys(calls[1].questions).sort()).toEqual(["end", "start"]);
    expect(calls[1].questions.start.criteria.w2).toBe("tabby");
    expect(m.stats.inputTokens).toBe(800);
  });

  it("strips quotes and trailing punctuation from the cut-out span", async () => {
    const { client } = fakeJev({ ...typeOp, start: { choice: "w1" }, end: { choice: "w1" } });
    const { m } = model(client);
    const r = await m.step(req([page()], 'Search "cats," please'), signal);
    expect(r).toMatchObject({ input: { ref: "e4", text: "cats" } });
  });

  it.each([
    ["Jev says the goal does not say", { start: { choice: "none" }, end: { choice: "none" } }],
    ["the span is unsure", { start: { choice: "w2", confidence: 0.5 }, end: { choice: "w3" } }],
    ["the end is before the start", { start: { choice: "w3" }, end: { choice: "w2" } }],
    ["the span is too long", { start: { choice: "w0" }, end: { choice: "w3" }, long: true }],
  ])("hands typing to the main model when %s", async (_name, answers) => {
    const { long, ...rest } = answers as any;
    const goal = long ? "a b c d e f g h i j k l m n o p" : GOAL;
    const ans = long ? { ...rest, end: { choice: "w14" } } : rest;
    const { client } = fakeJev({ ...typeOp, ...ans });
    const { m, inner } = model(client);
    await m.step(req([page()], goal), signal);
    expect(inner.steps).toBe(1);
    expect(m.stats.escalated).toEqual({ needs_text: 1 });
  });

  it("uses the text writer when the value is not in the goal", async () => {
    const w = writer("20/09/2026");
    const { client } = fakeJev({ ...typeOp, start: { choice: "none" }, end: { choice: "none" } });
    const { m, inner } = model(client, { textWriter: w });
    const r = await m.step(req([page()], "Pick a flight on September 20 2026"), signal);
    expect(r).toMatchObject({ tool: "browser.type", input: { ref: "e4", text: "20/09/2026" } });
    expect(inner.steps).toBe(0);
    expect(w.calls).toHaveLength(1);
  });

  it("never types anything into a credential field, whatever the goal says", async () => {
    const { client, calls } = fakeJev({ operation: { choice: "TYPE_TEXT" }, type_target: { choice: "e5" }, start: { choice: "w0" }, end: { choice: "w0" } });
    const { m, inner } = model(client);
    await m.step(req([page()], "Password hunter2 please"), signal);
    expect(Object.keys(calls[0].questions.type_target.criteria)).not.toContain("e5");
    expect(inner.steps).toBe(1); // an answer outside the offered options is invalid
  });
});

describe("consensus: every question asked twice, in opposite option orders", () => {
  const both = (op: string, target: string, reversedOp = op, reversedTarget = target) =>
    fakeJev({ operation: { choice: op }, operation__reversed: { choice: reversedOp }, click_target: { choice: target }, click_target__reversed: { choice: reversedTarget } });

  it("sends the reversed copy in the same request, and nothing extra when it is off", async () => {
    const on = both("CLICK", "e2");
    await model(on.client, { consensus: true }).m.step(req([page()]), signal);
    expect(on.calls).toHaveLength(1);
    const q = on.calls[0].questions;
    expect(Object.keys(q.click_target__reversed.criteria)).toEqual(Object.keys(q.click_target.criteria).reverse());
    expect(Object.keys(q.operation__reversed.criteria)).toEqual(Object.keys(q.operation.criteria).reverse());
    expect(q.click_target__reversed.instructions).toBe(q.click_target.instructions);

    const off = both("CLICK", "e2");
    await model(off.client).m.step(req([page()]), signal);
    expect(Object.keys(off.calls[0].questions).some((k) => k.endsWith("__reversed"))).toBe(false);
  });

  it("acts when both orders pick the same operation and the same target", async () => {
    const { m, inner } = model(both("CLICK", "e2").client, { consensus: true });
    const r = await m.step(req([page()]), signal);
    expect(r).toMatchObject({ type: "tool_call", tool: "browser.click", input: { ref: "e2" }, via: "jev" });
    expect(inner.steps).toBe(0);
    expect(m.stats.disagreed).toBeUndefined();
  });

  it("hands the step over when the target differs between the two orders", async () => {
    const { m, inner } = model(both("CLICK", "e2", "CLICK", "e1").client, { consensus: true });
    const r = await m.step(req([page()]), signal);
    expect(r.type).toBe("finish"); // the main model (Inner) took the step
    expect(inner.steps).toBe(1);
    expect(m.stats.disagreed).toBe(1);
    expect(m.stats.escalated).toEqual({ jev_unsure: 1 });
  });

  it("hands the step over when the operation differs, or when the second answer is missing", async () => {
    const differ = model(both("CLICK", "e2", "DONE").client, { consensus: true });
    await differ.m.step(req([page()]), signal);
    expect(differ.inner.steps).toBe(1);

    const missing = model(fakeJev({ operation: { choice: "CLICK" }, click_target: { choice: "e2" } }).client, { consensus: true });
    await missing.m.step(req([page()]), signal);
    expect(missing.inner.steps).toBe(1);
  });

  it("does not agree if the second answer is below the confidence threshold", async () => {
    const { client } = fakeJev({ operation: { choice: "CLICK" }, operation__reversed: { choice: "CLICK", confidence: 0.2 }, click_target: { choice: "e2" }, click_target__reversed: { choice: "e2" } });
    const { m, inner } = model(client, { consensus: true });
    await m.step(req([page()]), signal);
    expect(inner.steps).toBe(1);
  });
});
