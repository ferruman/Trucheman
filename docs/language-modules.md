# Language modules

Trucheman's generic pipeline knows language tags and passes source and target language metadata
to every model call. Language-specific behavior lives under `src/server/languages` and is loaded
through `registry.ts`; pipeline code must not branch on tags such as `ru` or `ja`.

## Module boundaries

- `types.ts` defines the source and target capabilities a language may provide.
- `<tag>.ts` owns rules and deterministic behavior for one language.
- `pairs/<source>-<target>.ts` owns behavior that belongs to a translation direction rather than
  either language alone, such as the Polivanov system for Japanese-to-Russian transliteration.
- `registry.ts` resolves regional tags to their base tag and composes source, pair, and target
  prompt rules.

Capabilities are optional. A language with no specialized module still uses the generic
translation, editing, critique, EPUB localization, and validation pipeline. A module can add:

- source preprocessing and batch limits;
- source, pair, and target prompt rules;
- target-language style hints and name endings;
- deterministic typography normalization;
- written-number recognition;
- EPUB audits and morphology checks.

## Adding a language

1. Add its public tag and display name to `src/shared/languages.ts`.
2. Create `src/server/languages/<tag>.ts` with only the capabilities the language needs.
3. Register the module in `src/server/languages/registry.ts`.
4. Add directional rules under `languages/pairs` when they do not apply to every source or target.
5. Add focused tests for each capability and a prompt-composition test.

Keep language modules deterministic. Provider selection, retries, job persistence, and model
orchestration belong to the generic pipeline.
