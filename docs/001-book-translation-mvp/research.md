# Research: Local-First Book Translation MVP

Research date: 2026-08-08. Versions are planning baselines; the lockfile records exact installed versions and automated upgrades require the full validation suite.

## Decision 1: Runtime and application stack

**Decision**: Use Node.js `24.x` LTS with TypeScript `~6.0`, Express `^5.2`, React/React DOM `^19.2`, Vite `^8.2`, Vitest `^4.1`, and Zod `^4.4`. Keep one npm project with server, client, and shared contract modules. The lockfile is authoritative.

**Rationale**: Node 24 is the production LTS line on the research date; Node 26 remains Current. The official Vite React/TypeScript template confirms the compatible React, Vite, plugin, and TypeScript lines. Vite transpiles but does not type-check, so `tsc -b` remains an independent quality gate. Express 5 is the supported current major. Zod provides one schema language for configuration, persisted state, provider results, and API payload boundaries.

**Alternatives considered**:

- Node 26: deferred until it becomes LTS.
- TypeScript 7.0: deferred because its initial release lacks the programmatic compiler API needed by some tooling; revisit on a later stable point release.
- Express 4: rejected for a new application.
- Separate backend/frontend repositories: rejected because the MVP is one local process, one origin, and benefits from shared types.

**Sources**: [Node release schedule](https://nodejs.org/en/about/previous-releases), [Express support policy](https://expressjs.com/en/support/), [Express releases](https://github.com/expressjs/express/releases), [Vite guide](https://vite.dev/guide/), [official Vite React/TS template](https://github.com/vitejs/vite/blob/main/packages/create-vite/template-react-ts/package.json), [Vitest guide](https://v4.vitest.dev/guide/), [Zod packages](https://zod.dev/packages/zod), [TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).

## Decision 2: Single-process local web delivery and SSE

**Decision**: Express owns the only listener on explicit host `127.0.0.1`. In development Vite runs in middleware mode inside the same process; in production Express serves the built SPA after API routes. Progress updates use native server-sent events with monotonic IDs and persisted replay, while REST job state remains authoritative.

**Rationale**: Omitting the host may bind Node to unspecified/all interfaces. Vite middleware mode preserves one process and one origin during development. SSE directly fits a one-way status stream, has browser reconnect support, and avoids a WebSocket dependency. Each connection sends `text/event-stream`, `no-cache`, immediate headers, framed `id/event/data` records, a periodic comment heartbeat, cleanup on close, and backpressure handling.

**Alternatives considered**:

- Separate Vite development process: operationally simple but does not meet the literal one-process goal.
- WebSocket: unnecessary for one-way progress and adds protocol/state complexity.
- Polling only: retained as a recovery fallback but not the primary live experience.
- LAN binding: outside MVP and unsafe as a default.

**Sources**: [Node `server.listen`](https://nodejs.org/api/net.html#serverlisten), [Vite middleware mode](https://vite.dev/config/server-options#server-middlewaremode), [Express static files](https://expressjs.com/en/5x/starter/static-files/), [WHATWG server-sent events](https://html.spec.whatwg.org/dev/server-sent-events.html), [Node HTTP response APIs](https://nodejs.org/api/http.html).

## Decision 3: Streaming upload boundary

**Decision**: Parse the single multipart EPUB upload with `busboy@^1.6`, set strict file/field/count limits, stream it into a new job-local temporary file, count actual bytes, and reject extra files or truncated uploads. Validate archive content only after the stream is closed and flushed.

**Rationale**: Express does not parse multipart bodies. Busboy exposes file streams and product-controlled limits without buffering the whole book in memory. The application still owns total byte counting, timeout handling, cleanup, and acceptance of exactly one `.epub` field.

**Alternatives considered**:

- Multer: convenient, but adds a storage middleware abstraction on top of Busboy that does not reduce this application's validation responsibilities.
- Memory-buffered upload: rejected for large books and denial-of-service resistance.

**Source**: [Busboy official repository and limits documentation](https://github.com/mscdex/busboy).

## Decision 4: Secure ZIP reading and EPUB packaging

**Decision**: Use `yauzl@^3.4` for authoritative Central Directory reading and entry streams, and `yazl@^3.3` for output streams. Apply application-level compressed bytes, entry count, single expanded entry, total expanded bytes, supported compression, encryption, normalized unique path, containment, and no-symlink limits. Start with configurable defaults of 100 MiB input, 10,000 entries, 100 MiB per expanded entry, and 512 MiB total expanded data.

**Rationale**: A correct ZIP reader needs random access to the Central Directory, but each entry can still stream with bounded memory. `yauzl` exposes strict filename and size validation; the application must add zip-bomb and filesystem-containment policy. `yazl` lets the builder write EPUB `mimetype` first, stored (method 0), with no prohibited extra field, then stream all other resources. Untouched resource content is verified by SHA-256; identical compressed bytes or ZIP metadata are not required.

**Required pattern**:

- Open with decoded strings, strict file names, validated entry sizes, and sequential entry handling.
- Reject absolute, drive-prefixed, parent-traversal, backslash, duplicate-normalized, encrypted, symlink, unsupported-method, and limit-exceeding entries.
- Resolve every destination against a private staging root and verify containment before creating it.
- Build to a unique temporary/revision file; never replace the current successful output before validation.
- Add ASCII `application/epub+zip` as the first `mimetype` entry with `compress: false` and DOS timestamp mode so no extended timestamp field is emitted.

**Alternatives considered**:

- JSZip: rejected because its main load/generate model is memory-oriented and loses some ZIP metadata.
- fflate: capable and fast, but the application would own more Central Directory and security-policy behavior.
- General-purpose `unzipper`/`adm-zip`: rejected because the security and bounded-streaming contract is less explicit for this threat model.

**Sources**: [`yauzl` design and API](https://github.com/thejoshwolfe/yauzl), [`yazl` API](https://github.com/thejoshwolfe/yazl), [EPUB 3.3 OCF ZIP requirements](https://www.w3.org/TR/epub-33/#sec-zip-container-mime), [EPUBCheck](https://www.w3.org/publishing/epubcheck/).

## Decision 5: Namespace-aware XML/XHTML processing

**Decision**: Use `@xmldom/xmldom@^0.9.10` in strict error-stop mode. Parse as XML, validate the actual root namespace, walk through `firstChild`/`nextSibling`, identify elements by `namespaceURI + localName`, retain references to exact text nodes, change only `Text.data`, serialize with `requireWellFormed`, and immediately parse the serialized result again.

**Rationale**: EPUB 2/3 content is XML and may contain XHTML, DTBook, SVG, MathML, and namespaced attributes. An HTML parser may repair or normalize invalid input using the wrong rules. DOM round trips preserve semantic structure but not lexical spelling such as namespace prefixes, quote style, entity form, or empty-element syntax. The acceptance requirement is therefore DOM equivalence—expanded element/attribute names and values, child order, comments, processing instructions, and doctype—rather than byte equality for changed XML documents. Unchanged resources remain byte-identical.

**Safety and mapping rules**:

- Do not assign `Element.textContent`, call `normalize()`, or parse translations as markup.
- Exclude SVG/MathML and non-translatable XHTML ancestors unless explicitly allowed.
- Persist structural child-index locators plus source hashes; re-resolve and revalidate after restart.
- Treat malformed XML as fatal and test XML size, depth, and node-count limits.
- Version `0.9.10` includes well-formed serialization support and avoids the CDATA injection issue fixed after older releases.

**Alternatives considered**:

- A CST/token-offset patch layer: deferred because the PRD requires structural preservation, not literal byte-range-only changes. Add only if lexical preservation becomes an explicit requirement.
- slimdom: credible XML DOM alternative with smaller adoption.
- saxes: rejected because its repository is archived and it provides no DOM/serializer.
- fast-xml-parser, Cheerio, parse5: rejected because their object/HTML models do not match namespace-aware XML DOM reinsertion.
- Native libxml bindings: rejected due to binary/ABI complexity and unnecessary capabilities.

**Sources**: [xmldom official repository](https://github.com/xmldom/xmldom), [xmldom advisory GHSA-wh4c-j3r5-mjhp](https://github.com/advisories/GHSA-wh4c-j3r5-mjhp), [EPUB 3.3](https://www.w3.org/TR/epub-33/), [EPUB 2 OPS](https://idpf.org/epub/20/spec/OPS_2.0.1_draft.htm), [DOM Parsing and Serialization](https://www.w3.org/TR/DOM-Parsing/), [XML 1.0 line-end normalization](https://www.w3.org/TR/xml/#sec-line-ends).

## Decision 6: Provider boundary and DeepSeek baseline

**Decision**: Define an internal `LanguageModelProvider` interface and implement the first adapter with Node's built-in `fetch` against the configured OpenAI-compatible Chat Completions endpoint. Do not pin a model name in code. Use non-streaming JSON Output with `response_format: { type: "json_object" }`, explicitly request JSON and show the exact response example in the prompt, and validate the parsed response with Zod.

**Rationale**: The official DeepSeek contract is stateless and OpenAI-compatible, while model aliases and capabilities change independently of the product. The official documentation explicitly warns that JSON Output may be empty and that output may be cut off at the token limit. Therefore JSON mode is transport assistance, not a correctness guarantee. Empty content, non-stop completion reasons, parse failures, schema failures, missing/extra/duplicate IDs, and unsafe results remain hard failures subject to bounded retry.

**Error policy**:

- Retry network errors, timeouts, `429`, and server/overload failures with exponential backoff, jitter, and valid retry guidance.
- Treat invalid request, authentication, insufficient balance, and invalid parameter/model/endpoint failures as configuration errors that require attention.
- Abort each attempt with a configured timeout; record only sanitized status, request ID, model, attempt, finish reason, and usage.
- Keep translation and editing profiles separate and snapshot the producing provider/model on every completed step.

**Alternatives considered**:

- OpenAI SDK against the compatible endpoint: valid, but built-in `fetch` plus a narrow internal adapter avoids coupling core processing to SDK-specific types.
- Strict tool calls: a possible future adapter capability, but not needed for the PRD's JSON mode baseline.
- Streaming model responses: rejected for MVP because the pipeline needs a complete atomic structured result before validation.

**Sources**: [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion), [DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/), [DeepSeek error codes](https://api-docs.deepseek.com/quick_start/error_codes/), [DeepSeek rate limits](https://api-docs.deepseek.com/quick_start/rate_limit).

## Decision 7: Local persistence and crash recovery

**Decision**: Store versioned JSON state and append-only NDJSON results/events inside a job root. For `job.json`, write a unique sibling temporary file, flush and close it, then rename on the same filesystem. For result/event journals, append a complete newline-terminated validated record, flush it, and only then atomically advance references/counts in job state. On read, ignore or quarantine only an incomplete final journal line. Build outputs under revisioned names and point state to a new revision only after successful built-in validation.

**Rationale**: This preserves the PRD's inspectable local-file design and makes the state file the commit record. Separate translation and editing journals allow reuse of a completed draft. Revisioned output names avoid platform-specific overwrite behavior and guarantee an earlier successful book remains available after a failed rebuild.

**Alternatives considered**:

- SQLite: offers transactions but adds an unnecessary database and migration surface for a single-user, single-active-job MVP.
- One mutable JSON file containing all text: rejected due to rewrite cost, secret/logging risk, and large crash surface.
- Separate JSON file per result: viable, but NDJSON aligns with the PRD and remains easy to audit when coupled with a commit pointer.

## Decision 8: Secrets and first target platform

**Decision**: First acceptance target is macOS (the current developer environment), while all paths and filesystem operations use cross-platform Node APIs and receive Windows/Linux integration coverage where feasible. Load credentials only in the server from a gitignored `.env.local` through stable `process.loadEnvFile()`; validate all environment input once with Zod and expose only `hasApiKey`. Use `.env.example` for names, never values.

**Rationale**: This resolves the PRD's first-platform and first-secret-store questions without introducing OS-specific credential APIs before the EPUB pipeline is proven. Node 24 provides a stable environment-file loader. Vite embeds `VITE_` variables into the browser bundle, so credentials must never use that prefix or pass through client configuration.

**Alternatives considered**:

- System keychain: preferred future hardening after the first OS target is stable; adapter boundary must allow it without changing jobs.
- `dotenv`: unnecessary on Node 24.
- API key in settings or job state: prohibited.

**Sources**: [Node `process.loadEnvFile`](https://nodejs.org/api/process.html#processloadenvfilepath), [Vite environment variables](https://vite.dev/guide/env-and-mode), [Vite `envPrefix`](https://vite.dev/config/shared-options#envprefix).

## Decision 9: Remaining MVP product choices

**Decision**:

- Leave navigation/TOC labels, title, and author untranslated in MVP while preserving navigation.
- Make built-in structural validation mandatory and EPUBCheck opportunistic when locally installed.
- Keep batching provider-neutral: use a `TokenEstimator` interface, a conservative character-based estimator initially, `Intl.Segmenter` for language-aware subdivision, and configurable context/output reserves.
- Run one active job and one provider request at a time.

**Rationale**: These choices close the PRD's non-blocking open decisions with the smallest reliable scope and without binding the pipeline to one language, tokenizer, provider, or operating system.

**Alternatives considered**:

- Translate nav/TOC/metadata immediately: deferred until core content round-trip and recovery are proven.
- Require EPUBCheck: rejected because it adds an external local installation prerequisite.
- Hard-code a character or token count: rejected because model context and language expansion vary.
