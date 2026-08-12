# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Three files, one subject each, and none of them repeats another:

- **`ARCHITECTURE.md`** — how the system works. Read it first; it is the base description of the pipeline, the storage and the boundaries.
- **`AGENTS.md`** — the conventions: structure, style, commit and PR rules. Authoritative for those.
- **this file** — how to run and work on the repository: commands, and the traps that cost an hour if you do not know them.

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

e2e runs on its own port (4174), its own data directory (`test-results/e2e-data`) and `reuseExistingServer: false`, so it neither reuses nor disturbs a dev server on 4173. Both can run at once.

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
npm run trace:segment -- data/jobs/<id> <segment-id>  # free; one block's source→draft→edit→audit→repair→final
npm run report:models                                 # free; cost and quality per model, read from finished jobs
```

`eval:literary` over the whole corpus enforces `minPassRate` from `evals/literary-editor/cases.json` and exits non-zero below it; a `--limit` or `--offset` run only samples, so it reports the rule as unenforced instead of failing.

`epubcheck` is optional — `runOptionalEpubCheck` and `scripts/check-epub.mjs` both treat `ENOENT` as a pass, so its integration test asserts both branches and the pipeline gate simply does nothing when it isn't installed. It writes its findings to **stderr**; stdout carries only the summary. The test fixtures are deliberately minimal and do not pass EPUBCheck (their `container.xml` omits the rootfile media type), so a pipeline run over a fixture legitimately reports conformance errors.

## Architecture

**`ARCHITECTURE.md` is the description of this system and the file to read first.** It covers the request → job flow, the job state machine, every stage of the translation pipeline, the storage layout and its durability rules, checkpointing and invalidation, providers and their retry semantics, secrets, and the EPUB security boundaries. Keep it current: a change that alters any of those belongs in that file, in the section it belongs to, not in a second description here.

The invariants worth knowing before you touch anything, each explained there in full:

- `src/shared/domain/job.ts` owns the legal status transitions; `toJobView` is the only projection the browser ever sees.
- One job runs process-wide (a single-slot `Scheduler`), and pause is `AbortController.abort()`.
- `checkpointKey` decides what a rerun pays for again, so `PROMPT_VERSION` / `PROMPT_INPUT_VERSION` must be bumped when prompt text changes semantically.
- State writes go through `atomic-file.ts`, journals through `ndjson-journal.ts`, and user-derived paths through `safeJobPath` / `resolveEpubPath`. Do not bypass them.

## Testing layout

See the Testing section of `ARCHITECTURE.md` for how the suites are split and what generates the EPUB fixtures. The one thing that lives only here: run a focused test with the commands above rather than adding `.only`.
