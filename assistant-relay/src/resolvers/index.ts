/**
 * Resolver registry (spec §5.1). Resolvers are a CLOSED, code-defined set. A
 * capability cannot name a resolver that does not exist, and cannot route to
 * the recipient's general assistant. This is R2 enforced structurally rather
 * than by policy.
 *
 * Phase 1 defines the registry and the shape but ships NO live resolvers:
 * every T1 capability must be derived from observed T2 traffic (§3.1) in
 * Phase 2. The named entries below document intended resolvers and fail
 * closed until then.
 */
import { err } from "../errors.js";

export interface ResolverContext {
  /** The recipient whose deterministic data source is being queried. */
  recipient: string;
  /** The requester, for audience checks by the caller. */
  requester: string;
}

/**
 * A resolver is a narrow deterministic query with a fixed output shape. It is
 * NEVER free-form retrieval and NEVER the recipient's general assistant.
 */
export type Resolver = (
  ctx: ResolverContext,
) => Promise<Record<string, unknown>>;

/**
 * The closed set of resolver *names*. Values are null in Phase 1 (declared but
 * not live). Phase 2 replaces the nulls with real deterministic queries.
 */
const REGISTRY: Record<string, Resolver | null> = {
  "calendar.ooo": null, // out-of-office status: { away, from, until }
  "calendar.freebusy_summary": null, // coarse busy/free only
  "project.status": null, // status of a project the recipient owns
  "ownership.service": null, // who owns service X in recipient's area
};

export function hasResolver(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, name);
}

/** Look up a live resolver, failing closed with an actionable error. */
export function getResolver(name: string): Resolver {
  if (!hasResolver(name)) {
    throw err.forbidden(
      `Unknown resolver '${name}'. Resolvers are a closed set.`,
      "A capability may only name a resolver defined in the registry (§5.1).",
    );
  }
  const r = REGISTRY[name];
  if (!r) {
    throw err.notEnabled(
      `Resolver '${name}'`,
      "Phase 1",
      "T1 resolvers are built in Phase 2 from observed T2 approval data (§3.1). " +
        "Submit as T2 with relay_delegate for now.",
    );
  }
  return r;
}

export const resolverNames = Object.freeze(Object.keys(REGISTRY));
