/** Shared domain vocabulary. Mirrors the SQL CHECK constraints in 001_init.sql. */
import { z } from "zod";

export const Tier = z.enum(["t1", "t2", "t3"]);
export type Tier = z.infer<typeof Tier>;

export const Origin = z.enum(["human", "assistant"]);
export type Origin = z.infer<typeof Origin>;

export const ActorKind = z.enum(["human", "assistant", "system"]);
export type ActorKind = z.infer<typeof ActorKind>;

/** Request lifecycle states (spec §6). */
export const RequestState = z.enum([
  "submitted",
  "input_required",
  "working",
  "completed",
  "declined",
  "auto_resolved",
  "expired",
  "cancelled",
]);
export type RequestState = z.infer<typeof RequestState>;

/** Artifact reference — by reference, never by value (R6, §5.2). */
export const ArtifactRef = z.object({
  system: z.string(), // system of record, e.g. "gdrive"
  id: z.string(), // native id
  title: z.string(),
  url: z.string(),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

/** Response source — a doc ref behind the drafted answer, surfaced at gate 2 (§7). */
export const ResponseSource = ArtifactRef;
export type ResponseSource = z.infer<typeof ResponseSource>;

/** Gate decision record stored on the request (§5). */
export const GateDecision = z.object({
  by: z.string(),
  at: z.string(), // ISO timestamp
  decision: z.enum(["approve", "decline", "defer"]),
  note: z.string().optional(),
});
export type GateDecision = z.infer<typeof GateDecision>;

/** Capability audience scope (§5.1). */
export const Audience = z
  .string()
  .refine(
    (a) => a === "org" || a.startsWith("group:") || a.startsWith("user:"),
    "audience must be 'org', 'group:<id>', or 'user:<id>'",
  );

/** Capability declaration (§5.1). */
export const Capability = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  resolver: z.string(), // named deterministic resolver, NOT the assistant
  response_shape: z.record(z.string()),
  audience: Audience,
  declared_by: z.string(),
  declared_at: z.string(),
});
export type Capability = z.infer<typeof Capability>;

export interface AgentCard {
  user_id: string;
  display_name: string;
  role: string | null;
  org_path: string | null;
  capabilities: Capability[];
  accepting_requests: boolean;
  updated_at: string;
}

export interface RequestRecord {
  id: string;
  tier: Tier;
  from_user: string;
  to_user: string;
  origin: Origin;
  parent_request_id: string | null;
  depth: number;
  capability_id: string | null;
  subject: string;
  body: string;
  artifact_refs: ArtifactRef[];
  state: RequestState;
  intake_decision: GateDecision | null;
  release_decision: GateDecision | null;
  response_body: string | null;
  response_refs: ArtifactRef[];
  response_sources: ResponseSource[];
  created_at: string;
  updated_at: string;
  expires_at: string;
}
