// Cloudflare Access JWT verification with WebCrypto, copied from petedio-usaa. The header
// Cf-Access-Jwt-Assertion is the only trusted identity source; plain identity headers are never read.
// It checks signature, algorithm, expiry, not-before, issuer and audience.

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

export interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}
export type JwksFetcher = () => Promise<{ keys: Jwk[] }>;

export interface VerifierOptions {
  teamDomain: string;
  /** Required Access application audience tag; every token must carry it. */
  aud: string;
  fetchJwks: JwksFetcher;
  now?: () => number; // epoch milliseconds
  skewSeconds?: number;
  cacheTtlMs?: number;
  /** Minimum gap between refetches triggered by an unknown kid. */
  refetchCooldownMs?: number;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(part: string): Record<string, unknown> {
  const v: unknown = JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object");
  return v as Record<string, unknown>;
}

export function createJwksFetcher(teamDomain: string): JwksFetcher {
  return async () => {
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`JWKS fetch returned ${res.status}`);
    return (await res.json()) as { keys: Jwk[] };
  };
}

export function createVerifier(opts: VerifierOptions) {
  if (typeof opts.aud !== "string" || opts.aud === "") throw new Error("createVerifier requires a non-empty aud");
  const now = opts.now ?? (() => Date.now());
  const skew = opts.skewSeconds ?? 60;
  const ttl = opts.cacheTtlMs ?? 60 * 60 * 1000;
  const cooldown = opts.refetchCooldownMs ?? 30_000;
  const issuer = `https://${opts.teamDomain}`;

  let keys = new Map<string, CryptoKey>();
  let fetchedAt = -Infinity;

  async function refresh(): Promise<void> {
    const jwks = await opts.fetchJwks();
    const next = new Map<string, CryptoKey>();
    for (const jwk of jwks.keys ?? []) {
      if (jwk.kty !== "RSA" || !jwk.kid || !jwk.n || !jwk.e) continue;
      try {
        const key = await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        next.set(jwk.kid, key);
      } catch {
        // skip a key that does not import
      }
    }
    keys = next;
    fetchedAt = now();
  }

  async function keyFor(kid: string): Promise<CryptoKey | undefined> {
    if (now() - fetchedAt > ttl) await refresh();
    let key = keys.get(kid);
    if (!key && now() - fetchedAt >= cooldown) {
      await refresh(); // refetch once on an unknown kid
      key = keys.get(kid);
    }
    return key;
  }

  /** Verify the token and return its claims, or throw AuthError(401). */
  async function verify(token: string | null): Promise<Record<string, unknown>> {
    if (!token) throw new AuthError("missing token", 401);
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((p) => p === "")) throw new AuthError("malformed token", 401);
    const [h, p, s] = parts as [string, string, string];

    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = decodeJson(h);
      claims = decodeJson(p);
    } catch {
      throw new AuthError("malformed token", 401);
    }
    if (header.alg !== "RS256") throw new AuthError("unsupported algorithm", 401);
    if (typeof header.kid !== "string" || header.kid === "") throw new AuthError("missing kid", 401);

    let key: CryptoKey | undefined;
    try {
      key = await keyFor(header.kid);
    } catch {
      throw new AuthError("keys unavailable", 401);
    }
    if (!key) throw new AuthError("unknown kid", 401);

    let ok = false;
    try {
      ok = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        b64urlToBytes(s),
        new TextEncoder().encode(`${h}.${p}`),
      );
    } catch {
      ok = false;
    }
    if (!ok) throw new AuthError("bad signature", 401);

    const nowSec = Math.floor(now() / 1000);
    if (typeof claims.exp !== "number" || nowSec > claims.exp + skew) throw new AuthError("token expired", 401);
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || nowSec < claims.nbf - skew)) {
      throw new AuthError("token not yet valid", 401);
    }
    if (claims.iss !== issuer) throw new AuthError("wrong issuer", 401);
    const aud = claims.aud;
    const list = Array.isArray(aud) ? aud : [aud];
    if (!list.includes(opts.aud)) throw new AuthError("wrong audience", 401);
    return claims;
  }

  return { verify };
}

export type Verifier = ReturnType<typeof createVerifier>;
