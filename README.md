# Book Translator

Book Translator is a local-first web application for translating DRM-free EPUB 2 and EPUB 3 books. It keeps job state and intermediate results on the local filesystem while sending eligible text segments to a configured external language provider.

## Development

Requirements: Node.js 24 or newer.

```sh
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

The server binds to `127.0.0.1` by default. Copy `.env.example` to `.env.local` or configure `.env`; `.env.local` takes precedence. Add provider credentials only to a server-side environment file. Credentials are never sent to the browser or written to job state.

## Using the application

1. Open `http://127.0.0.1:4173`.
2. Choose **New book**, select an EPUB, choose different source and target languages, and select **Upload and analyze**.
3. Review the prepared job and choose **Start translation**.
4. Wait for the job to reach `completed`, then choose **Download translated EPUB**.

Without credentials, the application uses the deterministic local provider so the complete flow can be exercised safely. To use DeepSeek, place both translation and editing credentials in `.env.local`:

```dotenv
BOOK_TRANSLATOR_TRANSLATION_API_KEY=your-key
BOOK_TRANSLATOR_EDITING_API_KEY=your-key
BOOK_TRANSLATOR_TRANSLATION_MODEL=deepseek-v4-flash
BOOK_TRANSLATOR_EDITING_MODEL=deepseek-v4-flash
BOOK_TRANSLATOR_CONSISTENCY_MODEL=deepseek-v4-flash
```

Translation and editing models are configured independently. The editing pass can also select an
evaluated prompt independently of the translation pass. The OpenAI Terra editing model
(`BOOK_TRANSLATOR_EDITING_MODEL=gpt-5.6-terra`) automatically selects the evaluated
`literary-v3.2.1` prompt. Set `BOOK_TRANSLATOR_EDITING_PROMPT_VERSION` only to override the
model-specific default; other models continue to use `literary-v3.1` unless explicitly configured.

External-provider runs also make up to two cached DeepSeek consistency requests: one builds a
book-wide entity registry before translation, and one resolves detected variants after editing.
The model returns decisions only; exact replacements are validated and applied by code. Mechanical
quote and `ё` diagnostics are saved as `consistency-report.json` in the local job directory.
The consistency profile is configured with `BOOK_TRANSLATOR_CONSISTENCY_API_KEY`,
`BOOK_TRANSLATOR_CONSISTENCY_ENDPOINT`, `BOOK_TRANSLATOR_CONSISTENCY_MODEL`, and
`BOOK_TRANSLATOR_CONSISTENCY_THINKING`. Its API key, endpoint, and model fall back to the translation
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
editing checkpoints.

Restart the server after changing `.env.local` or `.env`. The external-provider mode sends eligible book text to the configured service.

## Literary editor evaluation

The committed regression corpus exercises the editing pass without translating an entire EPUB. It includes calques, collocations, dialogue, nonfiction, period prose, and multiple language pairs. With an editing credential configured, run:

```sh
npm run eval:literary
```

Use `-- --limit 3` for a smaller paid smoke run, `-- --offset 1` to resume after the first case, or `-- --output path/to/report.json` to choose the report location. Test a non-production prompt with `-- --prompt-version literary-v3.2.1`; the production default remains unchanged. Compare models explicitly with `-- --model deepseek-v4-pro --thinking disabled --temperature 0`; supplied prompt, generation settings, and corpus selection are recorded in the report. Omit `--temperature` unless the selected model supports it. Reports are written under the ignored `eval-results/` directory by default. Automated checks reject known bad constructions without requiring one exact literary translation; the report also includes empty human-review fields for semantic fidelity, native-language naturalness, lexical/idiomatic naturalness, and voice preservation.

To exercise corpus loading, reporting, and scoring without making external requests, run `npm run eval:literary -- --provider deterministic`.

## Design boundaries

- EPUB archives are checked for unsafe paths, encryption, unsupported compression, and expansion limits before processing.
- Translation and editing use separate provider profiles and exact segment identifiers.
- Book-wide entity choices are cached and reused across retries; user glossary entries take priority.
- Drafts and edits are stored in separate append-only journals.
- The final build uses edited text only and is validated before output promotion.
- The browser displays only sanitized job state and progress events.
