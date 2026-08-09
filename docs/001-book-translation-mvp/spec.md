# Feature Specification: Local-First Book Translation MVP

**Feature Branch**: `main`

**Created**: 2026-08-08

**Status**: Ready for implementation

**Input**: Product requirements in `docs/book-translator-prd.md` for a local-first EPUB translation application.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Produce a readable translated EPUB (Priority: P1)

As the owner of a local installation, I want to select a DRM-free EPUB, choose its source and target languages, review the automatically proposed proper-name glossary, and run translation plus editing so that I receive a readable translated EPUB without manually reconstructing the book.

**Why this priority**: This is the north-star outcome and the smallest product increment that proves the application has value.

**Independent Test**: Import a representative EPUB containing text, CSS, an image, an internal link, and a footnote; accept or amend the name glossary; run the full two-pass workflow; then open and read the downloaded result in a conventional EPUB reader.

**Acceptance Scenarios**:

1. **Given** a valid DRM-free EPUB and a configured language pair, **When** the user imports the book, **Then** the application validates it, discovers its reading order, and prepares only eligible visible text for processing.
2. **Given** a successfully prepared book, **When** name analysis completes, **Then** the user can review, edit, enable, disable, add, or remove glossary entries before translation starts.
3. **Given** a reviewed glossary and optional instructions, **When** the user starts processing, **Then** every eligible fragment is translated and separately edited against the original before it is eligible for the final book.
4. **Given** all required fragments have passed both processing steps, **When** the application builds the result, **Then** it preserves reading order, markup structure, styles, images, links, footnotes, and non-text resources.
5. **Given** a successfully built and validated result, **When** the user downloads it, **Then** the file opens in a conventional reader and identifies the target language.

---

### User Story 2 - Configure the external language service safely (Priority: P2)

As the installation owner, I want to configure and test the external language service used for translation and editing while keeping secrets out of book jobs, logs, events, exports, and browser-delivered application files.

**Why this priority**: The primary flow depends on a working external service, and accidental secret disclosure would make the local tool unsafe to use.

**Independent Test**: Save non-secret service settings, provide a secret through the supported local secret mechanism, run the connection test, and inspect all persisted job files, events, logs, and downloadable assets for secret leakage.

**Acceptance Scenarios**:

1. **Given** valid service settings and credentials, **When** the user tests the configuration, **Then** the application reports a successful connection without revealing the credential.
2. **Given** an invalid endpoint, unavailable model, or rejected credential, **When** the user tests or starts processing, **Then** the application reports an actionable configuration error and does not retry indefinitely.
3. **Given** any completed or failed job, **When** its persisted state, logs, event stream, output, and browser-delivered files are inspected, **Then** no service credential or full request body is present.
4. **Given** the user is about to submit book content, **When** the workflow reaches external processing, **Then** the interface clearly states that book text is sent to the selected external provider.

---

### User Story 3 - Pause and resume without paying twice (Priority: P3)

As a user translating a long book, I want to pause safely, close and restart the application, and resume from the first unfinished step so that completed translation and editing work is not lost or purchased again.

**Why this priority**: Long-running processing is only practical when interruptions do not corrupt the job or repeat paid work.

**Independent Test**: Pause during translation and during editing, terminate the application after several completed batches, restart it, and verify that only unfinished steps generate new external requests.

**Acceptance Scenarios**:

1. **Given** an active job, **When** the user requests a pause, **Then** no new external request starts, the current request may finish, and its verified result and job state are saved before the job becomes paused.
2. **Given** the application stops while a job is marked active, **When** it starts again, **Then** the job is presented as paused rather than falsely active.
3. **Given** a paused or interrupted job with completed translation or editing batches, **When** the user resumes, **Then** processing begins at the first unfinished step and completed steps are not repeated.
4. **Given** glossary changes after processing has started, **When** the user saves them, **Then** the application explains that completed work is unchanged and requires explicit confirmation before invalidating or repeating selected work.

---

### User Story 4 - Understand progress and recover from failures (Priority: P4)

As a user, I want to see the current stage, chapter-level progress, recent safe events, warnings, and failures, and I want to retry failed work after correcting a problem.

**Why this priority**: External processing can be slow and unreliable; transparent progress and controlled recovery keep the workflow understandable and operable.

**Independent Test**: Run a multi-chapter fixture while injecting a temporary rate limit, a timeout, malformed responses, and a permanent configuration error; verify progress, retries, terminal states, and targeted retry behavior.

**Acceptance Scenarios**:

1. **Given** an active job, **When** the user views it, **Then** the interface shows overall two-pass progress, current stage, current chapter, chapter statuses, counts for translated, edited, total, and failed batches, and recent sanitized events.
2. **Given** a temporary provider failure, **When** a request fails, **Then** the application retries a bounded number of times with delay and honors provider retry guidance when available.
3. **Given** malformed, incomplete, or unsafe model output, **When** validation fails, **Then** the result is not persisted as complete and the request follows the bounded retry policy.
4. **Given** retries are exhausted, **When** the job needs user action, **Then** it retains all verified work, identifies the failed scope, and offers a targeted retry after settings are corrected.
5. **Given** the live update connection is interrupted, **When** the interface reconnects, **Then** it refreshes from persisted job state and continues from the last known event without changing processing state.

---

### User Story 5 - Validate, inspect, and rebuild the result (Priority: P5)

As a user, I want the application to validate the output, show warnings and processing statistics, and let me retry a chapter or rebuild the EPUB so that I can confidently keep the final artifact.

**Why this priority**: A generated archive is not a useful result until its integrity is verified and the user can act on localized problems.

**Independent Test**: Complete a fixture job, inspect its validation report and statistics, repeat one selected chapter, rebuild, and confirm the prior successful output remains available until the replacement build succeeds.

**Acceptance Scenarios**:

1. **Given** all fragments are edited, **When** the final book is built, **Then** mandatory archive, package, manifest, reading-order, resource, and changed-document checks run before download is offered.
2. **Given** non-blocking anomalies, **When** validation completes, **Then** the user sees warnings associated with the relevant chapter or document.
3. **Given** a completed job, **When** the user views its result, **Then** the interface reports translated and edited fragment counts, retry count, elapsed time, and approximate usage based on provider-reported usage.
4. **Given** a selected chapter is repeated, **When** the replacement work and build succeed, **Then** the output reflects the new verified edits; if rebuilding fails, the previous successful output is not overwritten.

### Edge Cases

- The uploaded file has an `.epub` extension but is not a valid ZIP archive, lacks the package document, is encrypted with DRM, exceeds configured compressed or expanded limits, contains unsafe paths, or expands suspiciously.
- The package contains EPUB 2 or EPUB 3 navigation variants, non-linear spine items, nested paths, namespaces, unusual but valid resource names, or unsupported content documents.
- An eligible text node is empty, whitespace-only, extremely long, split across inline elements, marked as non-translatable, or located inside code, preformatted, script, style, or mathematical content.
- The external service returns an empty body, truncated data, invalid structured output, missing or additional segment identifiers, refusal text, duplicated prose, unchanged source-language text, or a result whose length is suspicious.
- Name analysis is paused partway through a large book, encounters variant capitalization or aliases, or produces a glossary too large to include in every request.
- The source and target languages are identical, the detected language is wrong, or the target language changes after glossary or translation work already exists.
- The browser tab closes while processing continues, the live event connection drops, or the application process terminates during a state write or final build.
- A rebuild fails after a previously valid translated EPUB already exists.
- A job is deleted while intermediate and output files exist; deletion requires confirmation and is scoped to exactly that job.

## Requirements _(mandatory)_

### Functional Requirements

#### Book import and preparation

- **FR-001**: The system MUST accept one DRM-free EPUB 2 or EPUB 3 book per job and MUST reject unsupported, malformed, encrypted, oversized, or unsafe archives before external language processing begins.
- **FR-002**: The system MUST preserve the uploaded source unchanged and work only on a job-scoped copy.
- **FR-003**: The system MUST determine the package document and reading order from the EPUB's declared structure rather than filename sorting.
- **FR-004**: The system MUST identify eligible reading-order content documents and preserve all non-translated resources, paths, links, identifiers, styles, images, and footnotes.
- **FR-005**: The system MUST extract only visible, eligible text while excluding scripts, styles, code, preformatted content, mathematical content, binary data, URLs, service identifiers, and explicitly non-translatable elements.
- **FR-006**: The system MUST assign stable local identifiers to extracted segments and retain enough information to reinsert text without changing unrelated elements or attributes.
- **FR-007**: The system MUST divide eligible text into bounded, ordered batches within a single document and MUST handle unusually long text using language-aware boundaries.

#### Languages, glossary, and instructions

- **FR-008**: The user MUST be able to select different source and target languages represented by standard language tags; the initial list MUST include English, Russian, German, and Polish without making the processing workflow language-specific.
- **FR-009**: The system MUST propose a source language while allowing the user to correct it and MUST reject an identical source/target pair.
- **FR-010**: Before translation, the system MUST analyze the whole book in resumable batches and propose a deduplicated glossary of characters, places, organizations, and other proper names for the selected language pair.
- **FR-011**: The user MUST be able to add, remove, edit, enable, or disable glossary entries and enter optional instructions shared by translation and editing.
- **FR-012**: The system MUST persist partial name-analysis results and resume at the first unprocessed analysis batch.
- **FR-013**: The system MUST obtain explicit confirmation before a target-language change clears proposed name translations and invalidates translation or editing results.
- **FR-014**: Each processing request MUST receive the confirmed globally mandatory and locally relevant glossary entries plus the user's instructions within the configured request budget.

#### Translation and editing

- **FR-015**: The system MUST send and receive an ordered collection of segment identifiers and text, and MUST NOT delegate markup preservation to the language model.
- **FR-016**: The system MUST complete draft translation for all batches of a chapter before beginning that chapter's editing pass.
- **FR-017**: The editing pass MUST compare original segments with draft translations and MUST correct meaning, grammar, vocabulary, punctuation, unnatural phrasing, style, and glossary consistency without unauthorized omission, summary, censorship, or invention.
- **FR-018**: Draft and edited results MUST be stored separately for every batch; only successfully validated edited text is eligible for normal final assembly.
- **FR-019**: Translation and editing MUST have independently configurable provider profiles, while each completed step records which profile produced it.
- **FR-020**: The system MUST reject and retry responses that fail the response shape, exact-identifier, non-empty-result, safe-reinsertion, refusal, or truncation checks.
- **FR-021**: The system MUST record non-blocking warnings for suspicious length, residual source language, glossary violations, repetition, or service boilerplate without silently discarding otherwise structurally valid work.

#### Reliability and lifecycle

- **FR-022**: The system MUST persist each verified draft and edit immediately and MUST update job state atomically so completed work survives abrupt process termination.
- **FR-023**: A pause request MUST stop scheduling new external requests, allow an in-flight request to finish, persist its verified result, and transition through a safe stopping state to paused.
- **FR-024**: On startup, the system MUST convert jobs left in an active state to paused and MUST resume only unfinished translation or editing steps when the user continues them.
- **FR-025**: Temporary service failures MUST use bounded delayed retries and provider retry guidance; authentication, endpoint, and model-configuration failures MUST stop without indefinite retries.
- **FR-026**: Exhausted batch retries MUST place the job in a state requiring attention without losing verified results, and the user MUST be able to retry the failed batch or chapter.
- **FR-027**: The system MUST run no more than one book job and one external request at a time in the MVP.
- **FR-028**: The user MUST be able to delete a job only after confirmation; deletion MUST remove exactly that job's source copy, state, intermediate results, logs, and outputs.

#### Progress, result, and validation

- **FR-029**: The system MUST provide a persistent job list and job detail showing title, language pair, date, lifecycle status, current stage, overall two-pass progress, current chapter, chapter statuses, batch counts, failures, and recent sanitized events.
- **FR-030**: Closing the browser or losing the live update connection MUST NOT pause or alter backend processing; after reconnection the interface MUST refresh from persisted state.
- **FR-031**: The system MUST reinsert only validated edited text into a working copy, preserve the EPUB structure and untouched resources, update the book language, and create the result without overwriting an earlier successful result until the replacement succeeds.
- **FR-032**: Before download, the system MUST verify required archive files, resolvable package/manifest/reading-order entries, unchanged reading-order document count, parsable changed XML/XHTML, absence of local absolute paths and job-state files, and normal EPUB packaging constraints.
- **FR-033**: If a compatible local industry validator is available, the system SHOULD include its report as an additional check; its absence MUST NOT by itself block the MVP result.
- **FR-034**: The result view MUST show validation status and document-linked warnings plus translated/edited counts, retries, elapsed time, provider-reported usage, and an optional cost estimate based only on user-supplied pricing.
- **FR-035**: The user MUST be able to repeat selected failed work or a chapter, rebuild the output, and download the latest successful EPUB.

#### Configuration, privacy, and local operation

- **FR-036**: The application MUST run as a local single-user service, listen only on the local machine by default, and serve a desktop-oriented browser interface.
- **FR-037**: The user MUST be able to configure non-secret provider settings for translation and editing, supply credentials through a separate local secret mechanism, and run a short connection test.
- **FR-038**: Credentials MUST NOT appear in browser-delivered application files, job state, ordinary logs, events, exports, or output books; displayed configuration MUST reveal only whether a credential exists.
- **FR-039**: The interface MUST disclose before processing that book text is sent to the selected external service.
- **FR-040**: Ordinary logs and user-visible events MUST exclude full source/translated book text and MUST sanitize provider errors that may contain credentials or request bodies.
- **FR-041**: The job list and existing job details MUST remain usable when the external provider is unavailable.

### Key Entities

- **Application Settings**: Non-secret local defaults, supported languages, translation and editing provider profiles, request budgets, retry limits, upload limits, optional user-entered pricing, and per-profile credential-presence flags.
- **Translation Job**: A single source book and language pair with lifecycle status, current stage, instructions, glossary, document inventory, progress, error state, output reference, and timestamps.
- **Book Document**: A reading-order content document with stable identity, original path, display title, processing status, and batch totals.
- **Text Segment**: A stable local identifier linked to eligible source text and its reinsertion location, including preserved surrounding whitespace and ordering.
- **Processing Batch**: An ordered group of segments from one document with independent translation and editing status, attempts, warnings, usage, and producing profile metadata.
- **Draft Translation**: A validated first-pass result keyed by the exact source segment identifiers.
- **Edited Translation**: A validated second-pass result keyed by the same identifiers and eligible for final assembly.
- **Glossary Entry**: A language-pair-specific source term, target form, category, optional note, enabled state, and optional alias relationship.
- **Job Event**: A sequential, timestamped, sanitized status or progress record used by the interface and reconnecting clients.
- **Validation Report**: Build outcome, blocking failures, non-blocking warnings, affected documents, and optional external-validator results.
- **Output Artifact**: The most recent successfully built translated EPUB and its summary statistics; replacement is atomic.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A representative DRM-free EPUB containing text, CSS, an image, an internal link, and a footnote completes both language-processing passes and opens as a readable book in a conventional EPUB reader.
- **SC-002**: For 100% of eligible final segments, a separately stored validated draft and validated edited result exist, and only the edited result appears in the normal final build.
- **SC-003**: On the acceptance fixture, 100% of original reading-order documents, images, styles, internal links, footnotes, elements, and attributes remain present except for explicitly permitted language metadata and text-node changes.
- **SC-004**: After a pause or forced restart at any completed batch boundary, 100% of verified completed translation and editing steps are reused and generate no duplicate external request on resume.
- **SC-005**: Temporary rate-limit, server, timeout, empty-response, and malformed-response scenarios follow bounded retries; a persistent failure reaches the user-action-required state without loss of previously verified work.
- **SC-006**: No provider credential or full book/request text is found in persisted job state, ordinary logs, live events, browser-delivered assets, or the output EPUB during acceptance inspection.
- **SC-007**: Unsafe, malformed, encrypted, or configured-limit-exceeding EPUB fixtures are rejected before any book text is sent externally.
- **SC-008**: During active work, progress reflects both required passes, so completion of translation alone never reports more than 50% of batch-processing work complete.
- **SC-009**: The complete acceptance flow succeeds for English to Russian and repeats for German to Polish without application changes; only job settings and service instructions differ.
- **SC-010**: Existing jobs and their details open successfully while the external language service is unavailable.
- **SC-011**: A user can identify the current stage, chapter, failed scope, and next available recovery action from the job screen without inspecting local files.
- **SC-012**: A failed rebuild leaves the previous successful output downloadable in 100% of tested rebuild-failure cases.

## Assumptions

- The MVP is a personal, local-first application with one owner, no accounts, roles, synchronization, collaboration, public deployment, remote queue, or simultaneous multi-book processing.
- Book files and job state remain local, but internet access is required while text is processed by the selected external provider.
- The first required real-world operating-system target is the developer's current desktop environment; cross-platform file/path behavior is designed in from the start and additional operating systems are validated after the first end-to-end target.
- Navigation document, table-of-contents labels, title, and author may remain in the source language for the MVP as long as navigation remains functional.
- Built-in structural validation is mandatory; a locally installed industry validator adds evidence but is not a prerequisite for producing the MVP output.
- The first secret-storage mechanism may use a protected local environment file; a system credential store can replace it without changing job data or user flows.
- The currently available external model is selected in local settings and is never treated as a fixed product constant.
- PDF, DOCX, MOBI, AZW, DRM removal, local model inference, automatic billing, character voice profiles, full-book visual editing, and mobile-first interaction are outside MVP scope.
- Automated unit, integration, contract, recovery, security, and EPUB fixture tests are required because the PRD explicitly makes crash safety, archive integrity, and secret isolation acceptance conditions.
