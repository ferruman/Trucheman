# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` holds the conventions (structure, style, commit/PR rules) and stays authoritative for those. This file covers commands and the architecture that spans multiple files.

## Commands

```sh
npm run dev          # vite build (predev), then server on http://127.0.0.1:4173
npm run build        # tsc -b (both projects) + vite build
npm run typecheck    # tsc -b --pretty false
npm run lint         # typescript-eslint recommended; `no-explicit-any` is a warning, everything else errors
npm run format       # prettier --write .
npm test             # vitest run  (tests/unit, tests/integration, tests/contract)
npm run e2e          # playwright; boots `npm run dev` with BOOK_TRANSLATOR_PROVIDER=deterministic
```

`reuseExistingServer: true` means e2e silently attaches to whatever already listens on 4173 — check for a stale dev server before trusting a failure.

Single test / focused runs:

```sh
npx vitest run tests/unit/batching.test.ts
npx vitest run -t "name of the test"
npx playwright test tests/e2e/core-translation.spec.ts
npx playwright test --headed --debug
```

Paid evaluation runs (need real credentials in `.env.local`):

```sh
npm run eval:literary -- --limit 3 --model deepseek-v4-pro --prompt-version literary-v3.2.1
npm run eval:literary -- --provider deterministic     # free; exercises corpus/scoring only
npm run audit:epub -- path/to/book.epub               # consistency audit of an existing EPUB
```

`epubcheck` is optional — `runOptionalEpubCheck` and `scripts/check-epub.mjs` both treat `ENOENT` as a pass, so the epubcheck integration test is a no-op when it isn't installed.

## Architecture

Local-first EPUB translator. Express + React (Vite), everything on the local filesystem; the only outbound traffic is provider calls.

### Request → job flow

`src/server/index.ts` parses env config, creates the data dir, wires `createApp`, and calls `recoverActiveJobs` (jobs left `running`/`analyzing` by a crash are demoted to `paused`/`needs_attention`) before listening. `createApp` (`src/server/app.ts`) constructs the three repositories, one `JobOrchestrator`, and mounts all routers under `/api/jobs`; unmatched routes fall through to the built SPA in `dist/client` — which is why `predev` builds the client before the dev server starts.

### Job lifecycle — the state machine is the contract

`src/shared/domain/job.ts` owns `JobStatus`, `JobStage`, the legal `transitions` table, and `progressFor`'s invariants (`edited <= translated <= total`). Any new state or transition must be added there; `changeStatus` throws on illegal moves. `src/server/domain/job.ts` adds the zod-validated on-disk shape (`persistedJobSchema`, `version: 1`) and `toJobView`, the **only** projection sent to the browser — nothing reaches the client that doesn't go through it.

`JobOrchestrator` (`src/server/jobs/job-orchestrator.ts`) is the concurrency boundary. A single-slot `Scheduler` allows exactly one active job process-wide; `claims` guards the window between "decided to start" and "task registered" so concurrent `POST /start` calls collapse into one `launches` promise. Pause is `AbortController.abort()`; the run loop turns an aborted signal into `paused`, anything else into `failed`. Errors emitted to clients go through `redact()`.

### Translation pipeline

`runPreparedBook` (`src/server/jobs/book-pipeline.ts`) is the whole book run:

1. **Always re-extracts** the source EPUB into `staging/`. Assembly mutates staged documents in place, so reusing a previous staging directory would re-insert translations into already-translated text.
2. Chooses provider: `DeepSeekProvider` only when `BOOK_TRANSLATOR_PROVIDER !== "deterministic"` **and** both translation and editing API keys exist; otherwise `FakeProvider` (deterministic `[translated] …` prefix), which is what tests and e2e run against.
3. Resolves provider profiles through `config/profiles.ts` — translation, editing, consistency, each with its own endpoint/model/thinking/prompt version, consistency falling back to the translation profile's key/endpoint/model. `resolveProfiles()` is the single source of truth: the pipeline runs on it and `GET /api/settings` reports it, so the UI can never show configuration a run would not use.
4. Entity registry pass (external providers only) → merged with the user glossary, user entries winning.
5. `runTwoPass` (`job-runner.ts`) — per batch: translate, then edit, appending to `drafts.ndjson` / `edits.ndjson`.
6. Consistency: mechanical normalization (`ё`, «ёлочки» — Russian targets only), evidence report, model-driven conflict resolution where **the model returns decisions and code applies the replacements**, then `consistency-report.json`.
7. Reinsert edited text, rewrite language tags in content + package, build to a `.tmp`, `fsync`, validate, audit, and only then `rename` into `output.epub`.

A text node larger than the batch budget is split across batches, and the chunks carry `<segment id>#<n>` ids so they stay distinct through the journals; `mergeChunkedSegments` rejoins them before step 6. Reusing the bare id there collapsed the pieces in the id-keyed reinsertion map and silently dropped everything but the last chunk, so keep chunk ids distinct if you touch `batcher.ts`.

Resumability comes from `checkpointKey` in `job-runner.ts`: a SHA-256 over prompt version, mode, profile identity, segments, instructions, and glossary. Change a prompt, model, or glossary and every checkpoint key changes, so cached work is correctly discarded — this is why `PROMPT_VERSION`/`PROMPT_INPUT_VERSION` in `providers/prompts.ts` must be bumped when prompt text changes semantically. Consistency results cache the same way (`entity-registry.json`, `consistency-resolution.json`, keyed by `CONSISTENCY_VERSION` + payload + model + target language).

### Storage layout

Everything for a job lives in `<dataDir>/jobs/<uuid>/`: `job.json`, `source.epub`, `staging/`, `drafts.ndjson`, `edits.ndjson`, `prepared.json`, `consistency-report.json`, `entity-registry.json`, `consistency-resolution.json`, `output.epub`. The only global file is `<dataDir>/events.ndjson` — one append-only log for every job, never pruned, so anything that scans it per event is quadratic in the life of the install (`EventRepository` keeps the last id in memory for exactly this reason).

Durability rules, don't bypass them: state writes go through `atomic-file.ts` (temp file → fsync → rename → fsync parent dir); journals append via `ndjson-journal.ts` with `fsync` per line, and `readJournal` **stops at the first unparseable line** so a torn tail truncates rather than corrupts. Every filesystem path derived from user input goes through `safeJobPath`/`jobRoot` (`storage/job-paths.ts`) or `resolveEpubPath` (`epub/validate.ts`).

### Providers

`LanguageModelProvider.complete()` is the single seam (`providers/provider.ts`). Prompts are assembled in `providers/prompts.ts` from composable blocks — common rules, a strict JSON output contract, per-mode rules, and `TARGET_LANGUAGE_RULES` keyed by target language. Book content is explicitly framed as untrusted data, never instructions. `response-validator.ts` enforces the contract (exact ids, exact count, string `text`); `retry-policy.ts` + `ProviderError`'s `kind` (`temporary` / `configuration` / `invalid_response`) decide what is retried.

### Secrets

`config/secrets.ts` reads `.env.local` then `.env` **synchronously at call time** — no dotenv, no `process.env` mutation, and the server must be restarted after editing them. Runtime config (host/port/dataDir/upload limit) is separate, zod-parsed from `process.env` in `config/schema.ts`. Credentials never enter job state, events, or `JobView`; `GET /api/settings` is read-only and reports endpoint/model plus a `hasApiKey` boolean via `profilesView`.

### Client

React 19 + a hand-rolled router (`client/app/routes.tsx`); `client/app/api.ts` is the only fetch layer and unwraps RFC 7807 problem responses. Live progress comes from `GET /api/jobs/:id/events` (SSE) — `EventRepository` replays `events.ndjson` from `last-event-id`, then streams, with a 15s heartbeat comment.

### Security boundaries worth knowing before touching EPUB code

`epub/archive-policy.ts` rejects absolute/traversing/backslash/NUL entry names, drive letters, encrypted entries, unsupported compression, and enforces entry-count / per-entry / total-expansion limits (zip-bomb defense). `epub/validate.ts` additionally rejects `?`, `#`, and percent-encoded separators in EPUB-internal references. Hostile-input fixtures live in `tests/fixtures/build-hostile-epubs.ts`.

## Testing layout

Tests are grouped by the boundary they exercise, not by source folder: `tests/unit` (pure logic), `tests/integration` (filesystem, HTTP, job lifecycle, EPUB round-trips), `tests/contract` (provider and API shapes), `tests/e2e` (Playwright, deterministic provider). Vitest runs in the `node` environment for all of them. EPUB fixtures are generated by `tests/fixtures/build-epubs.ts` / `build-hostile-epubs.ts`; assertions on archive contents use `tests/helpers/epub-inspector.ts`.
