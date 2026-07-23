/** Reusable Zod shapes for tool input/output (spec §15: Zod + outputSchema). */
import { z } from "zod";
import { ArtifactRef, GateDecision, RequestState, Tier, Origin } from "../domain/types.js";

/** Pagination inputs/outputs — every list tool paginates (§15). */
export const paginationInput = {
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
};

export const paginationOutput = {
  total_count: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().nullable(),
};

/** Public view of a request (framing applied to body by the read tool). */
export const requestView = z.object({
  id: z.string(),
  tier: Tier,
  from_user: z.string(),
  to_user: z.string(),
  origin: Origin,
  depth: z.number().int(),
  subject: z.string(),
  state: RequestState,
  created_at: z.string(),
  expires_at: z.string(),
});

export const artifactRefsInput = z
  .array(ArtifactRef)
  .max(20)
  .default([]);

export const responseSourcesInput = z.array(ArtifactRef).max(50);

export { ArtifactRef, GateDecision };
