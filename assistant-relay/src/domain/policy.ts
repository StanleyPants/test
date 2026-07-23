/**
 * Policy engine: tier routing (§3), depth/loop control (§10.3), rate limits
 * (§10.4). Pure decision logic; the store performs the actual reads/writes.
 */
import { config } from "../config.js";
import { err } from "../errors.js";
import type { RequestRecord, Tier } from "./types.js";

/** Which tier a caller is allowed to drive through which tool, in Phase 1. */
export const PHASE = "Phase 1: T2 delegation only" as const;

/**
 * Tier routing. In Phase 1 only T2 is live. T1 (declared capability) and T3
 * (negotiation) are recognized so the errors can name the right future path,
 * but they are refused now (spec §13: resist building 2/3 speculatively).
 */
export function assertTierEnabled(tier: Tier): void {
  if (tier === "t2") return;
  if (tier === "t1") {
    throw err.notEnabled(
      "T1 autonomous capability resolution",
      PHASE,
      "Submit this as a T2 delegation with relay_delegate. T1 capabilities are " +
        "promoted from observed T2 traffic (§3.1), not declared up front.",
    );
  }
  throw err.notEnabled(
    "T3 calendar negotiation",
    PHASE,
    "For scheduling in Phase 1, use the calendar free/busy tool (T0) to find a " +
      "slot, or relay_delegate to ask the person directly.",
  );
}

/**
 * Depth/loop control (§10.3):
 *  - assistant-origin requests inherit parent.depth + 1; human-origin resets to 0
 *  - hard cap on depth (default 2)
 *  - reject cycles: an ancestor chain already containing the same
 *    (from_user, to_user, capability_id) triple
 */
export interface DepthContext {
  origin: RequestRecord["origin"];
  parent: RequestRecord | null;
  fromUser: string;
  toUser: string;
  capabilityId: string | null;
  /** Ancestor triples, nearest-first, as returned by the store. */
  ancestorTriples: ReadonlyArray<{
    from_user: string;
    to_user: string;
    capability_id: string | null;
  }>;
}

export function resolveDepth(ctx: DepthContext): number {
  // human origin resets the chain
  if (ctx.origin === "human") return 0;
  const parentDepth = ctx.parent?.depth ?? 0;
  const depth = parentDepth + 1;
  if (depth > config.limits.maxDepth) {
    throw err.loop(
      `Delegation depth ${depth} exceeds the cap of ${config.limits.maxDepth}.`,
      "A human must take over this chain. Surface it to your owner instead of " +
        "delegating further.",
    );
  }
  return depth;
}

export function assertNoCycle(ctx: DepthContext): void {
  const dup = ctx.ancestorTriples.some(
    (t) =>
      t.from_user === ctx.fromUser &&
      t.to_user === ctx.toUser &&
      (t.capability_id ?? null) === (ctx.capabilityId ?? null),
  );
  if (dup) {
    throw err.loop(
      `Cycle detected: this (${ctx.fromUser} -> ${ctx.toUser}) request already ` +
        "appears in its own ancestor chain.",
      "Do not resubmit. Surface the loop to your owner.",
    );
  }
}

/** Rate ceiling for a tier (§10.4). */
export function rateCeiling(tier: Tier): number {
  return tier === "t1" ? config.limits.rateT1PerHour : config.limits.rateT2PerHour;
}

/** Truncate a Date to the start of its hour bucket (rate_limit.window_start). */
export function hourBucket(nowMs: number): Date {
  return new Date(Math.floor(nowMs / 3_600_000) * 3_600_000);
}

/** Lifecycle expiry per tier (§6). */
export function expiryFor(tier: Tier, nowMs: number): Date {
  const ms =
    tier === "t1"
      ? config.lifecycle.expireT1Ms
      : tier === "t3"
        ? config.lifecycle.expireT3Ms
        : config.lifecycle.expireT2Ms;
  return new Date(nowMs + ms);
}
