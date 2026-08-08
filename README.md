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
```

Restart the server after changing `.env.local` or `.env`. The external-provider mode sends eligible book text to the configured service.

## Design boundaries

- EPUB archives are checked for unsafe paths, encryption, unsupported compression, and expansion limits before processing.
- Translation and editing use separate provider profiles and exact segment identifiers.
- Drafts and edits are stored in separate append-only journals.
- The final build uses edited text only and is validated before output promotion.
- The browser displays only sanitized job state and progress events.
