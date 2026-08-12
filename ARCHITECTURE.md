# Book Translator — Architecture

## Overview

**Book Translator** is a local-first web application for translating EPUB books using LLM providers. It runs as a single Node.js process (Express + React SPA), stores all state in the local filesystem, and requires no external database.

- **Tech stack:** Node.js 24+, TypeScript 6, Express 5, React 19, Vite 8, Zod 4
- **Runtime:** `npm run dev` builds the client, then starts a server at `127.0.0.1:4173`
- **Tests:** Vitest (unit/integration/contract), Playwright (e2e)

---

## Project Structure

```
src/
├── shared/          # Types and schemas used by both client and server
│   ├── languages.ts          # Supported language definitions (en, ru, de, pl)
│   ├── domain/job.ts         # Job statuses, stages, transitions, progress helpers
│   └── api/schemas.ts        # Zod schemas for API contracts
├── client/          # Browser-side React SPA
│   ├── main.tsx              # Entry point
│   ├── styles.css            # Global CSS (design tokens)
│   ├── app/
│   │   ├── App.tsx           # Root component (command rail + routing)
│   │   ├── routes.tsx        # Client routing: /, /new, /jobs/:id
│   │   ├── api.ts            # fetch() wrappers for the backend API
│   │   └── job-events.ts     # SSE client for real-time job events
│   └── features/
│       ├── jobs/             # Job-related UI (JobsPage, NewJobPage, JobPage, etc.)
│       └── settings/         # Settings page
└── server/          # Node.js Express backend
    ├── index.ts              # Bootstrap: parse config → createApp → recover → listen
    ├── app.ts                # Express app factory (createApp)
    ├── api/                  # HTTP route handlers (6 routers)
    ├── config/               # Env parsing, secrets, profiles, defaults
    ├── domain/               # Server-side domain types (PersistedJob, DomainError, redaction)
    ├── epub/                 # EPUB extract / build / validate / batch / reinsert pipeline
    ├── jobs/                 # Orchestration: pipeline, runner, scheduler, translation/editing services
    ├── providers/            # LLM adapters (provider interface, DeepSeek, fake/deterministic)
    ├── storage/              # Filesystem persistence (JSON files, NDJSON journals, atomic writes)
    └── evals/                # Offline evaluation scripts (literary editor, consistency audits)
```

---

## Core Data Flow

### 1. Job Lifecycle

```
created → analyzing → ready → running → completed
                 ↓        ↓       ↓         ↓
               failed   paused   failed/stopping/needs_attention
                                           ↑         │
                                           └─────────┘  (completed/failed → running: re-run)
```

The legal moves live in the `transitions` table in `src/shared/domain/job.ts`; `changeStatus` (`src/server/domain/job.ts`) throws on anything else, so a new state must be added there first.

**Statuses** (in `src/shared/domain/job.ts`): `created`, `analyzing`, `ready`, `running`, `stopping`, `paused`, `needs_attention`, `completed`, `failed`.

**Stages** (what the job is doing right now): `import`, `analysis`, `translation`, `editing`, `audit`, `repair`, `building`, `validation`, `complete`.

`src/server/domain/job.ts` adds the zod-validated on-disk shape (`persistedJobSchema`, `version: 1`) and `toJobView` — the **only** projection sent to the browser. Nothing reaches the client that does not go through it, which is how credentials and filesystem paths stay server-side.

### 2. Upload Flow

1. POST `/api/jobs` creates job metadata only — title and language pair, status `created`, no file yet (`src/server/api/jobs.ts`)
2. PUT `/api/jobs/:id/source` uploads the raw `.epub` body to `data/jobs/<uuid>/source.epub`; re-uploading invalidates any completed work
3. POST `/api/jobs/:id/analyze` runs **analysis**: extracts the EPUB, parses OPF/container, extracts text segments, builds batches, validates the archive → status becomes `ready`
4. User clicks **Start** → POST `/:id/start` → `src/server/api/jobs.ts`

### 3. Translation Pipeline

Controlled by `src/server/jobs/book-pipeline.ts` and `src/server/jobs/job-runner.ts`:

The provider is `DeepSeekProvider` only when `BOOK_TRANSLATOR_PROVIDER !== "deterministic"` **and** both the translation and editing keys exist; otherwise `FakeProvider` (a deterministic `[translated] …` prefix), which is what the tests and the e2e suite run against. Profiles come from `config/profiles.ts` — translation, editing, critic and consistency, each with its own endpoint, model, thinking mode and prompt version, consistency falling back to the translation profile's key. `resolveProfiles()` is the single source of truth: the pipeline runs on it and `GET /api/settings` reports it, so the UI cannot show configuration a run would not use.

1. **Prepare book** (`prepareBook`): re-extract the EPUB to `staging/` on **every** run — assembly mutates staged documents in place — parse all XHTML/NCX documents, extract text segments, merge them into logical blocks, batch them
2. **Preflight** (external providers only, stage `analysis`): style profile, entity registry → generated glossary, and one chapter card per content document. All three are cached and advisory: a failure is a job warning, never a stop. The style block is appended to the job instructions, so it reaches every stage and every checkpoint key; a chapter card reaches only the batches of its own document
3. **Run quality pipeline** (`runQualityPipeline`), per batch, on a concurrency pool:
   - **Pass 1 — Translation**: sends batches to the LLM via `LanguageModelProvider.complete()` (mode: `"translation"`) → `drafts.ndjson`
   - **Pass 2 — Literary Editing**: sends translated batches back for stylistic polish (mode: `"editing"`) → `edits.ndjson`
   - **Quality Audit** (high quality mode only): critic over source/draft/edit (mode: `"audit"`), then a repair of the flagged blocks (mode: `"repair"`); `applySelectiveRepairs` accepts a rewrite only for a block the audit flagged
   - **Segment scan** (`segment-scan.ts`): a free deterministic comparison of every block with its original (empty, untranslated, length ratio, dropped numbers, source-script residue) → `quality-report.json`, written in both quality modes
4. **Consistency pass** — after the runner, across the whole book, not per chapter: mechanical normalization, an evidence report, and model-driven conflict resolution where the model returns decisions and code applies the replacements → `consistency-report.json`
5. **Build output EPUB**: reinsert edited text into the DOM, rewrite language tags, build to a `.tmp`, fsync, validate, audit, then rename into `output.epub`. EPUBCheck runs afterwards when installed and is report-only — its errors become job warnings and `epubcheck.txt`, never a failure
6. Results available via GET `/:id/download`

A text node larger than the batch budget is split across batches, and the pieces carry `<segment id>#<n>` ids so they stay distinct through the journals; `mergeChunkedSegments` rejoins them before the consistency pass. Reusing the bare id there collapsed the pieces in the id-keyed reinsertion map and silently dropped everything but the last one, so keep chunk ids distinct if you touch `batcher.ts`.

### 4. Provider Abstraction

`src/server/providers/provider.ts` defines the `LanguageModelProvider` interface:

```typescript
interface LanguageModelProvider {
  complete(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse>;
}
```

- `ProviderRequest` carries: profile (endpoint/model/key), mode (translation|editing|audit|repair|consistency), source/target languages, segments, glossary, instructions
- `ProviderResponse` returns: translated/edited segments, token usage, finish reason

Prompts are assembled in `providers/prompts.ts` from composable blocks: common rules, a strict JSON output contract, per-mode rules, and `TARGET_LANGUAGE_RULES` keyed by target language. Book content is explicitly framed as untrusted data, never instructions. `response-validator.ts` enforces the contract (exact ids, exact count, string `text`), and `retry-policy.ts` decides what is retried from `ProviderError.kind`:

- `temporary` — a dropped connection or a timeout. Retried with backoff, and given two attempts more than the rest (~15s of window) because the identical request works again once the network is back. The transport fault is named in the message (`Provider request failed (ECONNRESET)`).
- `invalid_response` — the model broke the contract. Retried a bounded number of times, then the **caller halves the batch**, because the same prompt asked again gets the same answer. The consistency pass halves its chunks the same way.
- `configuration` — never retried.

Every call, including a rejected one, appends a record to `usage.ndjson` with its tokens, outcome and, when it failed, the reason. A retry that succeeds discards the error, so that record is the only place the reason survives.

**Implementations:**

- `DeepSeekProvider` (`src/server/providers/deepseek.ts`) — calls DeepSeek API (or compatible OpenAI-like endpoints)
- `FakeProvider` (`src/server/providers/fake-provider.ts`) — deterministic local provider for testing/e2e, no credentials needed

Provider selection is configured via `BOOK_TRANSLATOR_PROVIDER` env var and separate profile env vars for translation, editing, critic, and consistency (each with its own endpoint/model/key).

---

## Key Architectural Decisions

### Storage: Filesystem-only, no database

All job data lives under `data/jobs/<uuid>/`:

- `job.json` — job metadata (title, languages, status, stage, progress)
- `source.epub` — original uploaded file, `staging/` — the extracted working copy, `output.epub` — the built translation
- `prepared.json` — documents, segments, logical blocks and batches from the analysis
- `drafts.ndjson`, `edits.ndjson`, `audits.ndjson`, `repairs.ndjson` — one checkpoint journal per pipeline stage
- `style-profile.json`, `entity-registry.json`, `chapter-cards.json`, `consistency-resolution.json` — cached preflight and consistency answers
- `quality-report.json`, `consistency-report.json`, `output-consistency-audit.json`, `epubcheck.txt` — diagnostics

The only global file is `<dataDir>/events.ndjson` — one append-only event log for every job, SSE-streamed to the client and never pruned.

`JobRepository` (`src/server/storage/job-repository.ts`) provides CRUD over these files. `EventRepository` (`src/server/storage/event-repository.ts`) reads/writes the NDJSON event log. State writes are atomic (write temp → fsync → rename → fsync parent dir); journals append with an fsync per line and stop reading at the first unparseable line, so a torn tail truncates rather than corrupts.

### Job Orchestrator

`JobOrchestrator` (`src/server/jobs/job-orchestrator.ts`) is the central coordinator. It exposes `analyze()`, `start()`, `pause()`, `resume()`, `retry()`, `invalidate()`, `rebuild()`, `results()`, and the job accessors; deletion is a repository call from the route. It manages an in-memory `Map` of active tasks with `AbortController` for cancellation.

A `Scheduler` (`src/server/jobs/scheduler.ts`) is a **single slot**: exactly one job runs process-wide, and a second `start()` on the same job joins the running promise instead of launching another. Batch concurrency inside a run is a separate, configurable pool.

### Checkpoint/Resume

Each pipeline stage journals its output keyed by `checkpointKey` (`job-runner.ts`) — a SHA-256 over prompt version, mode, profile identity, segments, instructions and glossary. Change a prompt, model or glossary entry and the key changes, so stale work is correctly discarded rather than reused. This is why `PROMPT_VERSION` / `PROMPT_INPUT_VERSION` in `providers/prompts.ts` must be bumped whenever prompt text changes semantically. Consistency results cache the same way (`entity-registry.json`, `consistency-resolution.json`, keyed by `CONSISTENCY_VERSION` plus payload, model and target language), and the settled entity renderings deliberately outlive code and model changes: re-asking re-rolls what a name is called and re-spends every stage that used it.

A job also records the SHA-256 of its source archive. Keyed checkpoints are content-addressed and safe on their own, but the by-batch-id recovery a resume uses matches on positional ids, so a source replaced under a paused job would otherwise hand the new text a translation of the old one. On restart/crash recovery (`src/server/jobs/recovery.ts`), jobs left `running`/`analyzing` are demoted to `paused`/`needs_attention` and resume from the last checkpoint, skipping completed batches.

`invalidate(id, batchId?, from)` rewinds deliberately. `from` is a stage floor — `translation` (default), `editing`, or `audit`: everything from it down is discarded, everything above it survives and replays from its checkpoint for free. So a re-edit keeps the draft, and a re-audit keeps both the draft and the edit. Settled entity renderings (`entity-registry.json`, `consistency-resolution.json`) clear only on a full rewind of every batch, because renaming entities under work that is being kept would split the book.

### Secrets and configuration

`config/secrets.ts` reads `.env.local` then `.env` **synchronously at call time** — no dotenv, no `process.env` mutation, so the server must be restarted after editing them. Runtime config (host, port, data dir, upload limit) is separate and zod-parsed from `process.env` in `config/schema.ts`. Credentials never enter job state, events or `JobView`; `GET /api/settings` reports endpoint, model and a `hasApiKey` boolean via `profilesView`, and errors that reach a client go through `redact()`.

### Security boundaries worth knowing before touching EPUB code

`epub/archive-policy.ts` rejects absolute, traversing, backslash and NUL entry names, drive letters, encrypted entries and unsupported compression, and enforces entry-count, per-entry and total-expansion limits (zip-bomb defence). `epub/validate.ts` additionally rejects `?`, `#` and percent-encoded separators in EPUB-internal references. Every filesystem path derived from user input goes through `safeJobPath`/`jobRoot` (`storage/job-paths.ts`) or `resolveEpubPath` (`epub/validate.ts`). Hostile-input fixtures live in `tests/fixtures/build-hostile-epubs.ts`.

### Real-time Events (SSE)

`GET /api/jobs/:id/events` streams Server-Sent Events to the client. The orchestrator emits events (via `onEvent` callback) which are appended to the event journal and streamed to connected SSE clients. The client consumes these via `src/client/app/job-events.ts`.

### API Design

All API routes are mounted under `/api/jobs` and `/api/settings`:

- `POST /api/jobs` — upload EPUB, create job
- `GET /api/jobs` — list all jobs
- `GET /api/jobs/:id` — get job state
- `PUT /api/jobs/:id/config` — update job config (languages, quality mode)
- `PUT /api/jobs/:id/source` — replace source EPUB
- `POST /api/jobs/:id/analyze` — re-run analysis
- `POST /api/jobs/:id/start` — start translation
- `POST /api/jobs/:id/pause` / `resume` — control
- `POST /api/jobs/:id/retry` — retry a failed, paused or needs-attention run
- `POST /api/jobs/:id/invalidate` — rewind the pipeline; body `{ from?: "translation" | "editing" | "audit", batchId?: string }`
- `POST /api/jobs/:id/rebuild` — rebuild the EPUB from the current staging directory
- `DELETE /api/jobs/:id` — delete the job and its data
- `GET /api/jobs/:id/results` — job results and statistics
- `GET /api/jobs/:id/download` — download translated EPUB
- `GET /api/jobs/:id/events` — SSE event stream
- `GET /api/health` — health check
- `GET /api/settings` — read-only view of the resolved provider profiles (endpoint, model, `hasApiKey`); `POST /api/settings/test` reports whether a credential is configured at all — it does not call the provider. Credentials are read from `.env.local`/`.env` at call time and never enter job state, events or `JobView`

Errors use RFC 7807 problem responses (`src/server/api/problem.ts`).

### Client Architecture

The React SPA is a single-page app with client-side routing (no SSR):

- `App.tsx` renders a command rail sidebar + `<Routes>` — a hand-rolled router (`routes.tsx` matches `location.pathname`); there is no routing dependency
- Pages: `JobsPage` (list), `NewJobPage` (upload), `JobPage` (detail: controls, progress, style profile, results, log panel)
- `JobPage` subscribes to SSE events and updates live
- API calls go through `request()` in `src/client/app/api.ts` — the only fetch layer, and it unwraps RFC 7807 problem responses

---

## Testing

Tests are grouped by the boundary they exercise, not by source folder: `tests/unit` (pure logic), `tests/integration` (filesystem, HTTP, job lifecycle, EPUB round-trips), `tests/contract` (provider and API shapes), `tests/e2e` (Playwright against the deterministic provider). Vitest runs in the `node` environment for all of them. EPUB fixtures are generated by `tests/fixtures/build-epubs.ts` and `build-hostile-epubs.ts`; assertions on archive contents use `tests/helpers/epub-inspector.ts`.

Model behaviour is measured, not assumed: `npm run report:models` reads every finished job's `usage-report.json` and `quality-report.json` and reports cost and quality per model and stage, and `npm run eval:literary` scores the frozen corpus against the acceptance rule declared in `evals/literary-editor/cases.json`.
