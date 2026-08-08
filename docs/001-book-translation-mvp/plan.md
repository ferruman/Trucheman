# Implementation Plan: Local-First Book Translation MVP

**Branch**: `main` (feature context `001-book-translation-mvp`) | **Date**: 2026-08-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/docs/001-book-translation-mvp/spec.md`

## Summary

Build a local single-user web application that safely imports a DRM-free EPUB, extracts eligible XML text, proposes a user-editable proper-name glossary, translates every batch, edits every draft against the original, checkpoints each verified step, validates and rebuilds the EPUB, and exposes progress/recovery through a desktop browser UI. The implementation is one Node.js/TypeScript process with an Express API and React/Vite client, filesystem-backed jobs, a narrow provider adapter, bounded streaming ZIP operations, namespace-aware DOM transformations, and deterministic contract/integration/security fixtures.

## Technical Context

**Language/Version**: Node.js 24 LTS; TypeScript ~6.0; modern evergreen desktop browsers

**Primary Dependencies**: Express 5.2, React/React DOM 19.2, Vite 8.2, Zod 4.4, Busboy 1.6, yauzl 3.4, yazl 3.3, @xmldom/xmldom 0.9; built-in fetch, Node streams, `Intl.Segmenter`, crypto, and filesystem APIs

**Storage**: Local versioned JSON state, append-only NDJSON draft/edit/event journals, safely extracted job workspaces, revisioned EPUB outputs, and a separate gitignored local environment file for credentials

**Testing**: Vitest 4 for unit/contract/integration tests, React Testing Library with jsdom for components, Playwright for browser end-to-end flows, real HTTP servers on `127.0.0.1:0`, deterministic provider stubs, EPUB 2/3/security fixtures, optional EPUBCheck integration

**Target Platform**: First acceptance target macOS desktop; cross-platform Node filesystem behavior for Windows and Linux; server bound to `127.0.0.1` only by default

**Project Type**: Local-first web application delivered by one server process and one same-origin browser client

**Performance Goals**: UI remains responsive during processing; import and job reads avoid loading whole books/results into memory; one external request at a time; progress updates appear within one event/reconnect cycle; no completed batch is recomputed on ordinary resume

**Constraints**: Local files and state with external LLM calls; no database, remote queue, accounts, or DRM; bounded archive/XML/request sizes; atomic checkpoints and output promotion; exact segment-ID contracts; secrets and full book text excluded from ordinary telemetry; final output requires both passes

**Scale/Scope**: One installation owner, one active book, one provider request, four main screens, EPUB 2/3 content, initial `en/ru/de/pl` language options, potentially hundreds of chapters and thousands of batches per job

## Constitution Check

The repository constitution is still the unratified template and defines no enforceable project-specific gates. Until it is ratified, the PRD establishes these interim gates:

- **Safety**: untrusted archives, XML, filenames, provider responses, and API input are bounded and validated before use. **PASS** — explicit security boundaries and fixtures are defined.
- **Recoverability**: verified paid work is durably committed per batch, and outputs are promoted only after validation. **PASS** — persistence commit ordering and revisioned outputs are defined.
- **Two-pass integrity**: drafts never enter the normal final build without a verified edit. **PASS** — separate result stores and state invariants enforce it.
- **Secret isolation**: credentials remain server-only and outside job/log/event/output schemas. **PASS** — separate environment loading and sentinel scans are designed.
- **Provider/language independence**: core pipeline depends on internal contracts, not a fixed SDK, model, or language pair. **PASS** — adapters, BCP 47 values, and configurable token estimates are designed.
- **Test evidence**: unit, contract, integration, recovery, security, and fixture acceptance tests are part of the feature. **PASS** — test layers and quickstart scenarios are specified.

**Post-design re-check**: PASS. The data model, API contract, and quickstart preserve every interim gate without an exception requiring complexity justification.

## Project Structure

### Documentation (this feature)

```text
docs/001-book-translation-mvp/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── openapi.yaml
└── tasks.md
```

### Source Code (repository root)

```text
src/
├── server/
│   ├── api/                 # Express routes, problem responses, SSE
│   ├── config/              # Environment/settings validation
│   ├── domain/              # Job state machine and progress invariants
│   ├── epub/                # Archive, package, DOM, segment, build, validation
│   ├── jobs/                # Runner, scheduling, recovery, retry, pause
│   ├── providers/           # Provider interface and DeepSeek adapter
│   ├── storage/             # Atomic JSON, journals, job paths, repositories
│   ├── app.ts               # Express composition without listening
│   └── index.ts             # Config load, recovery, loopback listener
├── client/
│   ├── app/                 # Routing, shell, API/event clients
│   ├── components/          # Shared accessible UI primitives
│   ├── features/jobs/       # List, create, glossary, progress, result
│   ├── features/settings/   # Provider settings and connection test
│   ├── styles/              # Tokens and global desktop-first layout
│   └── main.tsx
└── shared/
    ├── api/                 # Request/response/event schemas and types
    ├── domain/              # Shared enums and safe view models
    └── languages.ts

tests/
├── unit/                    # Pure domain, schemas, prompts, validators
├── contract/                # API and provider contract tests
├── integration/             # Filesystem, EPUB, HTTP/SSE, recovery
├── e2e/                     # Browser workflows
├── fixtures/
│   ├── epub/                # EPUB 2/3, round-trip, malformed, hostile
│   └── provider/            # Deterministic provider responses/failures
└── helpers/                 # Temp roots, fake clock, provider stub, inspectors

scripts/
└── check-epub.mjs           # Optional local EPUBCheck discovery/adapter
```

**Structure Decision**: Use one npm/TypeScript project with clearly separated `server`, `client`, and `shared` modules. Express owns one listener and embeds Vite middleware in development; production serves the built client. Domain and EPUB/provider/storage code remain independent from HTTP and React so recovery and archive behavior can be tested without a browser.

## Phase 0: Research Outcomes

The detailed decisions and official source links are in [research.md](research.md). All planning questions are resolved:

- macOS is the first acceptance target with cross-platform path design;
- the provider model name is user-configured and never hard-coded;
- navigation/TOC labels and descriptive metadata remain untranslated in MVP;
- built-in structural validation is mandatory and EPUBCheck is optional;
- `.env.local` is the first server-only secret source behind a replaceable boundary;
- streaming ZIP safety uses yauzl/yazl with explicit product limits;
- XML processing uses strict namespace-aware DOM equivalence rather than lexical byte preservation.

## Phase 1: Design Outcomes

- [data-model.md](data-model.md) defines persisted aggregates, invariants, state transitions, commit ordering, and output promotion.
- [contracts/openapi.yaml](contracts/openapi.yaml) defines the loopback REST/SSE surface and sanitized error shapes.
- [quickstart.md](quickstart.md) defines deterministic end-to-end, crash recovery, archive security, secret isolation, and live-provider acceptance evidence.

## Complexity Tracking

No constitution violations or exceptional complexity are currently required.
