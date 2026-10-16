import { createHash } from "node:crypto";

/** Deterministic JSON: object keys sorted recursively so equal data always hashes equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Identity of one concrete action: tool + validated params + the context it was proposed in. */
export function actionFingerprint(tool: string, input: unknown, context: unknown): string {
  return sha256(canonicalJson({ tool, input, context }));
}

/** Identity of the real-world effect, independent of which tool produces it. */
export function effectFingerprint(effect: string): string {
  return sha256(`effect:${effect}`);
}

/** What an approval is bound to besides tool and params: where it ran and what it actually targeted. */
export function fingerprintContext(context: unknown, inspection: Record<string, unknown> | undefined) {
  return { context, inspection: inspection ?? null };
}
