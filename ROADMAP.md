# Trucheman roadmap

Trucheman 0.1 establishes the architecture we intend to keep: DOM-preserving EPUB processing,
translation followed by literary editing, optional critic and selective repair, book-wide
consistency, durable checkpoints, and local-first storage.

## Delivered for 0.1

- Cached, user-editable book style profiles and chapter context cards.
- Source fingerprints, a user-visible run manifest, resumable stage journals, and targeted
  invalidation.
- Standard Chat Completions and resumable OpenAI Batch processing.
- Internal archive and EPUB validation plus advisory EPUBCheck reporting and safe repair rules.
- Prompt-injection boundaries that keep book content out of system instructions.
- Deterministic quality scanning, selective critic repair, and rollback of harmful repairs.
- A versioned public-domain literary regression corpus with an enforced acceptance floor.
- Runtime recovery for truncated responses, malformed output, and context-limited batches.

## Next

1. Grow the public-domain golden corpus across more genres, language pairs, and long-context
   failure cases.
2. Compare EPUBCheck findings on source and output so reports distinguish inherited defects from
   regressions introduced during processing. EPUBCheck remains advisory; unsafe archives and
   structurally unusable output remain the blocking boundary.
3. Add an explicit provider capability matrix before supporting another provider as a first-class
   target: context and output limits, structured-output behavior, retry classes, reasoning modes,
   caching, and Batch API support.
4. Route models by measured quality, latency, and cost only after the evaluation corpus is large
   enough to support the decision.

## Deliberate non-goals

- A third or fourth full-book rewrite pass.
- Rebuilding normal EPUBs through Markdown, Pandoc, or Calibre.
- Making EPUBCheck installation or perfect conformance mandatory for usable legacy books.
- Advertising broad provider compatibility before it is covered by repeatable tests.
