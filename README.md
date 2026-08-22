# Trucheman

[![CI](https://github.com/ferruman/Trucheman/actions/workflows/ci.yml/badge.svg)](https://github.com/ferruman/Trucheman/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Trucheman is a local-first web application for translating DRM-free EPUB 2 and EPUB 3 books. It keeps job state and intermediate results on the local filesystem while sending eligible text segments to a configured external language provider.

> **Project status:** pre-1.0 and under active development. Back up source books and local job data
> before upgrading.

## Highlights

- Local-first job state with interruption recovery and deterministic offline development.
- Separate translation and literary-editing passes with glossary and book-wide consistency support.
- Conservative EPUB extraction, rebuilding, and output validation.
- Optional high-quality critic and targeted repair pipeline with durable usage reporting.

## Development

Requirements: Node.js 24 or newer.

```sh
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change.

The server binds to `127.0.0.1` by default. Copy `.env.example` to `.env.local` or configure `.env`; `.env.local` takes precedence. Add provider credentials only to a server-side environment file. Credentials are never sent to the browser or written to job state.

## Using the application

1. Open `http://127.0.0.1:4173`.
2. Choose **New book**, select an EPUB, choose different source and target languages, and select **Upload and analyze**.
3. Review the prepared job and choose **Start translation**.
4. Wait for the job to reach `completed`, then choose **Download translated EPUB**.

Without credentials, the application uses the deterministic local provider so the complete flow can be exercised safely. To use DeepSeek, place both translation and editing credentials in `.env.local`:

```dotenv
TRUCHEMAN_TRANSLATION_API_KEY=your-key
TRUCHEMAN_EDITING_API_KEY=your-key
TRUCHEMAN_TRANSLATION_MODEL=deepseek-v4-flash
TRUCHEMAN_EDITING_MODEL=deepseek-v4-flash
TRUCHEMAN_CRITIC_MODEL=deepseek-v4-flash
TRUCHEMAN_CONSISTENCY_MODEL=deepseek-v4-flash
```

Translation and editing models are configured independently. The editing pass can also select an
evaluated prompt independently of the translation pass. The OpenAI Terra editing model
(`TRUCHEMAN_EDITING_MODEL=gpt-5.6-terra`) automatically selects the evaluated
`literary-v3.2.1` prompt. Set `TRUCHEMAN_EDITING_PROMPT_VERSION` only to override the
model-specific default; other models continue to use `literary-v3.1` unless explicitly configured.

External-provider runs also make up to two cached DeepSeek consistency requests: one builds a
book-wide entity registry before translation, and one resolves detected variants after editing.
The model returns decisions only; exact replacements are validated and applied by code. Mechanical
quote and `ё` diagnostics are saved as `consistency-report.json` in the local job directory.
The consistency profile is configured with `TRUCHEMAN_CONSISTENCY_API_KEY`,
`TRUCHEMAN_CONSISTENCY_ENDPOINT`, `TRUCHEMAN_CONSISTENCY_MODEL`, and
`TRUCHEMAN_CONSISTENCY_THINKING`. Its API key, endpoint, and model fall back to the translation
profile when omitted.

Each book has a quality mode:

- **Standard** runs translation and literary editing, followed by book-wide consistency.
- **High** adds a conservative audit after editing. The audit sees the original, initial
  translation, and edited translation, but cannot rewrite. Only segments with validated medium or
  high-severity findings are sent through targeted repair; unflagged edits are preserved exactly.

High mode always adds audit inference for every eligible segment. Repair inference is selective, so
its additional cost depends on how many concrete defects the critic finds. Audit and repair results
are checkpointed in `audits.ndjson` and `repairs.ndjson`; the local `quality-report.json` records the
flagged spans and applied repair count. Switching quality modes keeps completed translation and
editing checkpoints. Configure the audit profile with `TRUCHEMAN_CRITIC_API_KEY`,
`TRUCHEMAN_CRITIC_ENDPOINT`, `TRUCHEMAN_CRITIC_MODEL`, and
`TRUCHEMAN_CRITIC_THINKING`; omitted values inherit the editing profile. Targeted repair
continues to use the editing model.

Each book also has a processing mode. **Standard** sends requests immediately through the
configured OpenAI-compatible Chat Completions endpoint. **Batch** submits the same validated
pipeline through the official OpenAI Batch API. Each submitted batch task is asynchronous and can
take up to 24 hours; because a book has dependent translation, editing, and optional audit stages,
the complete run can take longer. OpenAI prices Batch API work at a discount. Submitted batch
identifiers and downloaded results are kept inside the local job directory, so pausing or
restarting Trucheman does not submit the same request again.

Batch mode requires every configured endpoint to be
`https://api.openai.com/v1/chat/completions`. Configure the translation, editing, critic, and
consistency models for OpenAI before selecting it; omitted critic and consistency credentials still
fall back to the editing and translation keys. A non-OpenAI endpoint is rejected before book text is
uploaded. See the [official OpenAI Batch API reference](https://developers.openai.com/api/reference/resources/batches).

Every successful provider response is recorded in the append-only `usage.ndjson` ledger. The
derived `usage-report.json` and the completed-job result page group request counts, input tokens,
cached input tokens, output tokens, and total tokens by pipeline stage and exact model. Checkpoint
reuse does not create another usage record; a genuinely repeated provider call does. Reports contain
token usage only and intentionally do not estimate currency costs.

Restart the server after changing `.env.local` or `.env`. The external-provider mode sends eligible book text to the configured service.

## Design boundaries

- EPUB archives are checked for unsafe paths, encryption, unsupported compression, and expansion limits before processing.
- Translation and editing use separate provider profiles and exact segment identifiers.
- Book-wide entity choices are cached and reused across retries; user glossary entries take priority.
- Drafts and edits are stored in separate append-only journals.
- The final build uses edited text only and is validated before output promotion.
- The browser displays only sanitized job state and progress events.

## Security and privacy

Trucheman is a single-user local application and should not be exposed directly to the public
internet. External-provider mode sends eligible book text to the configured API. Use only books you
have the right to process, review the provider's terms, and never commit `.env` files or local job
data. Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## License

Trucheman is available under the [MIT License](LICENSE).
