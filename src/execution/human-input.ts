import { z } from "zod";
import type { StorageState } from "./login-state.js";

/**
 * What a person can do to the live browser while they are in control. Deliberately small and
 * validated: pointer clicks, typed text, named keys and scrolling. There is no way to run
 * script, navigate by URL, or read anything back except a picture of the page.
 */
const KEY = /^(?:(?:Control|Shift|Alt|Meta)\+)*(?:[A-Za-z0-9]|Enter|Tab|Backspace|Delete|Escape|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|F[1-9]|F1[0-2])$/;
const coord = z.number().finite().min(0).max(10_000);

export const HumanInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: coord, y: coord, double: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(500) }).strict(),
  z.object({ type: z.literal("key"), key: z.string().regex(KEY) }).strict(),
  z.object({ type: z.literal("scroll"), x: coord, y: coord, dx: z.number().finite().min(-3000).max(3000), dy: z.number().finite().min(-3000).max(3000) }).strict(),
]);
export type HumanInput = z.infer<typeof HumanInputSchema>;

export interface LiveFrame {
  data: Buffer;
  mime: "image/jpeg";
  width: number;
  height: number;
}

/**
 * Implemented by browsers a person can drive. Kept apart from BrowserAdapter on purpose: the
 * agent's tools only ever receive a BrowserAdapter, so they cannot reach these methods.
 */
export interface HumanControllable {
  liveFrame(): Promise<LiveFrame>;
  applyInput(input: HumanInput): Promise<void>;
  /** Optional: show or hide the on-page "agent is working" border. */
  setAgentDriving?(on: boolean): Promise<void>;
  /**
   * The logins this browser holds for the site of the page now open, and nothing else. Used when the owner
   * signs in by hand and chooses to keep that login for later tasks.
   */
  captureLoginState(): Promise<{ origin: string; state: StorageState }>;
}

export function isHumanControllable(b: unknown): b is HumanControllable {
  return typeof b === "object" && b !== null && typeof (b as HumanControllable).liveFrame === "function" && typeof (b as HumanControllable).applyInput === "function" && typeof (b as HumanControllable).captureLoginState === "function";
}
