import type { BrowserAdapter } from "../execution/browser-adapter.js";
import type { TaskStore } from "../persistence/task-store.js";
import { defaultRedactor, type Redactor } from "../security/redact.js";
import type { ArtifactKind, ArtifactStore } from "./artifact-store.js";

export interface CaptureRequest {
  /** Which history entry the capture belongs to, e.g. "tool:<callId>" or "approval:<id>". */
  attachKey: string;
  label: string;
  kinds: ArtifactKind[];
}

/** Captures evidence for a task. Must never throw into, or slow down, task execution. */
export interface ArtifactRecorder {
  capture(taskId: string, req: CaptureRequest): Promise<void>;
}

const MAX_TEXT_CHARS = 200_000;

export class BrowserArtifactRecorder implements ArtifactRecorder {
  private readonly reportedSkips = new Set<string>();
  private readonly redactor: Redactor;
  private readonly timeoutMs: number;

  constructor(
    private readonly d: {
      browser: BrowserAdapter;
      artifacts: ArtifactStore;
      store: TaskStore;
      redactor?: Redactor;
      timeoutMs?: number;
    },
  ) {
    this.redactor = d.redactor ?? defaultRedactor;
    this.timeoutMs = d.timeoutMs ?? 8_000;
  }

  async capture(taskId: string, req: CaptureRequest): Promise<void> {
    for (const kind of req.kinds) {
      try {
        await this.captureOne(taskId, req, kind);
      } catch (err) {
        await this.note(taskId, "artifact.failed", { kind, attachKey: req.attachKey, error: this.redactor.redactString(String((err as Error)?.message ?? err)).slice(0, 200) });
      }
    }
  }

  private async captureOne(taskId: string, req: CaptureRequest, kind: ArtifactKind): Promise<void> {
    const item = await withTimeout(this.collect(kind), this.timeoutMs);
    const result = await this.d.artifacts.put({ taskId, kind, mime: item.mime, label: req.label, attachKey: req.attachKey, data: item.data });
    if (!result.stored) {
      // Report each reason once per run; a full quota would otherwise flood the history.
      const key = `${kind}:${result.reason}`;
      if (!this.reportedSkips.has(key)) {
        this.reportedSkips.add(key);
        await this.note(taskId, "artifact.skipped", { kind, reason: result.reason, attachKey: req.attachKey });
      }
      return;
    }
    // A duplicate points the new history entry at the image that is already stored.
    await this.note(taskId, "artifact.created", {
      artifactId: result.artifact.id,
      kind,
      mime: result.artifact.mime,
      label: req.label,
      attachKey: req.attachKey,
      ...(result.duplicateOf ? { duplicateOf: result.duplicateOf } : {}),
    });
  }

  private async collect(kind: ArtifactKind): Promise<{ data: Buffer; mime: "image/jpeg" | "text/plain" }> {
    if (kind === "screenshot") return this.d.browser.screenshot();
    const { url, ariaSnapshot } = await this.d.browser.readState();
    let text = this.redactor.redactString(ariaSnapshot);
    if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n…[truncated]`;
    return { data: Buffer.from(`URL: ${url}\n\n${text}`, "utf8"), mime: "text/plain" };
  }

  private async note(taskId: string, type: string, payload: Record<string, unknown>) {
    try {
      await this.d.store.appendEvent(taskId, type, payload);
    } catch {
      /* evidence is best effort */
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
