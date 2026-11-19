// Configuration, all from the environment. Every setting that guards access is required:
// an unset or blank value throws a ConfigError at startup, and the app refuses to serve.
// A blank audience once skipped the check in petedio-usaa, so there is no optional guard here.
export interface Config {
  port: number;
  /** Cloudflare Access team domain, for example `team.cloudflareaccess.com`. */
  teamDomain: string;
  /** The Access application's audience tag. Every token must carry it. */
  accessAud: string;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

function required(env: Env, key: string): string {
  const v = env[key]?.trim();
  if (!v) throw new ConfigError(`${key} is not set`);
  return v;
}

export function loadConfig(env: Env = process.env): Config {
  const teamDomain = required(env, "ACCESS_TEAM_DOMAIN");
  if (!HOSTNAME.test(teamDomain)) throw new ConfigError("ACCESS_TEAM_DOMAIN must be a hostname, with no scheme or path");
  const accessAud = required(env, "ACCESS_AUD");
  const raw = env.PORT?.trim() || "3000";
  const port = Number(raw);
  // Fail closed: a bad PORT must not fall back to a default.
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) throw new ConfigError(`PORT must be 1-65535, got "${raw}"`);
  return { port, teamDomain, accessAud };
}
