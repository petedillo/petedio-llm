import { timingSafeEqual } from "node:crypto";
import type { Gateway, Tracker } from "./llm";

export interface Llm {
  gateway: Gateway;
  tracker: Tracker;
  /** Bearer for POST /v1/ask. Empty refuses every request. */
  askToken: string;
  capUsd: number;
}

const FIELDS = new Set(["caller", "provider", "system", "prompt", "requestId", "priority", "maxTokens"]);
const CALLER = /^[a-z0-9][a-z0-9-]{0,39}$/;

function bearerOk(req: Request, expected: string): boolean {
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!expected || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/** POST /v1/ask. Unknown fields are refused. The reply carries the audit record, not only the text. */
export async function handleAsk(req: Request, llm: Llm): Promise<Response> {
  if (!bearerOk(req, llm.askToken)) return Response.json({ error: "unauthorized" }, { status: 401 });
  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) return Response.json({ error: "body must be an object" }, { status: 400 });
  const unknown = Object.keys(b).filter((k) => !FIELDS.has(k));
  if (unknown.length) return Response.json({ error: `unknown field: ${unknown[0]}` }, { status: 400 });
  if (typeof b.caller !== "string" || !CALLER.test(b.caller)) return Response.json({ error: "caller must match [a-z0-9-], 1-40 chars" }, { status: 400 });
  if (b.provider !== "ollama" && b.provider !== "haiku") return Response.json({ error: "provider must be ollama or haiku" }, { status: 400 });
  if (typeof b.prompt !== "string" || !b.prompt || b.prompt.length > 20_000) return Response.json({ error: "prompt must be 1-20000 chars" }, { status: 400 });
  if (b.system !== undefined && (typeof b.system !== "string" || b.system.length > 8_000)) return Response.json({ error: "system must be a string under 8000 chars" }, { status: 400 });
  if (b.requestId !== undefined && (typeof b.requestId !== "string" || b.requestId.length > 100)) return Response.json({ error: "requestId must be a string under 100 chars" }, { status: 400 });
  const num = (v: unknown, lo: number, hi: number) => v === undefined || (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi);
  if (!num(b.priority, 0, 9)) return Response.json({ error: "priority must be 0-9" }, { status: 400 });
  if (!num(b.maxTokens, 1, 2048)) return Response.json({ error: "maxTokens must be 1-2048" }, { status: 400 });
  const r = await llm.gateway.ask({
    caller: b.caller,
    provider: b.provider,
    prompt: b.prompt,
    system: b.system as string | undefined,
    requestId: b.requestId as string | undefined,
    priority: b.priority as number | undefined,
    maxTokens: b.maxTokens as number | undefined,
  });
  return Response.json({ ok: r.ok, text: r.text, record: r.record }, { status: r.ok ? 200 : r.record.result === "budget_blocked" ? 429 : 502 });
}
