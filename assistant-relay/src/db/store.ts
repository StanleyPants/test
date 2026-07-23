/**
 * Store abstraction. All request-lifecycle reads/writes go through here so the
 * audit log (§6) and rate accounting (§10.4) cannot be bypassed. Postgres-backed.
 *
 * Every state transition is written together with its audit_event inside one
 * transaction — "Every transition writes an audit_event. No exceptions." (§6).
 */
import type { Pool, PoolClient } from "pg";
import { getPool } from "./pool.js";
import { assertTransition } from "../domain/stateMachine.js";
import { hourBucket, rateCeiling } from "../domain/policy.js";
import { err } from "../errors.js";
import type {
  AgentCard,
  ArtifactRef,
  Capability,
  GateDecision,
  Origin,
  RequestRecord,
  RequestState,
  ResponseSource,
  Tier,
  ActorKind,
} from "../domain/types.js";

export interface Actor {
  id: string;
  kind: ActorKind;
}

export interface CreateRequestInput {
  tier: Tier;
  fromUser: string;
  toUser: string;
  origin: Origin;
  parentRequestId: string | null;
  depth: number;
  capabilityId: string | null;
  subject: string;
  body: string;
  artifactRefs: ArtifactRef[];
  state: RequestState;
  expiresAt: Date;
}

export interface AuditInput {
  requestId: string;
  actor: Actor;
  event: string;
  detail?: unknown;
}

export interface Page<T> {
  items: T[];
  total_count: number;
  has_more: boolean;
  next_offset: number | null;
}

export class Store {
  constructor(private readonly pool: Pool = getPool()) {}

  // ---- Directory (agent_card) ------------------------------------------

  async getCard(userId: string): Promise<AgentCard | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_card WHERE user_id = $1`,
      [userId],
    );
    return rows[0] ? rowToCard(rows[0]) : null;
  }

  async listDirectory(opts: {
    orgPath?: string | undefined;
    limit: number;
    offset: number;
  }): Promise<Page<AgentCard>> {
    const where = opts.orgPath ? `WHERE org_path LIKE $1 || '%'` : ``;
    const params: unknown[] = opts.orgPath ? [opts.orgPath] : [];
    const countRes = await this.pool.query(
      `SELECT count(*)::int AS n FROM agent_card ${where}`,
      params,
    );
    const total = countRes.rows[0].n as number;
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_card ${where} ORDER BY display_name
       LIMIT ${opts.limit} OFFSET ${opts.offset}`,
      params,
    );
    return page(rows.map(rowToCard), total, opts.limit, opts.offset);
  }

  // ---- Requests --------------------------------------------------------

  async createRequest(
    input: CreateRequestInput,
    audit: Omit<AuditInput, "requestId">,
  ): Promise<RequestRecord> {
    return this.tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO request
           (tier, from_user, to_user, origin, parent_request_id, depth,
            capability_id, subject, body, artifact_refs, state, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          input.tier,
          input.fromUser,
          input.toUser,
          input.origin,
          input.parentRequestId,
          input.depth,
          input.capabilityId,
          input.subject,
          input.body,
          JSON.stringify(input.artifactRefs),
          input.state,
          input.expiresAt.toISOString(),
        ],
      );
      const rec = rowToRequest(rows[0]);
      await this.writeAudit(c, { ...audit, requestId: rec.id });
      return rec;
    });
  }

  async getRequest(id: string): Promise<RequestRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM request WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToRequest(rows[0]) : null;
  }

  /** Ancestor triples nearest-first, for cycle detection (§10.3). */
  async ancestorTriples(
    parentId: string | null,
  ): Promise<Array<{ from_user: string; to_user: string; capability_id: string | null }>> {
    if (!parentId) return [];
    const { rows } = await this.pool.query(
      `WITH RECURSIVE chain AS (
         SELECT id, from_user, to_user, capability_id, parent_request_id
           FROM request WHERE id = $1
         UNION ALL
         SELECT r.id, r.from_user, r.to_user, r.capability_id, r.parent_request_id
           FROM request r JOIN chain ON r.id = chain.parent_request_id
       )
       SELECT from_user, to_user, capability_id FROM chain`,
      [parentId],
    );
    return rows.map((r) => ({
      from_user: r.from_user,
      to_user: r.to_user,
      capability_id: r.capability_id ?? null,
    }));
  }

  /** Inbox for a recipient: items needing their attention, newest first. */
  async listInbox(opts: {
    toUser: string;
    states?: RequestState[];
    limit: number;
    offset: number;
  }): Promise<Page<RequestRecord>> {
    const states = opts.states ?? ["input_required"];
    const countRes = await this.pool.query(
      `SELECT count(*)::int AS n FROM request
        WHERE to_user = $1 AND state = ANY($2)`,
      [opts.toUser, states],
    );
    const total = countRes.rows[0].n as number;
    const { rows } = await this.pool.query(
      `SELECT * FROM request
        WHERE to_user = $1 AND state = ANY($2)
        ORDER BY created_at DESC
        LIMIT ${opts.limit} OFFSET ${opts.offset}`,
      [opts.toUser, states],
    );
    return page(rows.map(rowToRequest), total, opts.limit, opts.offset);
  }

  /**
   * Apply a validated state transition plus optional field updates, and write
   * the audit event, atomically. Re-reads current state under a row lock and
   * checks the transition is legal before writing.
   */
  async transition(
    id: string,
    to: RequestState,
    updates: Partial<{
      intake_decision: GateDecision;
      release_decision: GateDecision;
      response_body: string;
      response_refs: ArtifactRef[];
      response_sources: ResponseSource[];
    }>,
    audit: Omit<AuditInput, "requestId">,
  ): Promise<RequestRecord> {
    return this.tx(async (c) => {
      const cur = await c.query(
        `SELECT state FROM request WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!cur.rows[0]) throw err.notFound(`request ${id}`);
      const from = cur.rows[0].state as RequestState;
      assertTransition(from, to);

      const sets: string[] = ["state = $2", "updated_at = now()"];
      const params: unknown[] = [id, to];
      let p = 3;
      for (const [key, val] of Object.entries(updates)) {
        const isJson = key !== "response_body";
        sets.push(`${key} = $${p}`);
        params.push(isJson ? JSON.stringify(val) : val);
        p++;
      }
      const { rows } = await c.query(
        `UPDATE request SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
        params,
      );
      const rec = rowToRequest(rows[0]);
      await this.writeAudit(c, { ...audit, requestId: id, detail: { from, to } });
      return rec;
    });
  }

  // ---- Rate limiting (§10.4) -------------------------------------------

  /**
   * Atomically increment and check the per-(from,to) hourly counter. Throws
   * RelayError('rate_limited') when the tier ceiling is exceeded.
   */
  async checkAndBumpRate(
    fromUser: string,
    toUser: string,
    tier: Tier,
    nowMs: number,
  ): Promise<void> {
    const bucket = hourBucket(nowMs);
    const ceiling = rateCeiling(tier);
    const { rows } = await this.pool.query(
      `INSERT INTO rate_limit (from_user, to_user, window_start, count)
       VALUES ($1,$2,$3,1)
       ON CONFLICT (from_user, to_user, window_start)
       DO UPDATE SET count = rate_limit.count + 1
       RETURNING count`,
      [fromUser, toUser, bucket.toISOString()],
    );
    const count = rows[0].count as number;
    if (count > ceiling) {
      throw err.rateLimited(
        `Rate limit reached: ${ceiling} ${tier.toUpperCase()} requests/hour to ${toUser}.`,
        "Wait for the current hour window to reset, or surface to your owner. " +
          "Human-gated traffic is intentionally human-rate (§10.4).",
      );
    }
  }

  // ---- Audit -----------------------------------------------------------

  private async writeAudit(c: PoolClient, a: AuditInput): Promise<void> {
    await c.query(
      `INSERT INTO audit_event (request_id, actor, actor_kind, event, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        a.requestId,
        a.actor.id,
        a.actor.kind,
        a.event,
        a.detail === undefined ? null : JSON.stringify(a.detail),
      ],
    );
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
}

// ---- row mappers -------------------------------------------------------

function rowToCard(r: Record<string, unknown>): AgentCard {
  return {
    user_id: r.user_id as string,
    display_name: r.display_name as string,
    role: (r.role as string | null) ?? null,
    org_path: (r.org_path as string | null) ?? null,
    capabilities: (r.capabilities as Capability[]) ?? [],
    accepting_requests: r.accepting_requests as boolean,
    updated_at: toIso(r.updated_at),
  };
}

function rowToRequest(r: Record<string, unknown>): RequestRecord {
  return {
    id: r.id as string,
    tier: r.tier as Tier,
    from_user: r.from_user as string,
    to_user: r.to_user as string,
    origin: r.origin as Origin,
    parent_request_id: (r.parent_request_id as string | null) ?? null,
    depth: r.depth as number,
    capability_id: (r.capability_id as string | null) ?? null,
    subject: r.subject as string,
    body: r.body as string,
    artifact_refs: (r.artifact_refs as ArtifactRef[]) ?? [],
    state: r.state as RequestState,
    intake_decision: (r.intake_decision as GateDecision | null) ?? null,
    release_decision: (r.release_decision as GateDecision | null) ?? null,
    response_body: (r.response_body as string | null) ?? null,
    response_refs: (r.response_refs as ArtifactRef[]) ?? [],
    response_sources: (r.response_sources as ResponseSource[]) ?? [],
    created_at: toIso(r.created_at),
    updated_at: toIso(r.updated_at),
    expires_at: toIso(r.expires_at),
  };
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function page<T>(
  items: T[],
  total: number,
  limit: number,
  offset: number,
): Page<T> {
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < total;
  return {
    items,
    total_count: total,
    has_more: hasMore,
    next_offset: hasMore ? nextOffset : null,
  };
}
