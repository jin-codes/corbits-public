import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  TASK_STATES,
  assertTransition,
  canTransition,
  isTaskState,
  isTerminal,
} from "./task-state.js";

describe("task state machine", () => {
  it("allows the normal lifecycle", () => {
    const path = ["queued", "planning", "running", "verifying", "completed"] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it("allows pausing for approval and resuming", () => {
    expect(canTransition("running", "awaiting_approval")).toBe(true);
    expect(canTransition("awaiting_approval", "running")).toBe(true);
  });

  it("hands a running task to a person and back, never from or to anywhere else", () => {
    expect(canTransition("running", "human_control")).toBe(true);
    expect(canTransition("human_control", "running")).toBe(true);
    for (const from of TASK_STATES) {
      if (from !== "running") expect(canTransition(from, "human_control")).toBe(false);
    }
    expect(canTransition("human_control", "verifying")).toBe(false);
    expect(canTransition("human_control", "completed")).toBe(false);
  });

  it("allows recovery after failed verification", () => {
    expect(canTransition("verifying", "running")).toBe(true);
  });

  it("never leaves a terminal state", () => {
    for (const from of ["completed", "unverified", "failed", "cancelled"] as const) {
      expect(isTerminal(from)).toBe(true);
      for (const to of TASK_STATES) expect(canTransition(from, to)).toBe(false);
    }
  });

  it("cannot skip verification to completed", () => {
    for (const from of TASK_STATES) {
      if (from !== "verifying") expect(canTransition(from, "completed")).toBe(false);
    }
  });

  it("reaches unverified only from verifying, and unverified is never a way to skip verification", () => {
    expect(canTransition("verifying", "unverified")).toBe(true);
    for (const from of TASK_STATES) {
      if (from !== "verifying") expect(canTransition(from, "unverified")).toBe(false);
    }
  });

  it("allows cancellation from every non-terminal state", () => {
    for (const from of TASK_STATES) {
      if (!isTerminal(from)) expect(canTransition(from, "cancelled")).toBe(true);
    }
  });

  it("rejects self transitions and backwards moves", () => {
    for (const s of TASK_STATES) expect(canTransition(s, s)).toBe(false);
    expect(canTransition("running", "planning")).toBe(false);
    expect(canTransition("planning", "queued")).toBe(false);
  });

  it("assertTransition throws InvalidTransitionError", () => {
    expect(() => assertTransition("queued", "completed")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("queued", "planning")).not.toThrow();
  });

  it("isTaskState validates untrusted input", () => {
    expect(isTaskState("running")).toBe(true);
    expect(isTaskState("done")).toBe(false);
    expect(isTaskState(undefined)).toBe(false);
  });
});
