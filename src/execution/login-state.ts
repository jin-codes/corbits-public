import { z } from "zod";

/**
 * What it takes to be signed in to a site: its cookies and its local storage. The shape is Playwright's
 * `storageState`, which is what a new browser context accepts. Values in here are credentials: they are
 * stored encrypted, never shown to the model, and never put in history or logs.
 */
const Cookie = z.object({
  name: z.string().max(512),
  value: z.string().max(8192),
  domain: z.string().max(512),
  path: z.string().max(1024),
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]),
});
const OriginStorage = z.object({
  origin: z.string().max(512),
  localStorage: z.array(z.object({ name: z.string().max(512), value: z.string().max(65_536) })).max(500),
});
export const StorageStateSchema = z.object({ cookies: z.array(Cookie).max(300), origins: z.array(OriginStorage).max(5) });
export type StorageState = z.infer<typeof StorageStateSchema>;

export class LoginStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginStateError";
  }
}

/** Where a login may be saved: https (plain http only for this machine, so local development works). */
export function loginOrigin(pageUrl: string): string {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    throw new LoginStateError("There is no page open to save a login from");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new LoginStateError("A login can only be saved from an https page");
  }
  return u.origin;
}

/** RFC 6265 domain matching: a cookie for `example.com` (or `.example.com`) applies to example.com and its subdomains. */
export function cookieAppliesTo(cookieDomain: string, host: string): boolean {
  const d = cookieDomain.replace(/^\./, "").toLowerCase();
  const h = host.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/**
 * Keeps only what belongs to the page's own site: cookies that apply to its host and local storage for its
 * exact origin. A browser holds logins for many sites; saving one must never save the others.
 */
export function filterStorageState(raw: StorageState, pageUrl: string): { origin: string; state: StorageState } {
  const origin = loginOrigin(pageUrl);
  const host = new URL(origin).hostname;
  return {
    origin,
    state: {
      cookies: raw.cookies.filter((c) => cookieAppliesTo(c.domain, host)),
      origins: raw.origins.filter((o) => o.origin === origin),
    },
  };
}

/** Combines several saved logins into one state for a new browser context. */
export function mergeStorageStates(states: readonly StorageState[]): StorageState {
  return { cookies: states.flatMap((s) => s.cookies), origins: states.flatMap((s) => s.origins) };
}

/** Every value that must be scrubbed if it ever shows up somewhere it should not. */
export function secretValues(state: StorageState): string[] {
  return [...state.cookies.map((c) => c.value), ...state.origins.flatMap((o) => o.localStorage.map((l) => l.value))].filter((v) => v.length >= 12);
}
