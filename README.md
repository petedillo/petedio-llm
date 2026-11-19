# petedio-llm

A Bun and TypeScript service skeleton with CI, built to sit behind Cloudflare Access. It has:

- **Fail-closed config** (`src/config.ts`). A blank `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD`, or a bad `PORT`, stops startup with exit code 2.
- **Access JWT verification** (`src/auth.ts`, copied from petedio-usaa). It checks signature, algorithm, expiry, issuer and audience. It never reads a plain identity header.
- **A `/health` route** with one flag per dependency, and a 503 when any is down. Pass `checks` to `createApp`.
- **Tests** for each guard, ESLint, `tsc --noEmit`, and a `ci` workflow that lints, type checks, tests, compiles and
  smoke-tests that the binary refuses to start without its config.

## Use the template

1. On GitHub, choose **Use this template** on `petedio-llm` and create the new repo. The source of truth for
   this template is `templates/api/` in `petedio-workspace`. Change it there first, then sync this repo.
2. Replace `petedio-llm` in `package.json`, `.github/workflows/ci.yml` (the build and smoke-test steps) and `build:binary`.
3. Requires Bun 1.4.4 or later. Run `bun install` and commit `bun.lock`. CI installs with `--frozen-lockfile` and
   fails without it.
4. Run `bun run lint && bun run typecheck && bun test`.
5. Protect `main` and require the `check` job.

The frontend pair is `petedio-spa-template`. Its `/api/health` call matches this template's `/health` and `/api/health` routes.

Deploy is not part of the template. Add it when the app has a host, modeled on pete-bot's
`deploy.yml`.

## The model gateway (`src/llm/`)

Every model request goes through `Gateway.ask`. It queues per provider (lower `priority` runs first), refuses a Haiku call once recorded spend reaches `LLM_HAIKU_MONTHLY_CAP_USD` (default 100), applies a deadline, and writes one audit record whatever the result, refusals included. A record holds the id, caller, model, prompt and response hashes, tokens, cost, queue and run time, and result. It never holds text. The id hashes the caller and `requestId`, so a replay carries the same id. Records go to a ring buffer, to stdout as an `llm_call` JSON line, and to Loki when `LLM_LOKI_URL` is set.

| Route | Auth | Use |
|---|---|---|
| `POST /v1/ask` | bearer `LLM_ASK_TOKEN` (empty refuses all) | A service asks a model. Unknown fields are refused. 429 when the Haiku cap is reached. |
| `GET /api/llm/calls?limit=` | Access JWT | Recent audit records, with a count of records examined. |
| `GET /api/llm/usage` | Access JWT | This month's calls, tokens and cost per model, the cap and queue depth. |

| Variable | Default | Effect |
|---|---|---|
| `LLM_OLLAMA_URL`, `LLM_OLLAMA_MODEL` | `http://192.168.50.246:11434`, `qwen3:8b` | The local lane. |
| `ANTHROPIC_API_KEY` | unset | Turns on Haiku. Set from Vault at deploy time. |
| `LLM_HAIKU_MODEL`, `LLM_HAIKU_USD_PER_MTOK_IN/OUT` | `claude-haiku-5-5`, 1 and 5 | Verify prices before you trust the budget. |
| `LLM_HAIKU_MONTHLY_CAP_USD` | 100 | The guard. |

The ring buffer resets on restart, so the budget guard counts spend since the last start until it can read the month's total back from Loki.
