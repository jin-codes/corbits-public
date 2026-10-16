import type { ModelAdapter, ModelUsage, PlanResult, StepRequest, StepResult } from "../model/types.js";

export const USAGE: ModelUsage = { inputTokens: 10, outputTokens: 5, costUsd: 0.01 };

export const call = (tool: string, input: unknown): StepResult => ({ type: "tool_call", tool, input, usage: USAGE });
export const finish = (summary = "done"): StepResult => ({ type: "finish", summary, usage: USAGE });

/** A model whose next move is a pure function of what it has observed, so it survives "restarts". */
export class MockModel implements ModelAdapter {
  readonly stepRequests: StepRequest[] = [];
  planCalls = 0;
  constructor(
    private readonly decide: (req: StepRequest) => StepResult | Promise<StepResult>,
    private readonly planResult: Partial<PlanResult> = {},
  ) {}

  async plan(): Promise<PlanResult> {
    this.planCalls++;
    return { steps: ["do the task"], criteria: [], usage: USAGE, ...this.planResult };
  }

  async step(req: StepRequest): Promise<StepResult> {
    this.stepRequests.push(req);
    return this.decide(req);
  }
}

export const done = (req: StepRequest, tool: string) =>
  req.observations.some((o) => o.kind === "tool_result" && o.tool === tool && o.outcome.status === "ok");
