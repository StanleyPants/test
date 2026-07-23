/**
 * Notification push (spec §8). On any transition into `input_required` the
 * recipient is notified out of band — Slack DM preferred, email fallback —
 * with inline approve/decline actions. This is what makes the system
 * responsive rather than dependent on the recipient opening their assistant.
 *
 * Phase 1 ships a pluggable Notifier with a stdout implementation so the
 * lifecycle is exercisable without Slack wiring. Swap in SlackNotifier once
 * open decision §14.1 (reach + inline actions) is confirmed.
 */
import { config } from "../config.js";
import type { RequestRecord } from "../domain/types.js";

export type Gate = "intake" | "release";

export interface Notifier {
  notifyInputRequired(req: RequestRecord, gate: Gate): Promise<void>;
}

export interface NotificationView {
  to: string;
  gate: Gate;
  requestId: string;
  subject: string;
  fromUser: string;
  origin: RequestRecord["origin"];
  /** Deep link the recipient's surface renders as approve/decline actions. */
  actionHint: string;
}

export function buildView(req: RequestRecord, gate: Gate): NotificationView {
  return {
    to: req.to_user,
    gate,
    requestId: req.id,
    subject: req.subject,
    fromUser: req.from_user,
    origin: req.origin,
    actionHint:
      gate === "intake"
        ? "Approve intake with relay_respond/relay_decline (gate 1)."
        : "Review the draft AND its sources, then release with relay_respond (gate 2).",
  };
}

/** Default Phase 1 notifier: structured line to stdout. */
export class LogNotifier implements Notifier {
  async notifyInputRequired(req: RequestRecord, gate: Gate): Promise<void> {
    const v = buildView(req, gate);
    console.log(`[notify] ${JSON.stringify(v)}`);
  }
}

/**
 * Placeholder for the real Slack path. Intentionally not implemented in
 * Phase 1 — wiring depends on open decision §14.1. Falls back to logging.
 */
export class SlackNotifier implements Notifier {
  constructor(private readonly fallback: Notifier = new LogNotifier()) {}
  async notifyInputRequired(req: RequestRecord, gate: Gate): Promise<void> {
    // TODO(phase1): Slack chat.postMessage with Block Kit approve/decline
    // actions once inline approval is confirmed reachable (§14.1).
    await this.fallback.notifyInputRequired(req, gate);
  }
}

export function makeNotifier(): Notifier {
  return config.notify.slackBotToken ? new SlackNotifier() : new LogNotifier();
}
