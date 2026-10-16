const PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, "[REDACTED:anthropic-key]"],
  [/\bsk-[A-Za-z0-9]{20,}/g, "[REDACTED:api-key]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED:github-token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws-key]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [REDACTED]"],
  // key=value / "key": "value" style assignments for obviously secret-named keys
  [
    /((?:api[_-]?key|secret|token|password|passwd|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
    "$1[REDACTED]",
  ],
];

/**
 * Best-effort secret scrubbing for anything we persist or show. Pattern matching can miss
 * unusual formats, so known secret values (e.g. our own API keys) are also redacted verbatim.
 */
export class Redactor {
  private readonly secrets = new Set<string>();

  /** Registers an exact secret value to scrub everywhere. Very short values are ignored. */
  addSecret(value: string | undefined): this {
    if (value && value.length >= 8) this.secrets.add(value);
    return this;
  }

  redactString(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join("[REDACTED]");
    for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
    return out;
  }

  /** Deep-redacts any JSON-like value; returns a new value and never mutates the input. */
  redact<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(v: unknown): unknown {
    if (typeof v === "string") return this.redactString(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[this.redactString(k)] = this.walk(val);
      return out;
    }
    return v;
  }
}

export const defaultRedactor = new Redactor();
