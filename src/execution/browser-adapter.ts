export interface PageSnapshot {
  url: string;
  /** Accessibility-tree YAML. Page-controlled text: untrusted. */
  ariaSnapshot: string;
}

export interface ElementInfo {
  ref: string;
  role: string;
  name: string;
  tag: string;
  /** For inputs and buttons: the `type` attribute (a bare <button> reports "submit"). */
  inputType: string | null;
  insideForm: boolean;
  formMethod: string | null;
  formAction: string | null;
  /**
   * True only for a form that merely looks something up: method GET, sent to the page's own site, with
   * no password or file field. Submitting it is an ordinary navigation, not an action with effects.
   */
  formSameOriginGet: boolean;
  href: string | null;
  download: boolean;
}

/** Thrown when a ref is unknown, outdated, or no longer points at the element it did. */
export class StaleRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleRefError";
  }
}

export class NavigationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NavigationBlockedError";
  }
}

/**
 * The only way the rest of the system touches a browser. No library types leak through.
 *
 * Elements are addressed by `ref` values that appear in the output of the most recent
 * `snapshot()`. A ref is only valid until the next `snapshot()` or navigation; implementations
 * must reject (StaleRefError) rather than act on a different element.
 */
export interface BrowserAdapter {
  /** Cheap, side-effect-free current page URL. */
  currentUrl(): string;
  goto(url: string): Promise<void>;
  click(ref: string): Promise<void>;
  type(ref: string, text: string): Promise<void>;
  /** Scrolls the page by about one screen and says whether the position changed (false: already at that end). Content that loads on scroll is waited for briefly. Refs are refreshed by the next snapshot. */
  scroll(direction: "down" | "up"): Promise<{ moved: boolean }>;
  /** Chooses the option with this visible label in a native dropdown (<select>). */
  select(ref: string, option: string): Promise<void>;
  /** Captures the page with refs. Invalidates refs from earlier snapshots. */
  snapshot(): Promise<PageSnapshot>;
  /** Read-only page state without refs and without side effects on existing refs (for verification). */
  readState(): Promise<PageSnapshot>;
  /** Captures the visible viewport as an image, for the task's evidence trail. */
  screenshot(): Promise<{ data: Buffer; mime: "image/jpeg" }>;
  /** Describes what a ref currently points at, for risk classification and approvals. */
  inspect(ref: string): Promise<ElementInfo>;
  close(): Promise<void>;
}

/**
 * Optional capability: put a prepared rich-text document into an editor as a paste, so the page's own
 * editor converts headings, lists, bold and links. Not part of BrowserAdapter: only the
 * `browser.paste_document` tool uses it, with text the owner attached to the task (never model output).
 */
export interface RichPasteable {
  pasteRich(ref: string, html: string, text: string): Promise<void>;
}

export function canPasteRich(b: unknown): b is RichPasteable {
  return typeof b === "object" && b !== null && typeof (b as RichPasteable).pasteRich === "function";
}
