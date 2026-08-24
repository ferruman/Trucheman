# Trucheman Product Requirements

**Version:** 1.0 (local-first MVP)  
**Status:** Ready for implementation  
**Primary user:** Owner of a local installation

## 1. Product summary

Trucheman is a local web application for translating DRM-free EPUB books through an external language-model API. The first pass creates a complete draft translation. The second pass edits every draft against the original, correcting meaning, language, style, and glossary consistency. The application preserves EPUB structure, markup, images, links, footnotes, and service files; proposes a glossary of proper names; shows durable progress; and resumes unfinished work after interruption.

The application runs on the user's computer and is opened in a desktop browser. It has no accounts, cloud storage, public deployment, collaboration, or online job queue.

The north-star result is an EPUB in the selected target language that opens in a conventional reader as a complete, readable book. The primary acceptance pair is English to Russian; German to Polish is the secondary pair.

## 2. Goals and principles

The MVP must:

- complete long translations reliably even when the process or provider temporarily fails;
- preserve the original source and never lose verified work;
- give the user control over names, terminology, and shared instructions;
- remain simple to install and operate on one computer;
- treat only successfully translated and edited text as final output;
- make external content transfer explicit before processing;
- keep credentials, full request bodies, and full book text out of ordinary state, logs, events, and browser assets.

Local-first does not mean fully offline. Files and state remain local, but eligible book text is sent to the selected external provider during processing.

## 3. Scope

### Included

- EPUB 2 and EPUB 3 import without DRM.
- BCP 47 language selection with English (`en`), Russian (`ru`), German (`de`), and Polish (`pl`) included initially.
- Reading order derived from `container.xml`, the package document, manifest, and spine.
- Text-node extraction and reinsertion without asking the model to preserve markup.
- Proper-name analysis, editable glossary entries, and shared translation/editing instructions.
- Separate translation and editing passes with deterministic fake-provider tests and a configurable DeepSeek-compatible provider.
- Durable per-batch checkpoints, pause/resume, recovery after restart, bounded retries, sanitized events, validation, rebuild, and download.
- A local filesystem-backed job list and desktop-oriented browser interface.

### Excluded from the MVP

- Accounts, roles, synchronization, cloud storage, and public deployment.
- PDF, DOCX, MOBI, AZW, DRM-protected EPUB, and local model inference.
- Payments, automatic billing, simultaneous book processing, and parallel provider requests.
- Full CAT editing, automatic dialogue attribution, character voice profiles, and collaboration.
- Translation of navigation labels, table-of-contents labels, title, and author metadata; these remain unchanged unless explicitly added later.

## 4. Primary user flow

1. The user starts the application with one command and opens the loopback URL, normally `http://127.0.0.1:4173`.
2. The user configures translation and editing provider profiles. Credentials come from a server-only local secret source and are never entered into job state.
3. The user selects an EPUB. The application creates a job-scoped copy, checks the archive, discovers the package and reading order, and extracts eligible text.
4. The application proposes proper-name glossary entries. The user may edit, enable, disable, add, or remove entries and may enter shared instructions.
5. The user starts processing. For each chapter, all translation batches finish before that chapter's editing pass begins.
6. The application stores every verified draft and edit immediately, updates durable progress, and emits only sanitized events.
7. A pause request stops new requests, allows the in-flight request to finish, and persists a safe paused state. A restart converts stale active jobs to paused.
8. Temporary errors use bounded retries. Permanent configuration errors and exhausted retries move the job to `needs_attention` without deleting verified work.
9. After all edits are complete, the application reinserts edited text only, builds a revisioned EPUB, validates it, and promotes the new output atomically.
10. The user reviews validation evidence and statistics and downloads the latest successful artifact.

## 5. User interface

### Job list

Show title, language pair, date, lifecycle status, stage, progress, and actions to open, continue, or delete after confirmation. The list remains usable when the provider is unavailable.

### New book

Provide an EPUB picker, source-language proposal with correction, target-language selection, and a clear rejection for identical source and target languages. Start analysis immediately after import.

### Glossary

Show source term, proposed target, category, note, enabled state, alias relationship, and editable instructions. The page must disclose that book text is sent to the selected external provider before processing begins.

### Progress

Show the current stage, current chapter, overall two-pass progress, translated/edited/total/failed counters, chapter statuses, warnings, recent sanitized events, and pause/resume/retry actions. Closing the browser must not change backend state.

### Result

Show validation status, blocking errors, document-linked warnings, translated and edited counts, retries, elapsed time, provider usage, optional user-priced cost estimate, chapter retry, rebuild, and download actions.

## 6. Functional requirements

### Import and EPUB safety

- Accept one DRM-free EPUB 2 or EPUB 3 per job and reject malformed, encrypted, oversized, unsafe, or unsupported archives before provider processing.
- Preserve the uploaded source unchanged and operate only on a private job copy.
- Reject absolute paths, parent traversal, backslashes, duplicate normalized paths, symlink entries, unsupported compression, encryption, excessive entry counts, excessive compressed bytes, excessive single-entry expansion, and excessive total expansion.
- Use streaming/bounded ZIP operations and clean the private staging root after failed extraction.
- Resolve package documents and reading order from declared EPUB structure rather than filename sorting.
- Preserve non-translated resources, paths, identifiers, styles, images, links, footnotes, and reading-order document count.

### Text extraction and reinsertion

- Extract only eligible visible text nodes from reading-order documents.
- Exclude scripts, styles, code, preformatted content, mathematics, SVG path data, URLs, binary data, service identifiers, whitespace-only nodes, and explicitly non-translatable elements.
- Assign stable IDs, structural child-index locators, source hashes, and leading/trailing whitespace metadata.
- Batch text within a configurable request budget and subdivide unusually long text at language-aware boundaries.
- Send ordered `{id,text}` segments to the provider. Never send markup as a responsibility delegated to the model.
- Re-resolve locators and verify source hashes before reinsertion. Change text data only; do not replace elements or attributes.

### Languages, glossary, and instructions

- Store language values as BCP 47 tags and reject identical source and target languages.
- Analyze the whole book in resumable batches and deduplicate names case-insensitively while retaining aliases and categories.
- Persist partial analysis and resume at the first missing analysis batch.
- Include globally mandatory and locally relevant enabled glossary entries plus shared instructions within each request budget.
- Require explicit confirmation before a target-language or glossary change invalidates completed work.

### Translation and editing

- Use independent configurable provider profiles for translation and editing.
- Complete every chapter's translation batches before editing that chapter.
- Store draft and edited results separately. Only validated edited results can enter the normal final build.
- Validate response shape, non-empty output, exact ordered IDs, duplicate/missing/extra IDs, refusal text, truncation, and safe reinsertion.
- Record soft warnings for suspicious length, residual source language, glossary violations, repetition, and provider boilerplate without silently discarding structurally valid work.
- Record the producing profile, model, usage, attempts, and warnings for each completed step.

### Reliability and lifecycle

- Write every verified result to a newline-delimited journal, flush it, and atomically update state afterward.
- Support `created`, `analyzing`, `ready`, `running`, `stopping`, `paused`, `needs_attention`, `completed`, and `failed` states with legal transitions only.
- Allow one active book job and one provider request at a time in the MVP.
- Use bounded exponential retry with jitter and provider retry guidance for temporary failures, timeouts, rate limits, invalid structured output, and server errors.
- Treat credential, endpoint, model, invalid-parameter, and other permanent configuration failures as actionable errors without indefinite retries.
- Retain verified work when retries are exhausted and allow targeted batch/chapter retry.
- Require confirmation before deleting exactly one job root, including its source, journals, state, logs, and outputs.

### Output and validation

- Reinsert only validated edited text into a working copy.
- Set the target book language where supported without changing unrelated metadata.
- Build under a unique temporary/revisioned name with stored `mimetype` as the first ZIP entry and promote only after validation.
- Mandatory validation must cover archive packaging, required files, package and manifest references, spine resolution, resource presence, changed XML/XHTML parsing, result completeness, and absence of local state paths.
- Optional local EPUBCheck may add evidence, but its absence must not block the built-in result.
- Keep the previous successful artifact available until a replacement build passes.

### Local API

| Method       | Path                          | Purpose                                     |
| ------------ | ----------------------------- | ------------------------------------------- |
| GET          | `/api/health`                 | Local server health                         |
| GET/PUT      | `/api/settings`               | Read or update non-secret provider settings |
| POST         | `/api/settings/test`          | Test provider configuration                 |
| GET/POST     | `/api/jobs`                   | List or create jobs                         |
| GET/PUT/POST | `/api/jobs/:id`               | Read, configure, or start a job             |
| POST         | `/api/jobs/:id/names/analyze` | Start or resume name analysis               |
| POST         | `/api/jobs/:id/pause`         | Safely pause processing                     |
| POST         | `/api/jobs/:id/retry`         | Retry failed scope                          |
| POST         | `/api/jobs/:id/rebuild`       | Rebuild and validate output                 |
| GET          | `/api/jobs/:id/events`        | Replay and stream sanitized SSE events      |
| GET          | `/api/jobs/:id/download`      | Download the latest successful EPUB         |
| DELETE       | `/api/jobs/:id`               | Delete one confirmed job                    |

SSE is a convenience layer. Persisted REST state remains authoritative. On reconnect the client refreshes job state and resumes event replay using `Last-Event-ID`.

## 7. Privacy and configuration

The server binds to `127.0.0.1` by default. Credentials are loaded only on the server from `.env.local` or a future secret-store adapter. Browser settings expose only `hasApiKey` flags. Credentials and full prompts must not appear in `job.json`, journals, events, logs, HTTP responses, frontend bundles, or output EPUBs. Provider errors are sanitized before persistence and display.

Model names, endpoints, aliases, and prices are settings, not source constants. Translation and editing profiles remain independent even when both use the same provider.

## 8. Non-functional requirements

- The application remains responsive during processing.
- Large books are processed by document and batch without loading the entire book and all results into memory at once.
- Atomic state, journal, and output operations tolerate abrupt process termination.
- Path and filesystem behavior is covered for macOS, Windows, and Linux semantics where practical.
- The browser interface is keyboard usable, labeled, readable on desktop, and provides status announcements for progress and errors.

## 9. Acceptance criteria

1. A representative EPUB with text, CSS, an image, an internal link, and a footnote completes both passes and opens in a conventional reader.
2. Every eligible final segment has a separately stored validated draft and edit; only edits appear in the final EPUB.
3. Reading-order documents, images, styles, links, footnotes, and untouched resources remain intact.
4. Pause, restart, and resume never repeat verified provider requests.
5. Rate limits, timeouts, empty output, malformed JSON, and permanent provider errors follow the bounded retry and recovery policy.
6. Sentinel credentials and full request bodies are absent from job state, logs, events, browser assets, HTTP responses, and output archives.
7. Unsafe and malformed EPUB fixtures are rejected before external processing.
8. A failed replacement build never removes the previous successful artifact.
9. English-to-Russian and German-to-Polish deterministic acceptance runs use the same pipeline and require only settings/language changes.

## 10. Delivery plan

1. Complete setup and foundational contracts.
2. Prove deterministic EPUB extraction, two-pass translation/editing, round trip, validation, and download.
3. Add the configurable provider and secret-isolation checks.
4. Add pause/resume, crash recovery, retry, SSE, and targeted failure recovery.
5. Add result reports, statistics, chapter repetition, rebuild retention, accessibility, performance, cross-platform fixtures, and recorded quickstart evidence.

Future work may include navigation and metadata translation, additional provider adapters, controlled parallelism, style profiles, character profiles, and desktop packaging.
