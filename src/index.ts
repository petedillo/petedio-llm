import { createApp } from "./app";
import { createJwksFetcher, createVerifier } from "./auth";
import { ConfigError, loadConfig } from "./config";

try {
  const config = loadConfig();
  const verifier = createVerifier({
    teamDomain: config.teamDomain,
    aud: config.accessAud,
    fetchJwks: createJwksFetcher(config.teamDomain),
  });
  Bun.serve({ port: config.port, fetch: createApp({ verifier }) });
  console.log(`listening on :${config.port}`);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  // Exit 2 is the contract the CI smoke test checks: no config, no service.
  console.error(`config error: ${e.message}`);
  process.exit(2);
}
