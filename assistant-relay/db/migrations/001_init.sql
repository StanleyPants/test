-- Assistant Relay — initial schema (spec §5)
-- The relay owns this store; it is the cross-person audit record the
-- assistant platform does not have (spec §1.2).

BEGIN;

-- ---------------------------------------------------------------------------
-- Directory: what each assistant advertises it can answer autonomously.
-- Modeled on A2A agent cards. One row per person (spec §5, §5.1).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_card (
  user_id            text PRIMARY KEY,               -- IdP subject
  display_name       text NOT NULL,
  role               text,
  org_path           text,                           -- for routing/scoping
  capabilities       jsonb NOT NULL DEFAULT '[]',     -- see §5.1
  accepting_requests boolean NOT NULL DEFAULT true,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_card_org_path_idx ON agent_card (org_path);

-- ---------------------------------------------------------------------------
-- Core request record. Covers T1, T2, T3 (spec §5).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier               text NOT NULL CHECK (tier IN ('t1','t2','t3')),
  from_user          text NOT NULL,
  to_user            text NOT NULL,
  origin             text NOT NULL CHECK (origin IN ('human','assistant')),
  parent_request_id  uuid REFERENCES request(id),     -- for depth capping
  depth              int  NOT NULL DEFAULT 0,
  capability_id      text,                            -- T1 only
  subject            text NOT NULL,
  body               text NOT NULL,                   -- requester's text, treated as DATA (R7)
  artifact_refs      jsonb NOT NULL DEFAULT '[]',      -- see §5.2 (by reference, R6)
  state              text NOT NULL CHECK (state IN (
                       'submitted','input_required','working','completed',
                       'declined','auto_resolved','expired','cancelled')),
  intake_decision    jsonb,                           -- {by, at, decision, note}
  release_decision   jsonb,
  response_body      text,
  response_refs      jsonb NOT NULL DEFAULT '[]',
  response_sources   jsonb NOT NULL DEFAULT '[]',      -- doc refs behind the answer, for gate 2
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS request_to_user_state_idx  ON request (to_user, state);
CREATE INDEX IF NOT EXISTS request_from_user_idx      ON request (from_user);
CREATE INDEX IF NOT EXISTS request_parent_idx         ON request (parent_request_id);
CREATE INDEX IF NOT EXISTS request_expires_idx        ON request (expires_at)
  WHERE state IN ('submitted','input_required','working');

-- ---------------------------------------------------------------------------
-- Append-only audit log. Every state transition writes one (spec §6, §11).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_event (
  id           bigserial PRIMARY KEY,
  request_id   uuid NOT NULL REFERENCES request(id),
  actor        text NOT NULL,                          -- user_id or 'system'
  actor_kind   text NOT NULL CHECK (actor_kind IN ('human','assistant','system')),
  event        text NOT NULL,                          -- state transition or action
  detail       jsonb,
  at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_event_request_idx ON audit_event (request_id, at);

-- ---------------------------------------------------------------------------
-- T3 only (spec §5, §9). Scaffolded now; unused until Phase 3.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS negotiation_round (
  id            bigserial PRIMARY KEY,
  request_id    uuid NOT NULL REFERENCES request(id),
  round_no      int  NOT NULL,
  proposer      text NOT NULL,
  proposal      jsonb NOT NULL,
  evaluation    jsonb,                                 -- accept | counter | reject + coarse reason
  at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS negotiation_round_uniq
  ON negotiation_round (request_id, round_no);

-- ---------------------------------------------------------------------------
-- Enforced ceilings (spec §5, §10.4).
-- window_start is the truncated hour bucket.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limit (
  from_user    text NOT NULL,
  to_user      text NOT NULL,
  window_start timestamptz NOT NULL,
  count        int NOT NULL DEFAULT 0,
  PRIMARY KEY (from_user, to_user, window_start)
);

COMMIT;
