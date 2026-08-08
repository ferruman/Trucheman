# Tasks: Local-First Book Translation MVP

**Input**: Design documents from `/docs/001-book-translation-mvp/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/openapi.yaml`, `quickstart.md`

**Tests**: Required by the feature specification. For each user-story phase, add the listed tests first and confirm they fail for the expected missing behavior before implementation.

**Organization**: Tasks are grouped by independently testable user stories. Exact source paths follow the single-project `src/server`, `src/client`, and `src/shared` structure from the implementation plan.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can be executed in parallel after its phase prerequisites because it targets separate files and contracts.
- **[Story]**: Maps the task to a user story in `spec.md`.

## Phase 1: Setup

**Purpose**: Establish the runnable TypeScript application and quality gates.

- [X] T001 Create the Node 24 npm project metadata, scripts, engines, and exact runtime/dev dependency ranges in `package.json`
- [X] T002 Install dependencies and commit the reproducible dependency graph in `package-lock.json`
- [X] T003 [P] Configure shared, server, and browser TypeScript project references in `tsconfig.json`, `tsconfig.server.json`, and `tsconfig.client.json`
- [X] T004 [P] Configure the React build and single-process Vite middleware entry in `vite.config.ts` and `index.html`
- [X] T005 [P] Configure Node/jsdom Vitest projects and Playwright browser tests in `vitest.config.ts` and `playwright.config.ts`
- [X] T006 [P] Configure linting and formatting gates in `eslint.config.js` and `.prettierrc.json`
- [X] T007 Protect local data and credentials and document safe environment names in `.gitignore` and `.env.example`

**Checkpoint**: `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` exist and can execute against an empty application skeleton.

---

## Phase 2: Foundational Infrastructure

**Purpose**: Implement shared boundaries that block every user story.

**⚠️ CRITICAL**: Complete this phase before user-story implementation.

- [X] T008 [P] Define BCP 47 language options, job stages/statuses, progress invariants, and shared view types in `src/shared/languages.ts` and `src/shared/domain/job.ts`
- [X] T009 [P] Define Zod request, response, event, and problem schemas matching the OpenAPI contract in `src/shared/api/schemas.ts`
- [X] T010 [P] Add failing unit tests for runtime defaults, upload limits, loopback host enforcement, and invalid environment input in `tests/unit/config.test.ts`
- [X] T011 Implement immutable runtime configuration parsing and safe defaults in `src/server/config/schema.ts` and `src/server/config/defaults.ts`
- [X] T012 [P] Implement job-root path construction and containment checks without unresolved user paths in `src/server/storage/job-paths.ts`
- [X] T013 [P] Implement atomic JSON replacement and durable newline-delimited journal primitives in `src/server/storage/atomic-file.ts` and `src/server/storage/ndjson-journal.ts`
- [X] T014 Implement validated job schemas, legal state transitions, and derived progress calculations in `src/server/domain/job.ts` and `src/server/domain/progress.ts`
- [X] T015 Implement filesystem job/settings repositories with schema-version checks in `src/server/storage/job-repository.ts` and `src/server/storage/settings-repository.ts`
- [X] T016 [P] Implement sanitized domain errors and RFC-style problem responses in `src/server/domain/errors.ts` and `src/server/api/problem.ts`
- [X] T017 [P] Define provider request/result/error contracts and a deterministic fake provider in `src/server/providers/provider.ts` and `tests/helpers/fake-provider.ts`
- [X] T018 Compose an Express application without listening, including bounded JSON parsing and API/static route order in `src/server/app.ts`
- [X] T019 [P] Create the React application shell, routes, typed API client, and shared query state in `src/client/app/App.tsx`, `src/client/app/routes.tsx`, and `src/client/app/api.ts`

**Checkpoint**: Shared schemas, local repositories, provider boundary, Express composition, and browser shell are independently testable.

---

## Phase 3: User Story 1 — Produce a Readable Translated EPUB (Priority: P1) 🎯 Core MVP

**Goal**: Import a valid EPUB, review a proposed glossary, execute deterministic translation plus editing, preserve the book, validate it, and download the result.

**Independent Test**: Use the deterministic provider with a representative EPUB containing text, CSS, an image, a link, and a footnote; complete both passes and open the validated output while comparing structure and untouched resources.

### Tests for User Story 1

- [X] T020 [US1] Build deterministic EPUB 2/3 fixture generation and structural inspection helpers in `tests/fixtures/build-epubs.ts` and `tests/helpers/epub-inspector.ts`
- [X] T021 [P] [US1] Add failing archive security and EPUB package-order round-trip tests in `tests/integration/epub-archive.test.ts`
- [X] T022 [P] [US1] Add failing container, package, manifest, and spine parsing tests in `tests/unit/package-parser.test.ts`
- [X] T023 [P] [US1] Add failing namespace-aware text extraction, locator, whitespace, and DOM-equivalence tests in `tests/unit/text-segments.test.ts`
- [X] T024 [P] [US1] Add failing batching, long-segment subdivision, token-reserve, and document-boundary tests in `tests/unit/batching.test.ts`
- [X] T025 [P] [US1] Add failing translation/editing prompt, exact-ID, hard-validation, and soft-warning tests in `tests/contract/provider-segments.test.ts`
- [X] T026 [P] [US1] Add failing whole-book name analysis, alias deduplication, relevance, and resume tests in `tests/integration/name-analysis.test.ts`
- [X] T027 [P] [US1] Add a failing two-pass chapter-order and draft/edit persistence integration test in `tests/integration/two-pass-pipeline.test.ts`
- [X] T028 [P] [US1] Add failing create/configure/analyze/start/status/download API contract tests in `tests/contract/core-job-api.test.ts`
- [X] T029 [P] [US1] Add a failing browser flow for import, glossary review, processing, and download in `tests/e2e/core-translation.spec.ts`

### Implementation for User Story 1

- [X] T030 [P] [US1] Implement archive entry normalization, duplicate detection, compression/encryption/symlink policy, and expanded-size budgets in `src/server/epub/archive-policy.ts`
- [X] T031 [US1] Implement bounded yauzl extraction to a private job staging root with cleanup on failure in `src/server/epub/extract.ts`
- [X] T032 [P] [US1] Implement `container.xml`, OPF metadata, manifest, and declared-spine parsing in `src/server/epub/package-parser.ts`
- [X] T033 [P] [US1] Implement strict XML parsing, namespace helpers, structural snapshots, and well-formed serialization in `src/server/epub/xml-dom.ts`
- [X] T034 [US1] Implement eligible visible text-node extraction, stable structural locators, source hashes, and whitespace preservation in `src/server/epub/text-segments.ts`
- [X] T035 [US1] Implement per-document batching with a conservative estimator and `Intl.Segmenter` subdivision in `src/server/epub/batcher.ts` and `src/server/providers/token-estimator.ts`
- [X] T036 [P] [US1] Implement proper-name analysis prompts, response schemas, canonicalization, aliasing, and relevant-glossary selection in `src/server/providers/name-analysis.ts`
- [X] T037 [US1] Implement resumable name-analysis checkpoints and editable language-pair glossary persistence in `src/server/jobs/name-analysis-runner.ts`
- [X] T038 [P] [US1] Implement language-neutral translation and editing prompt builders with exact JSON examples and read-only context in `src/server/providers/prompts.ts`
- [X] T039 [P] [US1] Implement structured provider response parsing, exact-ID hard checks, and soft quality warnings in `src/server/providers/response-validator.ts`
- [X] T040 [US1] Implement independent draft translation and original-aware editing services in `src/server/jobs/translation-service.ts` and `src/server/jobs/editing-service.ts`
- [X] T041 [US1] Implement chapter-ordered two-pass execution and per-step durable commit ordering in `src/server/jobs/job-runner.ts`
- [X] T042 [US1] Implement locator re-resolution and edited-text-only DOM reinsertion with source-hash checks in `src/server/epub/reinsert.ts`
- [X] T043 [US1] Implement streaming yazl EPUB assembly with first stored `mimetype` and revisioned temporary output in `src/server/epub/build.ts`
- [X] T044 [US1] Implement mandatory archive/package/spine/resource/XML/result-completeness validation in `src/server/epub/validate.ts`
- [X] T045 [US1] Implement core job creation, configuration, name analysis, start, detail, list, and download handlers in `src/server/api/jobs.ts`
- [X] T046 [P] [US1] Implement the job list and new-book language/upload step in `src/client/features/jobs/JobsPage.tsx` and `src/client/features/jobs/NewJobPage.tsx`
- [X] T047 [P] [US1] Implement accessible glossary editing and shared-instructions UI in `src/client/features/jobs/GlossaryPage.tsx` and `src/client/features/jobs/GlossaryTable.tsx`
- [X] T048 [P] [US1] Implement basic processing status and successful download views in `src/client/features/jobs/JobPage.tsx` and `src/client/features/jobs/ResultPage.tsx`
- [X] T049 [US1] Wire startup, Vite middleware/static delivery, job recovery bootstrap, and loopback listening in `src/server/index.ts`

**Checkpoint**: User Story 1 passes with the deterministic provider and produces a validated readable EPUB with separately stored drafts and edits.

---

## Phase 4: User Story 2 — Configure the External Language Service Safely (Priority: P2)

**Goal**: Configure translation/editing provider profiles, test DeepSeek connectivity, and keep credentials and full request text out of all local/browser artifacts.

**Independent Test**: Configure sentinel credentials, exercise success and permanent provider errors, and scan state, logs, events, frontend assets, HTTP responses, and output for leakage.

### Tests for User Story 2

- [X] T050 [P] [US2] Add failing secret-loader, client-bundle boundary, and sentinel redaction tests in `tests/unit/secrets.test.ts`
- [X] T051 [P] [US2] Add failing DeepSeek JSON-mode success, empty/truncated output, usage, timeout, and error-classification contract tests in `tests/contract/deepseek-provider.test.ts`
- [X] T052 [P] [US2] Add failing settings read/update/test API tests that expose only credential-presence flags in `tests/contract/settings-api.test.ts`

### Implementation for User Story 2

- [X] T053 [P] [US2] Implement server-only `.env.local` loading, credential lookup, and safe config validation in `src/server/config/secrets.ts`
- [X] T054 [P] [US2] Implement provider/error/request redaction utilities and sentinel-safe log fields in `src/server/domain/redaction.ts`
- [X] T055 [US2] Implement the non-streaming configurable DeepSeek Chat Completions adapter with JSON mode, timeout, finish-reason, and usage handling in `src/server/providers/deepseek.ts`
- [X] T056 [US2] Implement non-secret settings update/read and connection-test handlers in `src/server/api/settings.ts`
- [X] T057 [P] [US2] Implement independent translation/editing profile settings and credential-presence UI in `src/client/features/settings/SettingsPage.tsx`
- [X] T058 [US2] Add the external-content disclosure and prevent start until provider configuration is usable in `src/client/features/jobs/GlossaryPage.tsx`

**Checkpoint**: User Stories 1 and 2 form a user-runnable local MVP against a configured external service with no secret leakage.

---

## Phase 5: User Story 3 — Pause and Resume Without Paying Twice (Priority: P3)

**Goal**: Pause safely, recover active jobs as paused after restart, reuse every verified step, and require explicit invalidation for language/glossary changes.

**Independent Test**: Pause during translation and editing, force-stop after completed batches, restart, resume, and verify the provider receives no duplicate request for completed steps.

### Tests for User Story 3

- [X] T059 [P] [US3] Add failing startup recovery and stale-running-to-paused integration tests in `tests/integration/startup-recovery.test.ts`
- [X] T060 [P] [US3] Add failing in-flight pause, no-new-request, and durable-result sequencing tests in `tests/integration/pause-resume.test.ts`
- [X] T061 [P] [US3] Add failing completed-translation/edit reuse and zero-duplicate-request tests in `tests/integration/resume-idempotence.test.ts`

### Implementation for User Story 3

- [X] T062 [P] [US3] Implement startup scanning and recoverable active-state conversion with recovery events in `src/server/jobs/recovery.ts`
- [X] T063 [US3] Implement cooperative `running -> stopping -> paused` scheduling control around in-flight requests in `src/server/jobs/pause-controller.ts`
- [X] T064 [US3] Implement first-unfinished-step planning and committed result reuse in `src/server/jobs/resume-plan.ts`
- [X] T065 [US3] Implement target-language/glossary change impact analysis and explicit scope invalidation in `src/server/jobs/invalidation.ts`
- [X] T066 [US3] Implement pause/resume and confirmed job-config invalidation handlers in `src/server/api/job-control.ts`
- [X] T067 [US3] Implement pause/resume controls and invalidation confirmation UX in `src/client/features/jobs/JobControls.tsx` and `src/client/features/jobs/InvalidationDialog.tsx`

**Checkpoint**: Long jobs survive browser closure and process restart without repeating paid verified work.

---

## Phase 6: User Story 4 — Understand Progress and Recover From Failures (Priority: P4)

**Goal**: Show durable live progress and sanitized events, classify and bound retries, enter `needs_attention`, and retry the failed scope.

**Independent Test**: Inject rate limits, server errors, timeouts, malformed responses, and permanent configuration errors; verify retry timing, job state, event replay, and targeted user recovery.

### Tests for User Story 4

- [X] T068 [P] [US4] Add failing fake-clock retry/backoff/jitter/Retry-After and permanent-error classification tests in `tests/unit/retry-policy.test.ts`
- [X] T069 [P] [US4] Add failing SSE framing, monotonic ID, heartbeat, backpressure, cleanup, and Last-Event-ID replay tests in `tests/integration/job-events-sse.test.ts`
- [X] T070 [P] [US4] Add failing exhausted-retry, needs-attention, targeted-retry, and retained-work API tests in `tests/integration/failure-recovery.test.ts`

### Implementation for User Story 4

- [X] T071 [P] [US4] Implement bounded exponential backoff with jitter, retry guidance, abortable delay, and error policy in `src/server/providers/retry-policy.ts`
- [X] T072 [US4] Implement the one-active-job/one-active-request scheduler and needs-attention transitions in `src/server/jobs/scheduler.ts`
- [X] T073 [P] [US4] Implement durable sanitized event append/replay and live subscriptions in `src/server/storage/event-repository.ts` and `src/server/jobs/event-hub.ts`
- [X] T074 [US4] Implement job SSE headers, replay, heartbeat, backpressure, and disconnect cleanup in `src/server/api/job-events.ts`
- [X] T075 [US4] Implement failed batch/chapter retry selection and HTTP handler in `src/server/jobs/retry-service.ts` and `src/server/api/job-retry.ts`
- [X] T076 [P] [US4] Implement reconnecting event consumption with persisted-state refresh in `src/client/app/job-events.ts`
- [X] T077 [P] [US4] Implement overall/chapter counters, current stage, chapter list, warnings, events, and failure action UI in `src/client/features/jobs/ProgressPanel.tsx`
- [X] T078 [US4] Implement offline-capable job list actions and confirmed job deletion in `src/server/api/jobs.ts` and `src/client/features/jobs/JobsPage.tsx`

**Checkpoint**: Users can understand a running/failed job and recover the exact failed scope without file inspection or lost verified work.

---

## Phase 7: User Story 5 — Validate, Inspect, and Rebuild the Result (Priority: P5)

**Goal**: Expose validation evidence and statistics, optionally run EPUBCheck, repeat a chapter, and retain the previous good output until a rebuild succeeds.

**Independent Test**: Complete a job, retry one chapter, inject a rebuild failure, verify the prior artifact hash remains downloadable, then rebuild successfully and observe a new revision.

### Tests for User Story 5

- [X] T079 [P] [US5] Add failing built-in validation report and revisioned-output retention tests in `tests/integration/output-validation.test.ts`
- [X] T080 [P] [US5] Add failing optional EPUBCheck discovery, timeout, sanitization, and absence-not-blocking tests in `tests/integration/epubcheck.test.ts`
- [X] T081 [P] [US5] Add failing usage, retry, elapsed-time, and user-priced estimate aggregation tests in `tests/unit/job-statistics.test.ts`

### Implementation for User Story 5

- [X] T082 [P] [US5] Implement document-linked validation report aggregation and public safe views in `src/server/epub/validation-report.ts`
- [X] T083 [P] [US5] Implement bounded optional local EPUBCheck discovery and execution in `scripts/check-epub.mjs` and `src/server/epub/epubcheck.ts`
- [X] T084 [US5] Implement usage/retry/time/cost statistics aggregation from provider run metadata in `src/server/jobs/statistics.ts`
- [X] T085 [US5] Implement chapter repetition, validation/build orchestration, and atomic output revision promotion in `src/server/jobs/rebuild-service.ts`
- [X] T086 [US5] Implement chapter retry, rebuild, validation detail, statistics, and download handlers in `src/server/api/job-results.ts`
- [X] T087 [US5] Implement the result report, chapter retry, rebuild state, statistics, warnings, and download UX in `src/client/features/jobs/ResultPage.tsx`

**Checkpoint**: A completed job has inspectable validation evidence and statistics, and no failed rebuild can destroy its last successful output.

---

## Phase 8: Polish & Cross-Cutting Acceptance

**Purpose**: Close security, compatibility, accessibility, performance, and end-to-end acceptance across stories.

- [X] T088 [P] Generate hostile traversal, duplicate-path, encrypted, oversized, high-ratio, malformed XML, and missing-package fixtures in `tests/fixtures/build-hostile-epubs.ts`
- [X] T089 [P] Add a full sentinel scan across job files, events, browser assets, HTTP payloads, and output archives in `tests/integration/secret-leakage.test.ts`
- [X] T090 Add deterministic English-to-Russian and German-to-Polish end-to-end acceptance runs in `tests/e2e/language-pairs.spec.ts`
- [X] T091 [P] Add keyboard, focus, label, table, dialog, status announcement, and desktop readability checks in `tests/e2e/accessibility.spec.ts`
- [X] T092 [P] Add large-fixture bounded-memory and responsive job-list performance checks in `tests/integration/performance.test.ts`
- [X] T093 [P] Add macOS/Windows/Linux path-semantics and atomic-write compatibility cases in `tests/unit/cross-platform-paths.test.ts`
- [X] T094 Document install, one-command development/production startup, local URL, privacy disclosure, and recovery workflow in `README.md`
- [ ] T095 Run every scenario in `docs/001-book-translation-mvp/quickstart.md` and record commands, fixture hashes, optional EPUBCheck output, and acceptance results in `docs/001-book-translation-mvp/validation-results.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 — Setup**: starts immediately.
- **Phase 2 — Foundational**: depends on Phase 1 and blocks all user stories.
- **Phase 3 — US1**: depends on Phase 2; establishes the core deterministic two-pass EPUB flow.
- **Phase 4 — US2**: depends on Phase 2 and can develop against the provider interface in parallel with most of US1; final live-provider integration uses US1's runner.
- **Phase 5 — US3**: depends on the US1 runner, repositories, and per-step commit behavior.
- **Phase 6 — US4**: event/retry primitives can begin after Phase 2, while full failure recovery depends on US1 and pause-aware orchestration from US3.
- **Phase 7 — US5**: depends on US1 build/validation; chapter repetition and retained-output flows also use US3/US4 controls.
- **Phase 8 — Polish**: depends on all stories included in the release.

### User Story Dependency Graph

```text
Setup -> Foundation -> US1 Core EPUB Flow -> US3 Pause/Resume -> US4 Failure Recovery -> US5 Rebuild
                    \-> US2 Provider Safety ------------------/             /
```

### Within Each User Story

- Create fixture/test tasks first and verify the expected failure.
- Implement pure schemas and domain logic before storage/orchestration.
- Implement services before HTTP handlers and UI integration.
- Complete the independent test at the phase checkpoint before advancing.

## Parallel Opportunities

### User Story 1

- After T020, execute T021–T029 in parallel to establish failing contracts.
- T030, T032, T033, T036, T038, and T039 touch independent modules and can proceed in parallel.
- T046–T048 can proceed in parallel after T009/T019 and the API view contracts stabilize.

### User Story 2

- T050–T052 can run in parallel; T053 and T054 can then run in parallel while T055 targets the provider adapter.
- T057 can proceed against the settings contract while T056 implements the handler.

### User Story 3

- T059–T061 can be authored in parallel.
- T062 and T065 target independent recovery/invalidation concerns.

### User Story 4

- T068–T070 can be authored in parallel.
- T071 and T073 are independent provider/event primitives; T076/T077 are independent client modules after event schemas stabilize.

### User Story 5

- T079–T081 can be authored in parallel.
- T082, T083, and T084 target separate validation, tool-integration, and statistics modules.

## Implementation Strategy

### Engineering MVP

1. Complete Setup and Foundational phases.
2. Complete US1 with the deterministic provider.
3. Validate EPUB round trip, two-pass persistence, and download before any live paid run.

### User-Runnable Local MVP

1. Add US2 to the engineering MVP.
2. Run a small live provider fixture and complete the secret sentinel scan.
3. Do not translate a full book until the deterministic structural suite passes.

### Reliable MVP

1. Add US3 and verify zero duplicate paid requests across pause/restart.
2. Add US4 and inject every retry/permanent failure class.
3. Add US5 and prove failed rebuild retention.
4. Complete Phase 8 acceptance and record evidence.

## Notes

- Tasks marked `[P]` operate on independent files after their stated prerequisites.
- Binary EPUB fixtures should be generated deterministically from source fixture builders, not edited manually.
- Keep source changes scoped to the exact task; shared schema changes require dependent contract tests in the same change.
- Current external model aliases and prices remain settings, never source constants.
- The task list deliberately defers OpenAI, nav/TOC translation, character profiles, parallel provider calls, additional formats, and desktop packaging until after MVP validation.
