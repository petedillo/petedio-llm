import { AuthError, type Verifier } from "./auth";
import { handleAsk, type Llm } from "./routes";

/** One check per dependency, for example `{ db: () => repo.ping() }`. A check that throws counts as down. */
export type Checks = Record<string, () => Promise<boolean>>;

const CHECK_TIMEOUT_MS = 3000;

export interface Deps {
  verifier: Verifier;
  checks?: Checks;
  /** The model gateway. Without it the llm routes answer 404. */
  llm?: Llm;
}

// Fetch handler kept apart from Bun.serve so a test can call it without a socket.
export function createApp({ verifier, checks = {}, llm }: Deps) {
  return async function handle(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);

    // /health is open so the deploy and monitors can probe it. /api/health is the same route as the SPA
    // sees it behind a same-origin /api proxy. It reports each dependency as its own flag and answers 503
    // when any is down, so a status-only probe fails too.
    // With no `checks`, it only proves the process is up. Pass one check per dependency, for example a database ping.
    if (pathname === "/health" || pathname === "/api/health") {
      const flags: Record<string, boolean> = {};
      const entries = Object.entries(checks);
      if (entries.some(([name]) => name === "ok")) throw new Error('a health check cannot be named "ok"');
      // In parallel, each with a timeout, so one hung dependency reports down instead of hanging the route.
      await Promise.all(
        entries.map(async ([name, check]) => {
          flags[name] = await Promise.race([
            Promise.resolve().then(check).catch(() => false), // also catches a check that throws before it returns a promise
            new Promise<boolean>((r) => setTimeout(() => r(false), CHECK_TIMEOUT_MS)),
          ]);
        }),
      );
      const ok = Object.values(flags).every(Boolean);
      return Response.json({ ok, ...flags }, { status: ok ? 200 : 503 });
    }

    // Service callers (pete-bot, the explainer) cannot present an Access JWT, so /v1/ask has its own bearer.
    if (llm && pathname === "/v1/ask" && req.method === "POST") return handleAsk(req, llm);

    // Everything else needs a verified Cloudflare Access JWT.
    try {
      const claims = await verifier.verify(req.headers.get("cf-access-jwt-assertion"));
      if (pathname === "/api/me") return Response.json({ email: claims.email ?? null });
      if (llm && pathname === "/api/llm/calls") {
        const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get("limit")) || 100, 1), 500);
        const calls = llm.tracker.calls(limit);
        return Response.json({ examined: calls.length, calls });
      }
      if (llm && pathname === "/api/llm/usage") {
        return Response.json({ ...llm.tracker.usage(), capUsd: llm.capUsd, queueDepth: llm.gateway.depth() });
      }
    } catch (e) {
      if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
    return new Response("not found", { status: 404 });
  };
}
