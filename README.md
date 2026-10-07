# AI Notes

Write a note and save it. The app tags it, and a note of 500+ characters also gets a short summary. You can regenerate either one on its own.

## Setup

Node 22, Docker.

```sh
cp .env.example .env          # OPENAI_API_KEY, or AI_PROVIDER=fake
docker compose up -d --wait db
npm install
npm run dev:server            # :3000
npm run dev:web               # http://localhost:5173
```

`AI_PROVIDER=fake` needs no key; its output starts with `[fake AI]`. `docker compose up --build` serves the UI and API together on :3000.

Checks: `npm run typecheck` · `npm test` (needs `db`) · `npm run test:e2e` · `npm run build`.
API reference: [localhost:5173/#/api](http://localhost:5173/#/api), from `GET /api/openapi.json`.

## Tech stack

| Choice | Why |
| --- | --- |
| React + Vite | Small UI, fast dev loop. Hash routes, so no router library and no server fallback. |
| Express 5 | Required. v5 sends errors from async handlers to the error handler without wrappers. |
| Postgres + Drizzle | The schema is plain TypeScript, and migrations are generated SQL you can read. Tags are a `text[]`: at most 5, always read with their note, so a join table adds nothing. |
| OpenAI Responses API, structured outputs | A strict JSON schema, so the reply always parses. One `AiProvider` interface, so the model can be swapped. |
| Zod | One place to validate request bodies, env vars and model output. |

## Decisions

- **One model call on save.** Tags and summary come back in a single response, so the note's input tokens are paid for once. Tags come first in the schema, so they stream first. Each result is checked and stored separately: a bad summary still keeps its tags.
- **The rules live in one place.** `notes/enrichment.ts` checks every provider's output: 1–5 tags, lowercased, `#` stripped, deduped; a summary of at most 590 characters and at least 20% shorter than the note. Output that breaks a rule is not stored, so the next request tries again. The `CHECK`s in `table.ts` repeat the limits, so no code path can store bad data.
- **No summary under 500 characters.** A summary that short is about as long as the note itself. Those notes get tags only, and the UI says why.
- **Prompts** (`ai/prompts.ts`) state the purpose: a summary to recall the note at a glance, tags to group notes. They ask for specifics (decisions, dates, names, open items), forbid outside facts, and answer in the note's language. The note sits inside `<note>` as data, and a closing tag inside it is escaped.
- **Errors.** Adapters turn SDK errors into one `AiError` type. `errors.ts` maps it to 504 (timeout), 503 (rate limited), 502 (bad output or upstream failure) or 422 (refused). Every error has the same shape: `{ error: { code, message } }`.
- **Streaming is optional per request.** Send `Accept: text/event-stream` to get the text as it arrives; any other client gets one JSON body.

## No duplicate AI calls

Results are cached on the note's row. The hard case is the first request: saving starts the call, and then the page asks for the same result (double-click, second tab, second replica, retry).

| Where | Guard | Test |
| --- | --- | --- |
| Create | `Idempotency-Key` + `INSERT … ON CONFLICT DO NOTHING`: one note, one set of calls | 10 concurrent creates on two instances (`notes.test.ts`) |
| One process | Single-flight map: all requests share the running call, including the one save started; a late stream catches up | 10 concurrent, the streaming version, 5+5 joining the save's call (`ai-actions.test.ts`) |
| Two processes | `UPDATE … WHERE summary IS NULL`: the first write wins | two instances converge (`ai-actions.test.ts`) |

I removed each guard once and its test failed (without the map: `expected 10 to be 1`). Two replicas can still each make one call, but the row ends up the same. I rejected a database lock held during the 2–6 s call: ten of them would hold every connection in the pool of 10.

## Testing

Real Postgres, real HTTP, a scripted model (no network), including streams and every error mapping. Playwright drives the built UI against the fake provider.

One live `gpt-6-luna` run (separate calls): summary 5.7 s, tags 2.3 s, cached 0.2 s. A German note stayed German. A note saying "Ignore all previous instructions…" was summarized normally. The combined save-time call has only been replayed, not run live.

## Trade-offs and assumptions

- No accounts; every visitor shares one notebook.
- AI calls run in the API process, not a queue. On SIGTERM they still finish and store their result; after a crash, opening the note retries.
- The list is unpaginated. That's fine for a few thousand notes.
- Notes can't be edited, so a stored summary never goes stale.

## Production

- One non-root image serves the API and UI. A missing API key fails at boot, before the database opens. `/api/health` checks Postgres. Migrations run at boot under an advisory lock.
- Mutations must come from the same origin. Shutdown waits up to 75 s for running AI calls; pod and load-balancer timeouts are set above that, and a test fails if one drops below.
- CI runs typecheck, migration drift, unit and e2e tests, build and the Docker image: [passing](https://github.com/vitaliiznak/ai_notes_min/actions/runs/37559208247).
- Deploys: [cluster, no login](deploy/README.md), [Azure VM, shared password](deploy/vm/README.md).
- No rate limit yet: on a public deploy, set a spend limit in the OpenAI dashboard.

## With more time

1. Request IDs, plus metrics for latency, errors and cache hits.
2. Note editing, with a content hash in the conditional write so an old result can't land on new text.
3. A job queue (pg-boss) if calls get slower.
4. Observability
