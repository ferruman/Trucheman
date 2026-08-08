# Quickstart Validation Guide: Local-First Book Translation MVP

This guide defines the runnable evidence expected from the implementation. It is not an implementation tutorial.

## Prerequisites

- Node.js 24 LTS and npm.
- A local checkout with dependencies installed.
- Test fixtures under `tests/fixtures/epub/`, including valid EPUB 2 and EPUB 3 books plus malformed, encrypted, traversal, and archive-limit cases.
- Provider-contract fixtures under `tests/fixtures/provider/` for success, rate limiting, timeout, empty output, truncation, invalid JSON, missing/extra IDs, refusal, and permanent configuration errors.
- For the live acceptance run only: a configured DeepSeek-compatible profile and API credential outside job storage.
- Optional: a locally available EPUBCheck command for supplemental validation.

## Planned Commands

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run test:e2e
npm run build
npm start
```

`npm start` must bind the production application to `127.0.0.1` by default and print the local URL. The exact scripts are created by `tasks.md` and must remain suitable for macOS, Windows, and Linux path semantics.

## Scenario 1: EPUB round trip and text-node preservation

1. Run the EPUB integration suite against both representative EPUB 2 and EPUB 3 fixtures.
2. Import, safely extract, parse the container/package/manifest/spine, and rebuild without translation.
3. Replace a known set of eligible text nodes and rebuild again.
4. Compare archive inventory, reading order, binary hashes, links, styles, elements, and attributes.

Expected evidence:

- Unsafe paths and configured archive limits are enforced before extraction escapes or resource exhaustion occurs.
- `mimetype` is the first archive entry and is stored without compression.
- All untouched binary resources are byte-identical.
- The reading-order document count and order are unchanged.
- Changed XHTML/XML parses successfully, and only expected text nodes plus explicitly allowed language metadata differ.
- EPUBCheck output is attached when the tool is available, but its absence does not fail the built-in suite.

## Scenario 2: Provider contract and two-pass processing

1. Start the application with the deterministic provider stub.
2. Import the representative multi-chapter fixture with source `en` and target `ru`.
3. Complete name analysis, edit one proposed proper name, and add translator/editor instructions.
4. Start processing and wait for completion.
5. Inspect persisted draft and edited results, then download the output.

Expected evidence:

- Requests contain ordered segment IDs and text rather than whole markup documents.
- Every response is schema-checked and contains exactly the expected IDs.
- Each chapter completes all draft batches before its editing batches start.
- Editing receives original plus draft text, the confirmed glossary, and instructions.
- Every final segment has a separately persisted verified draft and verified edit.
- Only edited text is inserted into the normal final EPUB.
- The corrected name is present in designated final control segments.
- Overall progress is at most 50% when all drafts but no edits are complete.

Repeat the same scenario with source `de` and target `pl`; no code or pipeline configuration beyond job values may change.

## Scenario 3: Pause, crash, and idempotent resume

1. Start a multi-batch job with the provider stub recording every request.
2. Request pause while one translation request is in flight.
3. Verify no later request begins, allow the in-flight request to complete, and verify the job reaches `paused` with its result saved.
4. Resume and pause again during editing.
5. Force-stop the process after several completed steps, restart it, and resume from the UI.

Expected evidence:

- State transitions use `running -> stopping -> paused` for a user pause.
- Jobs found in an active persisted state on startup become `paused` with a recovery event.
- Previously completed translation and editing steps produce zero duplicate provider requests.
- Drafts and edits survive independently; a completed draft is reused when only its edit is unfinished.
- No partially written state or output replaces the last valid file.

## Scenario 4: Retry classification and user recovery

Run table-driven integration cases for:

- `429` with and without retry guidance;
- temporary server error;
- timeout;
- empty/truncated response;
- invalid JSON;
- missing, duplicate, and extra segment IDs;
- permanent credential, endpoint, and unknown-model errors.

Expected evidence:

- Temporary failures and invalid model responses use bounded delayed retries.
- Provider retry guidance is honored.
- Permanent configuration failures do not loop.
- Exhausted retryable work moves the job to `needs_attention` and retains all earlier verified results.
- After configuration correction, retrying the failed batch or chapter resumes only the intended scope.
- Soft validation anomalies create warnings without bypassing hard checks.

## Scenario 5: Local API, live updates, and browser reconnect

Validate the contract in [`contracts/openapi.yaml`](contracts/openapi.yaml) with API integration tests and an end-to-end browser run.

Expected evidence:

- The job list and job details load while the external provider is unavailable.
- Live events have monotonic IDs, contain no full text or secrets, and support reconnect from `Last-Event-ID`.
- Dropping the browser event connection does not change backend state.
- On reconnect, the browser first refreshes persisted job state and then resumes events without duplicated user-visible transitions.
- Job deletion requires explicit confirmation and removes only the selected job root.

## Scenario 6: Secret and archive security

1. Configure sentinel credentials and sentinel book text.
2. Exercise success, provider-error, pause, retry, build, and download paths.
3. Scan `data/jobs/`, events, ordinary logs, built frontend assets, HTTP responses, and the output EPUB.
4. Exercise filenames and archive entries containing traversal, absolute paths, drive prefixes, mixed separators, duplicate normalized paths, symlinks if represented, high compression ratios, excessive counts, and oversized entries.

Expected evidence:

- Sentinel credentials appear only in the approved local secret source and outbound authorization transport.
- Full sentinel book/request bodies do not appear in ordinary logs or events.
- Provider errors are sanitized before persistence or delivery.
- Every unsafe or limit-exceeding fixture is rejected before external processing.
- The local production server is unreachable through non-loopback binding by default.

## Scenario 7: Validation, rebuild, and output retention

1. Complete a job and record the downloaded artifact hash.
2. Review the built-in report, warnings, counts, retries, usage, elapsed time, and user-priced estimate.
3. Retry one chapter and inject a build failure.
4. Verify the previous artifact remains downloadable with its original hash.
5. Remove the injected failure and rebuild successfully.

Expected evidence:

- Download is offered only for a successful built-in validation result.
- Warnings identify their document or batch where applicable.
- A failed build never replaces the last successful output.
- A successful replacement increments the output revision and changes the artifact atomically.

## Live acceptance run

After deterministic suites pass, perform one English-to-Russian run with the configured external service on a legally usable fixture. Review a representative sample for completeness, glossary adherence, absence of summary/invention, and reader usability. External model quality is recorded as acceptance evidence but deterministic structural and recovery tests remain the release gate.
