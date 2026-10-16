import { ModelError, type ModelAdapter, type PlanRequest, type PlanResult, type StepRequest, type StepResult } from "../model/types.js";

export type ModelAccess = "server" | "own-key" | "blocked";

/**
 * Which model runs a given person's task, and so whose account pays:
 *  - admins use the server's model (the owner's own login or key);
 *  - anyone with their own API key uses it, whatever the server runs on;
 *  - anyone else uses the server's model only if it is an API key (never the owner's personal Claude login).
 */
export async function accessFor(opts: {
  admin: boolean;
  hasOwnKey: boolean;
  /** True when the server's model is a shared API key, as opposed to the owner's personal Claude login. */
  serverModelIsShareable: boolean;
}): Promise<ModelAccess> {
  if (opts.admin) return "server";
  if (opts.hasOwnKey) return "own-key";
  return opts.serverModelIsShareable ? "server" : "blocked";
}

/** What a task gets when it may not run: it fails with a plain reason instead of using someone else's login. */
export function unavailableModel(message: string): ModelAdapter {
  const fail = async (): Promise<never> => {
    throw new ModelError("unavailable", message);
  };
  return { plan: fail as (r: PlanRequest) => Promise<PlanResult>, step: fail as (r: StepRequest) => Promise<StepResult> };
}

export type JevChoice = "first" | "only" | "summary" | "assist";

export interface ModelRouterDeps {
  defaultModel: ModelAdapter;
  /** The server's model for a task that asked for a particular Jev mode. Without it `defaultModel` is always used. */
  defaultFor?: (mode: JevChoice) => ModelAdapter;
  isAdmin: (owner: string) => Promise<boolean>;
  /** The owner's decrypted key, or null. */
  ownKey: (owner: string) => Promise<string | null>;
  serverModelIsShareable: boolean;
  /** Builds the model for someone's own key (and wraps it with anything else the server adds, such as Jev). */
  forKey: (apiKey: string, mode?: JevChoice) => ModelAdapter;
  /** Called with each key as it is used, so it can be scrubbed from logs, events and evidence. */
  onKey?: (apiKey: string) => void;
}

export function createModelRouter(d: ModelRouterDeps): (owner: string, mode?: JevChoice) => Promise<ModelAdapter> {
  return async (owner, mode) => {
    const server = () => (mode && d.defaultFor ? d.defaultFor(mode) : d.defaultModel);
    if (await d.isAdmin(owner)) return server();
    const key = await d.ownKey(owner);
    if (key) {
      d.onKey?.(key);
      return d.forKey(key, mode);
    }
    return d.serverModelIsShareable
      ? server()
      : unavailableModel("This task needs your own Anthropic API key, and none is saved. Add one in Settings, then continue the task.");
  };
}
