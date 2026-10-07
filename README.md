# AI Notes

Take-home: a notes app with AI. Saving a note tags it; a note of 500+ characters also gets a summary. Either one can be regenerated on its own, streamed or as plain JSON.

## Run it

Node 22, Docker.

```sh
cp .env.example .env          # paste OPENAI_API_KEY for a local OpenAI run, or set AI_PROVIDER=fake
docker compose up -d --wait db  # Postgres only
npm install
npm run dev:server            # API on :3000; it reads .env and talks to that database
npm run dev:web               # UI on http://localhost:5173
```

or

`docker compose up --build` is the other way: database, API, and UI together on :3000, and you do not run `npm run`.
Checks: `npm run typecheck` · `npm test` (needs `db`) · `npm run test:e2e` · `npm run build`.
API reference: [localhost:5173/#/api](http://localhost:5173/#/api), rendered from `GET /api/openapi.json`. That document is CORS-readable, and its `servers` entry is whichever host served it.

## No duplicate AI calls

Results are cached on the note's row. The hard case is the first request: saving starts the call, then the page asks for the same result (double-click, second tab, second replica, retry).

| Where | Guard | Test (real concurrent HTTP) |
| --- | --- | --- |
| Create | `Idempotency-Key` + `INSERT … ON CONFLICT DO NOTHING` | 10 creates on two instances → one note, one set of calls (`notes.test.ts`) |
| One process | Single-flight map: every request joins the running call, including the one save started | 10 concurrent, streamed, and 5+5 joining the save's call (`ai-actions.test.ts`) |
| Two processes | `UPDATE … WHERE summary IS NULL`: first write wins | two instances converge (`ai-actions.test.ts`) |
| Delete | `DELETE … RETURNING` | concurrent deletes on two instances count each note once (`deletion.test.ts`) |

I removed each guard once and watched its test fail (no map: `expected 10 to be 1`). Two replicas can still each make one call, but the row ends up the same. I rejected a database lock held across the 2–6 s call: ten of them would take every connection in the pool of 10.

## Design

```
React (hash routes) ─► Express routes (parse, call, respond)
                         ├─► notes/repo.ts ── Drizzle ──► Postgres (one table)
                         └─► notes/enrichment.ts (rules, single-flight) ─► AiProvider: OpenAI | fake
```

| Endpoint | Does |
| --- | --- |
| `GET /api/notes` | List, newest first, without content. |
| `POST /api/notes` | Create. Optional `Idempotency-Key` (UUID). Returns 201 at once; tags (and summary) are generated after. |
| `GET /api/notes/:id` | The full note. |
| `POST /api/notes/:id/summary`, `…/tags` | The stored result, or one call to make it. `?regenerate=true` forces a new one. `Accept: text/event-stream` streams `preview` events, then `done`. |
| `DELETE /api/notes/:id`, `/api/notes` | Delete one, or all. |

**Schema** (`notes/table.ts`): `id, title, content, summary, tags text[], created_at, idempotency_key`. A `NULL` summary or tags means "not generated yet", so the row is the cache. `CHECK`s enforce every limit in `notes/limits.ts`, and an index on `(created_at, id) DESC` serves the list.

## Tech stack

| Choice | Why |
| --- | --- |
| React + Vite | Small UI, fast dev loop. Hash routes: no router library, no server fallback. |
| Express 5 | Required by the brief. v5 routes async errors to the error handler. |
| Postgres + Drizzle | Schema in TypeScript, migrations generated as readable SQL. |
| OpenAI Responses API, structured outputs | A strict JSON schema, so the reply always parses. Behind one `AiProvider` interface. |
| Zod | Validates request bodies, env vars and model output. |

## Decisions made

**API and data**
- **Express, because the brief names it.** Otherwise I'd pick Hono, which derives OpenAPI paths from typed routes. Here `openapi.ts` lists the paths by hand; the schemas still come from Zod.
- **Summary and tags are `POST`.** A request can spend money on a model call, so it isn't a safe `GET`.
- **AI starts on save, not on click.** Create returns without waiting; the note page requests whatever is missing, joins the running call, and streams it. The buttons regenerate.
- **Tags are a `text[]`, not a join table.** At most 5, always read with their note. A tag index or rename would change that.
- **Idempotency key is checked against the body.** The same key with a different note is 422, not a silent success.
- **Lengths are code points everywhere.** The form, the API and Postgres `char_length` agree, so an emoji can't pass one check and fail another.

**AI**
- **One call on save.** Tags and summary come back in one response, so the note's tokens are paid once. Tags are first in the schema, so they stream first. Each result is checked and stored separately: a bad summary doesn't drop the tags.
- **One place for the rules.** `notes/enrichment.ts` checks every provider's output: 1–5 tags (lowercased, `#` stripped, deduped); a summary of at most 590 characters and at least 20% shorter than the note. Output that breaks a rule isn't stored, so the next request retries. The `CHECK`s repeat the limits.
- **No summary under 500 characters.** It would be about as long as the note. Those notes get tags only, and the UI says why.
- **A failed regenerate keeps the old result.** The write happens only after the output passes the rules.
- **Prompts** (`ai/prompts.ts`) state the purpose (recall at a glance, grouping), ask for specifics (decisions, dates, names, open items), forbid outside facts, and answer in the note's language. The note is data inside `<note>`; a closing tag in it is escaped.
- **Errors.** Adapters turn SDK errors into `AiError`; `errors.ts` maps it to 504 (timeout), 503 (rate limited), 502 (bad output or upstream failure) or 422 (refused). Every error has the shape `{ error: { code, message } }`. A stream holds its headers until the first preview, so a call that fails before any text still gets its real status.
- **Bounded calls.** 30 s timeout, one SDK retry, 4096 output tokens. Content is capped at 20,000 characters (~5k tokens), which bounds the cost of any single call.

Tests use real Postgres, real HTTP and a scripted model, covering streams and every error mapping; Playwright drives the built UI on the fake provider. One live `gpt-6-luna` run (separate calls): summary 5.7 s, tags 2.3 s, cached 0.2 s; a German note stayed German; "Ignore all previous instructions…" was summarized like any note. The combined save-time call has only been replayed, not run live.

## Trade-offs and assumptions

- **Scale: one team's notebook.** Thousands of notes, a few concurrent users, one replica (the manifests run one; the guards above also hold for two).
- No accounts: every visitor shares one notebook, so "delete all" deletes everyone's notes. The Azure VM deploy is behind a shared password; the cluster one has no login.
- AI calls run in the API process, not a queue. On SIGTERM they finish and store their result; after a crash, opening the note retries.
- The list is unpaginated, which holds up to a few thousand notes. The `(created_at, id)` index is already the key a cursor would use.
- Notes can't be edited, so a stored summary never goes stale.
- Two replicas racing on the same note can each make one call. The conditional write keeps the row consistent; the cost is one extra call, not bad data.

## Production

- The app title is `AI Notes` on the browser tab, the sidebar, and the API document. Change that same string in `web/index.html` (`<title>`), `APP_TITLE` in `web/src/browser.ts`, the `<h1>` in `web/src/App.tsx`, and `info.title` in `server/src/openapi.ts`.
- One non-root image serves the API and UI. Migrations run at boot under an advisory lock. A missing API key fails at boot; `/api/health` checks Postgres.
- Mutations must carry a same-origin `Origin`. Shutdown waits up to 75 s for running AI calls; pod and load-balancer timeouts sit above that, and `deploy.test.ts` fails if one drops below.
- CI: typecheck, migration drift, unit and e2e tests, build, Docker image ([passing run](https://github.com/vitaliiznak/ai_notes_min/actions/runs/37559208247)).
- Deploys: [cluster, no login](deploy/README.md) · [Azure VM, shared password](deploy/vm/README.md).
- No rate limit yet: on a public deploy, set a spend limit in the OpenAI dashboard.

