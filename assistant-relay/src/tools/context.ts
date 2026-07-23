import type { Store, Actor } from "../db/store.js";
import type { Notifier } from "../notify/index.js";

/** Everything a tool handler needs, with the authenticated caller baked in. */
export interface ToolContext {
  /** The authenticated end user making this call (spec §4: always attributable). */
  caller: Actor;
  store: Store;
  notifier: Notifier;
  now: () => number;
}
