import type { BrowserAdapter } from "../execution/browser-adapter.js";
import type { StorageState } from "../execution/login-state.js";

/** What a new browser should start with. */
export interface LaunchOptions {
  /** Saved logins to load, so the task starts signed in. */
  storageState?: StorageState;
  /** "chrome": open a tab in the owner's own Chrome instead of the default browser. */
  target?: "chrome";
}

interface Session {
  browser: BrowserAdapter;
  idleTimer: NodeJS.Timeout | null;
}

/**
 * Keeps one browser per task alive across pauses (notably while waiting for approval), so an
 * approved action runs on the same page it was proposed on. Sessions live in this process only;
 * if one is lost (restart, idle timeout) the caller gets a fresh browser and a flag saying so.
 */
export class BrowserSessions {
  private readonly sessions = new Map<string, Session>();
  /** Browsers still starting up. A second caller for the same task waits for it instead of launching another. */
  private readonly launching = new Map<string, Promise<BrowserAdapter>>();

  constructor(
    private readonly launch: (opts: LaunchOptions) => Promise<BrowserAdapter>,
    private readonly idleMs: number,
  ) {}

  /** Returns the task's browser, launching one if needed. `fresh` is true when it was just launched. */
  async acquire(taskId: string, opts: LaunchOptions = {}): Promise<{ browser: BrowserAdapter; fresh: boolean }> {
    const existing = this.sessions.get(taskId);
    if (existing) {
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
      return { browser: existing.browser, fresh: false };
    }
    const pending = this.launching.get(taskId);
    if (pending) return { browser: await pending, fresh: false };
    const starting = this.launch(opts).then((browser) => {
      this.sessions.set(taskId, { browser, idleTimer: null });
      return browser;
    });
    this.launching.set(taskId, starting);
    try {
      return { browser: await starting, fresh: true };
    } finally {
      this.launching.delete(taskId);
    }
  }

  /** Marks the session idle: it is closed automatically if nobody acquires it within the TTL. */
  keep(taskId: string): void {
    const s = this.sessions.get(taskId);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => void this.close(taskId), this.idleMs);
    s.idleTimer.unref();
  }

  async close(taskId: string): Promise<void> {
    const s = this.sessions.get(taskId);
    if (!s) return;
    this.sessions.delete(taskId);
    if (s.idleTimer) clearTimeout(s.idleTimer);
    await s.browser.close().catch(() => {});
  }

  /** The task's live browser without launching one. Used for the live view; it does not touch the idle timer. */
  peek(taskId: string): BrowserAdapter | undefined {
    return this.sessions.get(taskId)?.browser;
  }

  has(taskId: string): boolean {
    return this.sessions.has(taskId);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
