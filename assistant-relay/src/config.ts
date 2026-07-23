/** Environment configuration with defaults matching spec §6 / §10. */

function num(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${raw}`);
  return n;
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  return raw === "true" || raw === "1";
}

export const config = {
  port: num("PORT", 8787),
  databaseUrl: process.env.DATABASE_URL ?? "",

  oauth: {
    issuer: process.env.OAUTH_ISSUER ?? "",
    audience: process.env.OAUTH_AUDIENCE ?? "",
    jwksUri: process.env.OAUTH_JWKS_URI ?? "",
    devTrustHeader: bool("DEV_TRUST_HEADER", false),
  },

  notify: {
    slackBotToken: process.env.SLACK_BOT_TOKEN ?? "",
    emailFrom: process.env.NOTIFY_EMAIL_FROM ?? "",
  },

  lifecycle: {
    // Defaults from spec §6. T1/T3 included for when later phases enable them.
    expireT2Ms: num("EXPIRE_T2_HOURS", 72) * 60 * 60 * 1000,
    expireT1Ms: 60 * 1000, // 60s
    expireT3Ms: 15 * 60 * 1000, // 15m
  },

  limits: {
    rateT2PerHour: num("RATE_LIMIT_T2_PER_HOUR", 5),
    rateT1PerHour: num("RATE_LIMIT_T1_PER_HOUR", 60),
    maxDepth: num("MAX_DEPTH", 2),
  },
} as const;

export type Config = typeof config;
