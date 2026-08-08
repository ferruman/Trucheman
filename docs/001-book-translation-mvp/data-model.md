# Data Model: Local-First Book Translation MVP

## Conventions

- All persisted records carry `schemaVersion` and use ISO 8601 UTC timestamps.
- IDs are opaque UUIDs except deterministic document, segment, and batch IDs derived within one job.
- Durable state is job-scoped. Secrets are never part of any schema below.
- Job-state replacement is atomic. Append-only batch results and events are validated before they become visible through job state.
- Language values are BCP 47 tags. MVP UI options include `en`, `ru`, `de`, and `pl`.

## ApplicationSettings

Non-secret installation settings stored outside individual jobs.

| Field | Type | Rules |
|---|---|---|
| `schemaVersion` | integer | Starts at `1` |
| `host` | string | Defaults to `127.0.0.1`; non-loopback is outside MVP |
| `port` | integer | Valid local TCP port |
| `profiles.translation` | ProviderProfile | Required |
| `profiles.editing` | ProviderProfile | Required; independently configurable |
| `limits` | ProcessingLimits | Positive bounded values |
| `pricing` | optional PricingSettings | User-entered only; never assumed current |

### ProviderProfile

| Field | Type | Rules |
|---|---|---|
| `provider` | provider adapter ID | `deepseek` in first release |
| `baseURL` | URL | HTTPS by default; sanitized in logs |
| `model` | string | Required and user-configured |
| `hasApiKey` | boolean | Computed for API responses; not persisted as credential data |

### ProcessingLimits

Includes compressed upload bytes, expanded archive bytes, archive entry count, per-entry bytes, context tokens, output tokens, request rate, batch target, retry attempts, and retry delay bounds. Every value must be finite, positive, and capped by a safe application maximum.

## TranslationJob

Aggregate root for one source book and one output language.

| Field | Type | Rules |
|---|---|---|
| `schemaVersion` | integer | Starts at `1` |
| `id` | UUID | Immutable |
| `status` | JobStatus | Must follow state machine below |
| `createdAt`, `updatedAt` | timestamp | `updatedAt >= createdAt` |
| `source` | SourceBook | Immutable except corrected source language |
| `targetLanguage` | language tag | Required; differs from source language |
| `instructions` | string | Optional, bounded length |
| `nameGlossary` | GlossaryEntry[] | Unique normalized source/category pairs |
| `currentStage` | JobStage | Compatible with status |
| `documents` | BookDocument[] | Package reading order; stable after preparation |
| `progress` | JobProgress | Derived from batch states and stored for fast reads |
| `lastError` | optional JobError | Sanitized; no prompt body or secret |
| `validation` | optional ValidationReportSummary | Present after validation attempt |
| `output` | optional OutputArtifact | Only last successful build |

### JobStatus state machine

```text
draft -> preparing -> analyzing_names -> awaiting_name_review -> running
running -> stopping -> paused -> running
running -> needs_attention -> running
running -> validating -> completed
running -> failed
paused -> failed
needs_attention -> failed
```

Rules:

- On process startup, persisted `preparing`, `analyzing_names`, `running`, `stopping`, or `validating` jobs become `paused` with a recovery event.
- Only one job may be in an active processing state.
- `completed` may return to `running` only through an explicit chapter retry or rebuild workflow that retains the previous output until replacement succeeds.
- `failed` is terminal for unrecoverable book-level errors; a new job is required.

### JobStage

`preparation | name_analysis | name_review | translation | editing | validation | building | complete`

### SourceBook

| Field | Type | Rules |
|---|---|---|
| `filename` | string | Display-safe normalized basename |
| `language` | language tag | Detected default, user-correctable |
| `fingerprint` | SHA-256 | Computed from unchanged uploaded bytes |
| `title` | string | From package metadata with filename fallback |
| `packagePath` | relative POSIX path | Resolved through `container.xml` and safety-checked |
| `epubVersion` | `2` or `3` | From package metadata |

## BookDocument

One eligible package-spine document.

| Field | Type | Rules |
|---|---|---|
| `id` | stable document ID | Unique within job |
| `href` | relative POSIX path | Normalized, within extracted job root |
| `manifestId` | string | Original package manifest ID |
| `spineIndex` | integer | Unique, zero-based reading order |
| `title` | string | Navigation/title fallback allowed |
| `linear` | boolean | Preserved from package |
| `status` | DocumentStatus | Derived from its batches |
| `totalBatches` | integer | Non-negative |
| `translatedBatches` | integer | `<= totalBatches` |
| `editedBatches` | integer | `<= translatedBatches` |
| `failedBatches` | integer | Non-negative |

`DocumentStatus`: `pending | translating | translated | editing | edited | failed`

## TextSegment

Stable unit mapped to one source DOM text node or a deterministic subdivision of it.

| Field | Type | Rules |
|---|---|---|
| `id` | stable segment ID | Unique within document and repeatable on resume |
| `documentId` | document ID | Required parent |
| `order` | integer | Strict total order within document |
| `nodeLocator` | deterministic locator | Resolves exactly one eligible source text node |
| `partIndex`, `partCount` | integer | Used only when one node is subdivided |
| `leadingWhitespace`, `trailingWhitespace` | string | Preserved exactly |
| `sourceText` | string | Non-empty after removing preserved surrounding whitespace |
| `sourceHash` | SHA-256 | Detects stale or mismatched results |

## ProcessingBatch

Ordered segments from exactly one document.

| Field | Type | Rules |
|---|---|---|
| `id` | stable batch ID | Unique within job |
| `documentId` | document ID | All segments share it |
| `order` | integer | Strict order within document |
| `segmentIds` | string[] | Non-empty, ordered, unique |
| `translation` | StepState | Draft pass |
| `editing` | StepState | Editing cannot complete before translation |

### StepState

| Field | Type | Rules |
|---|---|---|
| `status` | `pending | running | completed | failed` | Persisted `running` is treated as unfinished on recovery |
| `attempts` | integer | Non-negative and bounded |
| `resultRef` | optional relative path/record offset | Present only for completed verified result |
| `warnings` | ValidationWarning[] | Sanitized and bounded |
| `providerRun` | optional ProviderRun | Persisted for completed attempts |
| `lastError` | optional JobError | Sanitized |

### ProviderRun

Records provider adapter ID, model name, started/completed timestamps, provider request ID when safe, input/output token usage when supplied, and attempt count. It never stores credentials or full prompt/response bodies.

## SegmentResult

Stored separately for the translation and editing passes.

| Field | Type | Rules |
|---|---|---|
| `jobId`, `documentId`, `batchId` | IDs | Must match current manifest |
| `stage` | `translation | editing` | Determines result store |
| `sourceHash` | SHA-256 | Must match batch input |
| `segments` | `{ id, text }[]` | Exactly the expected IDs, once each, in order |
| `providerRun` | ProviderRun | Required |
| `warnings` | ValidationWarning[] | Soft validation only |

An editing result additionally records the draft-result hash used as input. A result is append-only after validation; repetition produces a new revision and updates the batch reference atomically.

## GlossaryEntry

| Field | Type | Rules |
|---|---|---|
| `id` | UUID | Immutable |
| `source` | string | Required, trimmed |
| `target` | string | Required when enabled |
| `category` | `character | place | organization | other` | Required |
| `note` | string | Optional, bounded |
| `enabled` | boolean | Defaults true |
| `aliases` | string[] | Case-insensitive unique values |
| `origin` | `suggested | user` | Informational |

Glossary identity is scoped to `source.language + targetLanguage`. Changing the target language requires explicit invalidation of target forms and downstream results.

## NameAnalysisCheckpoint

Tracks whole-book name analysis independently from translation batches: analysis batch manifest, next pending batch, completed batch hashes, accumulated canonical entries, and last sanitized error. Partial entries survive pause and restart.

## JobProgress

| Field | Type | Invariant |
|---|---|---|
| `totalBatches` | integer | Sum across documents |
| `translatedBatches` | integer | `0..totalBatches` |
| `editedBatches` | integer | `0..translatedBatches` |
| `failedBatches` | integer | Count of currently failed steps |
| `completedSteps` | integer | `translatedBatches + editedBatches` |
| `totalSteps` | integer | `2 * totalBatches` |

Processing percentage is `completedSteps / totalSteps`; a zero-batch book cannot start and reports a preparation error.

## JobEvent

| Field | Type | Rules |
|---|---|---|
| `id` | monotonic integer | Unique within job; supports reconnect |
| `type` | event type string | Stable public contract |
| `timestamp` | timestamp | Required |
| `jobId` | UUID | Required |
| `documentId`, `batchId` | optional IDs | Present for scoped events |
| `stage` | optional JobStage | Present for processing events |
| `message` | string | Human-readable, sanitized, no full book text |
| `data` | bounded object | Only contract-approved fields |

Core event types: `job.created`, `job.state_changed`, `analysis.progress`, `batch.started`, `batch.retrying`, `batch.completed`, `batch.failed`, `validation.completed`, `build.completed`, and `recovery.paused`.

## ValidationReport

| Field | Type | Rules |
|---|---|---|
| `status` | `passed | passed_with_warnings | failed` | Failed blocks replacement output |
| `checks` | ValidationCheck[] | Built-in checks always present |
| `warnings` | ValidationWarning[] | May link document/batch/segment |
| `externalValidator` | optional ExternalValidatorReport | Present only when locally available |
| `createdAt` | timestamp | Required |

Built-in checks cover archive shape, uncompressed `mimetype` placement/value, container and package resolution, manifest resources, spine count/order, changed XML/XHTML parseability, absence of job files and absolute local paths, and presence of edited results for every replaced segment.

## OutputArtifact

| Field | Type | Rules |
|---|---|---|
| `path` | job-relative path | Inside `output/` only |
| `filename` | string | Safe download name |
| `sha256` | string | Required |
| `sizeBytes` | integer | Positive |
| `builtAt` | timestamp | Required |
| `validationStatus` | non-failed validation status | Required |
| `revision` | integer | Increases only after successful replacement |

## On-Disk Aggregate Layout

```text
data/
├── settings.json
├── secrets.env
└── jobs/<job-id>/
    ├── job.json
    ├── source.epub
    ├── source/
    ├── segments/
    │   ├── manifest.json
    │   ├── drafts.ndjson
    │   └── edited.ndjson
    ├── logs/events.ndjson
    ├── output/translated.epub
    └── tmp/
```

Every path loaded from disk or an archive is resolved against an explicit job root and revalidated before access. Temporary writes and builds remain under the same job root and are renamed only after flush, close, and validation.
