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

The server binds to `127.0.0.1` by default. Copy `.env.example` to `.env.local` and add provider credentials only to the server-side environment file. Credentials are never sent to the browser or written to job state.

## Design boundaries

- EPUB archives are checked for unsafe paths, encryption, unsupported compression, and expansion limits before processing.
- Translation and editing use separate provider profiles and exact segment identifiers.
- Drafts and edits are stored in separate append-only journals.
- The final build uses edited text only and is validated before output promotion.
- The browser displays only sanitized job state and progress events.
