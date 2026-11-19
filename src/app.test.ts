import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { Gateway, Tracker } from "./llm";
import { createVerifier } from "./auth";
import { ConfigError, loadConfig } from "./config";

const TEAM = "team.example.test";
const AUD = "aud-123";

// A generated key signs the test tokens; the verifier gets its public half.
const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
const b64 = (b: ArrayBuffer | string) =>
  Buffer.from(typeof b === "string" ? b : new Uint8Array(b)).toString("base64url");

async function token(claims: Record<string, unknown> = {}) {
  const head = b64(JSON.stringify({ alg: "RS256", kid: "k1" }));
  const body = b64(
    JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 600, email: "me@example.test", ...claims }),
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(sig)}`;
}

const verifier = createVerifier({ teamDomain: TEAM, aud: AUD, fetchJwks: async () => ({ keys: [{ ...jwk, kid: "k1" }] }) });
const call = (app: ReturnType<typeof createApp>, path: string, jwt?: string) =>
  app(new Request(`http://x${path}`, { headers: jwt ? { "cf-access-jwt-assertion": jwt } : {} }));

describe("config fails closed", () => {
  const good = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
  test("a complete environment loads", () => expect(loadConfig(good).port).toBe(3000));
  test("a missing or blank audience throws", () => {
    expect(() => loadConfig({ ACCESS_TEAM_DOMAIN: TEAM })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good, ACCESS_AUD: "  " })).toThrow(ConfigError);
  });
  test("a team domain with a scheme throws", () => {
    expect(() => loadConfig({ ...good, ACCESS_TEAM_DOMAIN: `https://${TEAM}` })).toThrow(ConfigError);
  });
  test("a bad PORT throws instead of defaulting", () => {
    expect(() => loadConfig({ ...good, PORT: "abc" })).toThrow(ConfigError);
  });
});

describe("/health", () => {
  test("reports one flag per dependency", async () => {
    const res = await call(createApp({ verifier, checks: { db: async () => true } }), "/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: true });
  });
  test("a down dependency is a 503 with its flag false", async () => {
    const res = await call(createApp({ verifier, checks: { db: async () => false } }), "/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: false });
  });
  test("/api/health is the same route", async () => {
    expect((await call(createApp({ verifier, checks: { db: async () => false } }), "/api/health")).status).toBe(503);
  });
  test("a check that never answers is down, not a hang", async () => {
    const hang = () => new Promise<boolean>(() => {});
    expect((await call(createApp({ verifier, checks: { db: hang } }), "/health")).status).toBe(503);
  }, 6000);
  test("a check that throws synchronously is down", async () => {
    const res = await call(createApp({ verifier, checks: { db: () => { throw new Error("unavailable"); } } }), "/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: false });
  });
  test("a check that throws is down, never up", async () => {
    const boom = async () => { throw new Error("refused"); };
    expect((await call(createApp({ verifier, checks: { db: boom } }), "/health")).status).toBe(503);
  });
});

describe("Cloudflare Access JWT", () => {
  const app = createApp({ verifier });
  test("no token is 401", async () => expect((await call(app, "/api/me")).status).toBe(401));
  test("the wrong audience is 401", async () => {
    expect((await call(app, "/api/me", await token({ aud: ["other"] }))).status).toBe(401);
  });
  test("the wrong issuer is 401", async () => {
    expect((await call(app, "/api/me", await token({ iss: "https://evil.example.test" }))).status).toBe(401);
  });
  test("an expired token is 401", async () => {
    expect((await call(app, "/api/me", await token({ exp: 1 }))).status).toBe(401);
  });
  test("a token signed by another key is 401", async () => {
    const other = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const [h, p] = (await token()).split(".");
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", other.privateKey, new TextEncoder().encode(`${h}.${p}`));
    expect((await call(app, "/api/me", `${h}.${p}.${b64(sig)}`)).status).toBe(401);
  });
  test("a payload edited after signing is 401", async () => {
    const [h, , s] = (await token()).split(".");
    const forged = b64(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 600, email: "evil@example.test" }));
    expect((await call(app, "/api/me", `${h}.${forged}.${s}`)).status).toBe(401);
  });
  test("an unknown kid is 401", async () => {
    const [, p, s] = (await token()).split(".");
    expect((await call(app, "/api/me", `${b64(JSON.stringify({ alg: "RS256", kid: "nope" }))}.${p}.${s}`)).status).toBe(401);
  });
  test("alg none and HS256 are 401", async () => {
    const [, p] = (await token()).split(".");
    for (const alg of ["none", "HS256"]) {
      expect((await call(app, "/api/me", `${b64(JSON.stringify({ alg, kid: "k1" }))}.${p}.${b64("x")}`)).status).toBe(401);
    }
  });
  test("a plain identity header is not trusted", async () => {
    const res = await app(new Request("http://x/api/me", { headers: { "cf-access-authenticated-user-email": "me@example.test" } }));
    expect(res.status).toBe(401);
  });
  test("a valid token reaches the route", async () => {
    const res = await call(app, "/api/me", await token());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "me@example.test" });
  });
  test("an unknown path is 404 once authenticated", async () => {
    expect((await call(app, "/nope", await token())).status).toBe(404);
  });
});

describe("llm routes", () => {
  const mk = () => {
    const tracker = new Tracker({ line: () => {} });
    const gateway = new Gateway({
      tracker,
      haikuMonthlyCapUsd: 100,
      providers: { ollama: { model: "m", concurrency: 1, usdPerMTokIn: 0, usdPerMTokOut: 0, timeoutMs: 500, call: async () => ({ text: "hi", tokensIn: 3, tokensOut: 2 }) } },
    });
    return createApp({ verifier, llm: { gateway, tracker, askToken: "tok", capUsd: 100 } });
  };
  const ask = (app: ReturnType<typeof createApp>, body: unknown, auth = "Bearer tok") =>
    app(new Request("http://x/v1/ask", { method: "POST", headers: { authorization: auth }, body: JSON.stringify(body) }));

  test("ask refuses a wrong or missing bearer", async () => {
    expect((await ask(mk(), { caller: "t", provider: "ollama", prompt: "p" }, "Bearer no")).status).toBe(401);
  });
  test("ask refuses unknown fields and bad providers", async () => {
    expect((await ask(mk(), { caller: "t", provider: "ollama", prompt: "p", extra: 1 })).status).toBe(400);
    expect((await ask(mk(), { caller: "t", provider: "gpt", prompt: "p" })).status).toBe(400);
  });
  test("ask runs, audits, and the audit routes need an Access token", async () => {
    const app = mk();
    const r = await ask(app, { caller: "t", provider: "ollama", prompt: "p" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { text: string }).text).toBe("hi");
    expect((await call(app, "/api/llm/calls")).status).toBe(401);
    const c = await call(app, "/api/llm/calls", await token());
    expect(((await c.json()) as { examined: number }).examined).toBe(1);
    const u = await call(app, "/api/llm/usage", await token());
    expect(u.status).toBe(200);
  });
});
