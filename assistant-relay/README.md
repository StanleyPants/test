# assistant-relay-mcp-server

Remote MCP server for **gated assistant-to-assistant delegation**, per the
Assistant Relay build spec. This repo implements **Phase 1** (§13): T2
delegation, everything human-gated. No T1 autonomy, no T3 negotiation — those
tools exist but refuse with actionable errors that name the correct path, so
the phasing in the spec is enforced in code rather than by convention.

## What Phase 1 does

- A requester's assistant calls `relay_delegate` **as the requester** — the relay
  never executes with anyone else's permissions (**R1**).
- The recipient approves **intake** (gate 1) before their assistant does any work,
  and **release** (gate 2) before anything goes back. Gate 2 requires the drafted
  answer *and its source documents* (**§7** — the security gate).
- Requester text is stored and surfaced as **untrusted data inside a fixed frame**
  (**R7**); it is never rendered as instructions to the recipient assistant.
- Documents travel **by reference, never by value** (**R6**).
- Depth/loop caps (**§10.3**), per-pair hourly rate limits (**§10.4**), and an
  append-only **audit log** on every transition (**§6**).

## Layout

```
db/migrations/001_init.sql   Schema: agent_card, request, audit_event,
                             negotiation_round, rate_limit (§5)
scripts/migrate.ts           Forward-only migration runner
src/config.ts                Env config, defaults from §6/§10
src/errors.ts                Actionable RelayError (§15)
src/domain/types.ts          Zod domain vocabulary (mirrors SQL checks)
src/domain/stateMachine.ts   Lifecycle transitions (§6)
src/domain/framing.ts        R7 untrusted-input framing
src/domain/policy.ts         Tier routing, depth/loop, rate ceilings, expiry
src/db/store.ts              Postgres store; transitions + audit are atomic
src/resolvers/index.ts       Closed resolver registry (T1 — declared, not live)
src/notify/index.ts          Push notifier (stdout stub; Slack behind §14.1)
src/tools/register.ts        All relay_* tools (Zod in/out, honest annotations)
src/auth.ts                  OAuth 2.1 / JWKS identity (§4)
src/server.ts                Per-request McpServer with caller baked in
src/index.ts                 Streamable HTTP, stateless JSON (§4)
```

## Tools (§15)

| Tool | Tier | Read-only | Phase 1 |
|------|------|-----------|---------|
| `relay_list_directory` | — | yes | live |
| `relay_delegate` | T2 | no | live |
| `relay_list_inbox` | — | yes | live |
| `relay_read_request` | — | yes | live |
| `relay_respond` | T2 | no | live |
| `relay_decline` | T2 | no | live |
| `relay_get_status` | — | yes | live |
| `relay_query_capability` | T1 | yes | **disabled** → use `relay_delegate` |
| `relay_propose_reschedule` | T3 | no | **disabled** → use calendar T0 / `relay_delegate` |
| `relay_evaluate_proposal` | T3 | no | **disabled** |

### The T2 flow

```
requester                          recipient
  relay_delegate  ───────────────▶  (notified: intake)
                                    relay_respond action=approve_intake   (gate 1)
                                    …assistant does the work as recipient…
                                    relay_respond action=submit_draft
                                              + response_body + response_sources
                                    (notified: release)
                                    relay_respond action=release           (gate 2)
  relay_get_status ◀── released ──  answer returned
```

At any pending gate the recipient may `relay_decline`. Decline reasons are kept
in the audit log and **not** sent verbatim to the requester (§7.1).

## Run it

```bash
cp .env.example .env          # set DATABASE_URL, OAuth, etc.
npm install
npm run migrate               # apply db/migrations
npm run dev                   # or: npm run build && npm start
```

### Local development auth

Set `DEV_TRUST_HEADER=true` and pass `X-Relay-User: <user_id>` on each request
to act as that user without an IdP. **Never enable this in production** — prod
verifies a Bearer JWT against `OAUTH_JWKS_URI` (issuer + audience checked, §4).

### Inspect before wiring in (§15)

```bash
npx @modelcontextprotocol/inspector
# connect to http://localhost:8787/mcp (Streamable HTTP), add an
# Authorization: Bearer <token> or X-Relay-User header
```

## Deliberately not built in Phase 1

Per §13, resist building Phases 2–3 speculatively — the Phase 1 audit log is the
evidence that tells us their shape:

- **T1 resolvers** (`src/resolvers`) are a closed, declared set but ship no live
  query. They are promoted from observed T2 approval patterns in Phase 2 (§3.1).
- **T3 negotiation** (rounds, standing commit rules, propose-new-time) is Phase 3.
- **Slack push** falls back to stdout until open decision §14.1 (reach + inline
  actions) is confirmed.
- **Weekly digest, anomaly detection, audit export** (§11) arrive with Phase 2.

## Open decisions carried from the spec (§14)

Notification surface, directory feed (IdP+HR vs self-service), retention,
`accepting_requests` opt-out policy, cross-boundary org scoping, and cost
attribution are unresolved and gate a real deployment.
