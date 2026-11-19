import { createApp } from "./app";
import { createJwksFetcher, createVerifier } from "./auth";
import { ConfigError, loadConfig } from "./config";
import { getLlm } from "./llm/runtime";

try {
  const config = loadConfig();
  const verifier = createVerifier({
    teamDomain: config.teamDomain,
    aud: config.accessAud,
    fetchJwks: createJwksFetcher(config.teamDomain),
  });
  const { gateway, tracker } = getLlm();
  const llm = {
    gateway,
    tracker,
    askToken: process.env.LLM_ASK_TOKEN ?? "",
    capUsd: Number(process.env.LLM_HAIKU_MONTHLY_CAP_USD || 100),
  };
  if (!llm.askToken) console.warn("LLM_ASK_TOKEN is not set: POST /v1/ask refuses every request");
  const ollamaUrl = (process.env.LLM_OLLAMA_URL || "http://192.168.50.246:11434").replace(/\/$/, "");
  const checks = {
    ollama: async () => (await fetch(`${ollamaUrl}/api/version`, { signal: AbortSignal.timeout(2500) })).ok,
  };
  Bun.serve({ port: config.port, fetch: createApp({ verifier, llm, checks }) });
  console.log(`listening on :${config.port}`);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  // Exit 2 is the contract the CI smoke test checks: no config, no service.
  console.error(`config error: ${e.message}`);
  process.exit(2);
}
