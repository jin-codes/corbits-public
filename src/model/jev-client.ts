import { z } from "zod";

/**
 * A minimal client for Jev (TypeSafe's decision model), for exactly one kind of question: pick one of a
 * closed set of options and say how sure it is. Docs: https://docs.typesafe.ai/api.md
 *
 * Jev only judges text it is given and returns a probability for every option, so the caller decides
 * what to do with the answer. It does not treat its input as hostile: never feed it unsanitized page text
 * and never use it for permission or approval decisions.
 */
export class JevError extends Error {
  constructor(
    readonly kind: "unavailable" | "timeout" | "invalid_response" | "rate_limited",
    message: string,
  ) {
    super(message);
    this.name = "JevError";
  }
}

const ChoiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number()),
});
const Response = z.object({
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});

export interface ChoiceRequest {
  /** What is being decided about. Keep it small, structured, and free of untrusted text where possible. */
  state: Record<string, unknown>;
  instructions: string;
  /** option name -> what choosing it means. At most 255. */
  criteria: Record<string, string>;
}

export interface ChoiceResult {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
}

export interface ChoiceQuestion {
  instructions: string;
  criteria: Record<string, string>;
}

export interface ChoiceAnswerResult {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ManyResult {
  /** Only questions whose answer was a valid choice among the offered options appear here. */
  answers: Record<string, ChoiceAnswerResult>;
  inputTokens: number;
  outputTokens: number;
}

export interface JevClientConfig {
  apiKey: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class JevClient {
  private readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(private readonly cfg: JevClientConfig) {
    this.model = cfg.model ?? "jev-latest";
    this.endpoint = cfg.endpoint ?? "https://api.typesafe.ai/v1/systemone";
    this.timeoutMs = cfg.timeoutMs ?? 8_000;
    this.doFetch = cfg.fetch ?? fetch;
  }

  async choose(req: ChoiceRequest, signal?: AbortSignal): Promise<ChoiceResult> {
    const answers = await this.ask(req.state, { pick: { instructions: req.instructions, criteria: req.criteria } }, signal);
    return answers.results.pick!.withUsage(answers);
  }

  /**
   * Several independent choice questions about the same state in ONE request (Jev answers every question
   * in parallel). The caller reads only the answers it needs; each answer is validated on its own.
   */
  async chooseMany(state: Record<string, unknown>, questions: Record<string, ChoiceQuestion>, signal?: AbortSignal): Promise<ManyResult> {
    const a = await this.ask(state, questions, signal);
    const answers: Record<string, ChoiceAnswerResult> = {};
    for (const [name, r] of Object.entries(a.results)) answers[name] = r.answer;
    return { answers, inputTokens: a.inputTokens, outputTokens: a.outputTokens };
  }

  private async ask(state: Record<string, unknown>, questions: Record<string, ChoiceQuestion>, signal?: AbortSignal) {
    for (const [name, q] of Object.entries(questions)) {
      const n = Object.keys(q.criteria).length;
      if (n < 2 || n > 255) throw new JevError("invalid_response", `a choice needs 2 to 255 options (question ${name} has ${n})`);
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.doFetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          state,
          questions: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { type: "choice", instructions: q.instructions, criteria: q.criteria }])),
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (timeout.aborted) throw new JevError("timeout", "Jev did not answer in time");
      throw new JevError("unavailable", `could not reach Jev: ${(err as Error)?.message ?? err}`);
    }
    if (res.status === 429) throw new JevError("rate_limited", "Jev rate limit reached");
    if (!res.ok) throw new JevError("unavailable", `Jev answered HTTP ${res.status}`); // never echo the body: it could echo input
    let json: z.infer<typeof Response>;
    try {
      json = Response.parse(await res.json());
    } catch {
      throw new JevError("invalid_response", "Jev returned something unexpected");
    }
    const inputTokens = json.usage.input_tokens;
    const outputTokens = json.usage.output_tokens;
    const results: Record<string, { answer: ChoiceAnswerResult; withUsage: (u: { inputTokens: number; outputTokens: number }) => ChoiceResult }> = {};
    for (const [name, q] of Object.entries(questions)) {
      const parsed = ChoiceAnswer.safeParse(json.answers[name]);
      if (!parsed.success) continue; // reported only if the caller needs this answer: unused heads must not fail the request
      // Anything outside the options we sent is not trusted.
      if (!Object.keys(q.criteria).includes(parsed.data.choice)) continue;
      const answer = { choice: parsed.data.choice, confidence: parsed.data.confidence, probabilities: parsed.data.probabilities };
      results[name] = { answer, withUsage: (u) => ({ ...answer, ...u }) };
    }
    if (Object.keys(results).length === 0) throw new JevError("invalid_response", "Jev's answers were not valid choices");
    return { results, inputTokens, outputTokens };
  }
}
