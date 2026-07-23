/**
 * Request lifecycle state machine (spec §6).
 *
 *   submitted ──> input_required ──> working ──> input_required ──> completed
 *      │            (gate 1)                        (gate 2)
 *      │                └──> declined                   └──> declined
 *      ├──> auto_resolved     (T1: no gates)
 *      ├──> expired
 *      └──> cancelled
 *
 * The two `input_required` visits are distinguished by which decision field is
 * still null: intake_decision null => gate 1, release_decision null => gate 2.
 */
import type { RequestState } from "./types.js";

const TRANSITIONS: Record<RequestState, readonly RequestState[]> = {
  submitted: ["input_required", "auto_resolved", "expired", "cancelled"],
  // input_required is reused for both gates; from gate 1 it advances to
  // working, from gate 2 it advances to completed. Both can decline/expire/cancel.
  input_required: ["working", "completed", "declined", "expired", "cancelled"],
  working: ["input_required", "completed", "declined", "expired", "cancelled"],
  // terminal states
  completed: [],
  declined: [],
  auto_resolved: [],
  expired: [],
  cancelled: [],
};

export function canTransition(from: RequestState, to: RequestState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RequestState, to: RequestState): void {
  if (!canTransition(from, to)) {
    throw new StateTransitionError(from, to);
  }
}

export function isTerminal(state: RequestState): boolean {
  return TRANSITIONS[state].length === 0;
}

export class StateTransitionError extends Error {
  constructor(
    readonly from: RequestState,
    readonly to: RequestState,
  ) {
    super(`illegal state transition: ${from} -> ${to}`);
    this.name = "StateTransitionError";
  }
}
