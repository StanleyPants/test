/**
 * Actionable errors (spec §15): every error tells the assistant what to do
 * instead. Carried through MCP as an isError result whose text includes the
 * `next` hint. A T2 request against a T1 capability, for example, names the
 * correct tool.
 */
export class RelayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** What the caller should do instead. Surfaced to the assistant. */
    readonly next?: string,
  ) {
    super(message);
    this.name = "RelayError";
  }

  toToolText(): string {
    return this.next ? `${this.message}\n\nNext: ${this.next}` : this.message;
  }
}

export const err = {
  notEnabled: (feature: string, phase: string, next: string) =>
    new RelayError(
      "not_enabled",
      `${feature} is not enabled in this deployment (${phase}).`,
      next,
    ),
  notFound: (what: string, next?: string) =>
    new RelayError("not_found", `${what} not found.`, next),
  forbidden: (why: string, next?: string) =>
    new RelayError("forbidden", why, next),
  invalidState: (why: string, next?: string) =>
    new RelayError("invalid_state", why, next),
  rateLimited: (why: string, next?: string) =>
    new RelayError("rate_limited", why, next),
  loop: (why: string, next?: string) =>
    new RelayError("loop_detected", why, next),
  notAccepting: (who: string) =>
    new RelayError(
      "not_accepting",
      `${who} is not currently accepting requests.`,
      "Do not retry automatically. Surface this to your owner.",
    ),
};
