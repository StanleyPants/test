/**
 * OAuth 2.1 identity (spec §4). Every relay call must be attributable to a
 * specific authenticated human. No service accounts, no shared credentials, no
 * token passing between users. A call that cannot be attributed is rejected.
 *
 * Prod: verify a Bearer JWT against the IdP's JWKS (issuer + audience checked).
 * Dev:  when DEV_TRUST_HEADER=true, trust X-Relay-User as the caller. Never in prod.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Request } from "express";
import { config } from "./config.js";
import type { Actor } from "./db/store.js";

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!jwks) {
    if (!config.oauth.jwksUri) {
      throw new AuthError("OAUTH_JWKS_URI not configured", 500);
    }
    jwks = createRemoteJWKSet(new URL(config.oauth.jwksUri));
  }
  return jwks;
}

/** Resolve the authenticated caller for an incoming HTTP request. */
export async function authenticate(req: Request): Promise<Actor> {
  if (config.oauth.devTrustHeader) {
    const u = req.header("X-Relay-User");
    if (!u) throw new AuthError("DEV_TRUST_HEADER on but X-Relay-User missing");
    return { id: u, kind: "human" };
  }

  const header = req.header("authorization") ?? "";
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match) throw new AuthError("missing bearer token");
  const token = match[1] as string;

  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: config.oauth.issuer || undefined,
      audience: config.oauth.audience || undefined,
    });
    const sub = payload.sub;
    if (!sub) throw new AuthError("token has no subject");
    // The relay always attributes to a human end user (R1: no service accounts).
    return { id: sub, kind: "human" };
  } catch (e) {
    if (e instanceof AuthError) throw e;
    throw new AuthError(`token verification failed: ${(e as Error).message}`);
  }
}
