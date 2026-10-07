# AI Notes

Saving a note generates up to 5 tags. From 500 characters it also writes a short summary, in the same call. Either result can be regenerated alone.

React + Vite, Express 5, Postgres (Drizzle), OpenAI Responses API with structured outputs.

## Setup

Node 22, Docker.

```sh
cp .env.example .env          # OPENAI_API_KEY, or AI_PROVIDER=fake
docker compose up -d --wait db
npm install
npm run dev:server            # :3000
npm run dev:web               # http://localhost:5173
```

`AI_PROVIDER=fake` needs no key (`[fake AI]`). `docker compose up --build` serves UI and API on :3000. Sample notes only fill the empty form.

`npm run typecheck` · `npm test` (needs `db`) · `npm run build`. Deploys: [cluster, no login](deploy/README.md), [Azure VM, shared password](deploy/vm/README.md).

## Duplicate calls

Cached on the row. The race is the first request: save starts the call, then the page asks again (double-click, second tab, second replica, or a retry).

- **Create.** `Idempotency-Key` + `INSERT … ON CONFLICT DO NOTHING`: one note, one set of calls, across processes. Test: 10 concurrent creates, two instances (`notes.test.ts`).
- **One process.** Single-flight map in `notes/enrichment.ts`: those requests share the call, including the one save started. A late stream is caught up. Test: 10 concurrent, the streaming twin, and 5+5 joining that call (`ai-actions.test.ts`).
- **Two processes.** `UPDATE … WHERE summary IS NULL`: first write wins. Test: two instances converge (`ai-actions.test.ts`).

Each guard was removed once; the test failed. Without the map: `expected 10 to be 1`. Two replicas may each call once; the row still converges. A lease or queue would only save that extra call. A lock held for the 2–6 s call was rejected: ten of them would pin every connection in a pool of 10.

## API

[OpenAPI reference](http://localhost:5173/#/api) while `npm run dev:web` is running. Docker serves the same page at [http://localhost:3000/#/api](http://localhost:3000/#/api). The document is `GET /api/openapi.json`. 

## Decisions

- A note gets both results in one call. `tags` is listed first, so it streams first. A rejected summary still keeps the tags. Regenerate is a separate call.
- `notes/enrichment.ts` checks every provider. Tags: lowercased, `#` stripped, deduped, up to 5 kept. The `CHECK`s repeat the count and each tag's length, in code points.
- Prompts (`ai/prompts.ts`): recall at a glance; tags for decisions, dates, names, open items, in the note's language. Text sits in `<note>`; a closing tag inside it is escaped.
- `table.ts` is the schema. `npm run db:generate -w server` writes the migration; CI fails on drift. Boot migrates under an advisory lock.
- Hash routes for the list, a new note, a note, and the API reference. The API response is the state.
- Tests: real Postgres, real HTTP, scripted model, including streams and error mappings. One live `gpt-6-luna` run (separate calls): 5.7 s summary, 2.3 s tags, 0.2 s cached. German stayed German. "Ignore all previous instructions…" was summarized normally. The combined call has only been replayed.

## Trade-offs

No accounts. Calls run in-process: SIGTERM can still store them, a crash retries on next open. The list is unpaginated, fine for a few thousand notes. A 3–8B model keeps text in-cluster but needs a GPU and misses the format rules more often. One `AiProvider` to switch. A browser model may do for ordinary English.

## Production

One non-root image (API + UI) on GKE or AKS. A missing key fails before the database opens. `/api/health` checks Postgres. Mutations must come from the same origin. Drain budget is 75 s; pod and load-balancer timeouts sit above it, enforced by a test. CI (typecheck, migration drift, tests, build, Docker) has not run on GitHub yet.

Next: session + `owner_id`; request ids and latency/error/cache metrics; a content hash in the conditional write before editing; pg-boss if calls get slower.
