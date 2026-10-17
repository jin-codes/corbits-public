import { z } from "zod";

/**
 * A standing approval is the owner's advance permission for a few exact clicks on one site (for example the
 * Publish buttons of the owner's own blog), given when the task is created. It never widens what the policy
 * engine considers consequential: the click is still held for approval, and the orchestrator then records that
 * approval itself, in the open (`approval.auto_approved` event with the grant and the control), instead of
 * waiting for a person.
 *
 * Deliberately narrow: only `browser.click`, only on an https origin the owner names, only on a control whose
 * accessible name equals one of the listed names (case-insensitively), never a download or a field, at most a
 * few grants per task, and at most MAX_AUTO_APPROVALS uses. Only an admin token can set it (the API checks);
 * the model can neither add one nor widen one.
 */
export const StandingApprovalSchema = z
  .object({
    tool: z.literal("browser.click"),
    origin: z.string().trim().max(200).refine(isHttpsOrigin, "must be an https origin such as https://example.com"),
    names: z.array(z.string().trim().min(1).max(60)).min(1).max(8),
  })
  .strict();
export const StandingApprovalsSchema = z.array(StandingApprovalSchema).min(1).max(3);
export type StandingApproval = z.infer<typeof StandingApprovalSchema>;

export const MAX_AUTO_APPROVALS = 8;

function isHttpsOrigin(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.origin === v.replace(/\/$/, "");
  } catch {
    return false;
  }
}

/** The grants stored in a task's constraints, ignoring anything malformed (a bad value grants nothing). */
export function standingApprovalsOf(constraints: Record<string, unknown>): StandingApproval[] {
  const parsed = StandingApprovalsSchema.safeParse(constraints.standingApprovals);
  return parsed.success ? parsed.data : [];
}

export interface Granted {
  origin: string;
  name: string;
}

/** The grant that covers this proposed call, if any. `inspection` is the tool's own read of the target. */
export function matchStandingApproval(
  grants: readonly StandingApproval[],
  tool: string,
  inspection: Record<string, unknown> | undefined,
  pageUrl: unknown,
): Granted | null {
  if (!inspection || typeof pageUrl !== "string") return null;
  if (inspection.download === true) return null;
  const name = typeof inspection.name === "string" ? inspection.name.trim().toLowerCase() : "";
  if (!name) return null;
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return null;
  }
  for (const g of grants) {
    if (g.tool !== tool || new URL(g.origin).origin !== origin) continue;
    if (g.names.some((n) => n.toLowerCase() === name)) return { origin, name: String(inspection.name).trim() };
  }
  return null;
}
