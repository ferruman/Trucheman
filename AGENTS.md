# Repository Guidelines

## Project Structure & Module Organization

This is a Node.js 24+, TypeScript, React, and Express application for local-first EPUB translation. Browser code lives in `src/client`: application wiring is under `app/`, feature UI under `features/`, and global styling in `styles.css`. Server code lives in `src/server`, organized by responsibility: HTTP routes in `api/`, EPUB processing in `epub/`, job orchestration in `jobs/`, provider adapters in `providers/`, persistence in `storage/`, and configuration in `config/`. Put contracts shared across runtimes in `src/shared`.

Tests mirror behavior rather than source folders: `tests/unit`, `tests/integration`, `tests/contract`, and `tests/e2e`. Reusable EPUB builders and assertions belong in `tests/fixtures` and `tests/helpers`. Generated output, local job state, and coverage artifacts (`dist/`, `data/`, `coverage/`, `test-results/`) are not source-controlled.

## Build, Test, and Development Commands

- `npm install` installs dependencies.
- `npm run dev` builds the client, then starts the local server at `127.0.0.1:4173`.
- `npm run build` type-checks and builds production client/server output.
- `npm run typecheck` runs TypeScript project checks without emitting application output.
- `npm run lint` runs ESLint; `npm run format` applies Prettier.
- `npm test` runs Vitest once; `npm run test:watch` runs it interactively.
- `npm run e2e` runs Playwright against the deterministic local provider.

## Coding Style & Naming Conventions

Use TypeScript throughout and keep client, server, and shared boundaries explicit. Prettier enforces semicolons, double quotes, trailing commas, and a 100-character line width. Use two-space indentation, `camelCase` for functions and variables, `PascalCase` for React components and types, and kebab-case filenames for server modules (for example, `job-orchestrator.ts`). Keep React component filenames in `PascalCase.tsx`.

## Testing Guidelines

Vitest discovers `tests/**/*.test.ts` and `tests/**/*.test.tsx`; Playwright tests use `tests/e2e/*.spec.ts`. Add focused unit coverage for pure logic and integration or contract coverage for filesystem, HTTP, provider, and EPUB boundaries. Run `npm run typecheck`, `npm run lint`, and `npm test` before submitting; run `npm run e2e` for user-flow changes.

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries, sometimes with a conventional prefix such as `fix:`. Keep each commit scoped to one coherent change. Pull requests should explain behavior and risk, list verification commands, link the relevant issue or spec, and include screenshots for visible UI changes. Never commit credentials or local `.env` files; update `.env.example` when introducing configuration.

## Agent-Specific Instructions

For code discovery, prefer the repository knowledge graph (`search_graph`, `trace_path`, and `get_code_snippet`) before text search. Preserve unrelated working-tree changes and keep generated artifacts out of commits.
