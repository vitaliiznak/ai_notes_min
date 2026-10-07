# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, …) working in this repo.
The assignment is in `task.md`; the review bar it will be judged against is in `rules.md`. Read both before changing scope.

## Commands

```sh
docker compose up -d --wait db   # Postgres 17 on :5432 (tests create notes_test and its schema themselves)
npm install
npm run typecheck                # tsc for server + web, must stay clean
npm test                         # vitest: server (real Postgres) + web (api client), no network calls
npm run test:e2e                 # playwright: builds, starts the API on :3100 with the fake provider, drives the UI
npm run build                    # web → web/dist, server → server/dist
npm run dev:server               # :3000, reads ../.env (AI_PROVIDER=fake needs no key)
npm run dev:web                  # :5173, proxies /api to :3000
npm run db:generate -w server    # after editing server/src/notes/table.ts: writes the next migration
```

Definition of done for any change: `npm run typecheck` and `npm test` pass, `npm run test:e2e` too if you touched `web/`, and every README claim you touched is still true when someone runs it.

## Map

- `server/src/db.ts`: pool, and `migrateSchema`, which applies `server/drizzle/` at boot under an advisory lock.
- `server/src/notes/routes.ts`: HTTP surface. Thin: parse, call repo/enricher, respond.
- `server/src/notes/repo.ts`: note queries, through Drizzle.
- `server/src/notes/table.ts`: the only schema definition (columns, index, `CHECK`s). Migrations in `server/drizzle/` are generated from it.
- `server/src/notes/enrichment.ts`: AI business rules (one summary text, no longer than `summaryCharLimit`: 590 characters and at least 20% shorter than the note, otherwise it is not stored; the prompt's "few sentences" is figurative; up to 5 normalised tags; no summary under 500 characters), the one call a new note starts for both, and duplicate-call protection. Every provider's output goes through here.
- `server/src/ai/`: `AiProvider` interface, prompts, OpenAI adapter, fake provider. Adapters translate SDK errors into `AiError` and nothing else.
- `server/src/errors.ts`: the single error → HTTP mapping. Response shape is always `{ error: { code, message } }`.
- `web/src/`: React UI; `api.ts` mirrors server response types by hand, and `api.test.ts` covers its SSE reader.
- `web/e2e/`: Playwright specs against the built UI and a real API, on their own database with `AI_PROVIDER=fake`.

## Rules for changes

- A business rule lives in one place and applies to every entry point. Limits in `notes/limits.ts` are mirrored by the `CHECK`s in `notes/table.ts`.
- Schema changes: edit `table.ts`, run `npm run db:generate -w server`, commit the new file in `server/drizzle/`. Never edit a migration that has been applied; CI fails if the two disagree.
- Every mutation endpoint needs a test that fires real concurrent HTTP requests and fails if its protection is removed (see `server/test/ai-actions.test.ts`). Check it by deleting the guard and watching the test fail.
- Tests assert one specific outcome, unconditionally. No `expect` inside `if`, no "status is X or Y".
- Tests never call a real LLM. Use `scriptedAi()` from `server/test/helpers.ts`; adapter tests replay canned API payloads through the SDK's `fetch` option.
- Don't add dependencies, endpoints or UI that the task doesn't need. Smaller and proven beats larger and padded.
- Never read or print `.env`; it holds real API keys.
