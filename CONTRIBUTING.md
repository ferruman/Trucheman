# Contributing to Trucheman

Thank you for helping improve Trucheman. Bug reports, documentation fixes, tests, and focused code
changes are welcome.

## Before you start

- Search existing issues before opening a new one.
- Use an issue for substantial features or architectural changes before investing in implementation.
- Do not include copyrighted books, provider credentials, API responses containing book text, or
  local job data in issues, commits, or test fixtures.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node.js 24 or newer.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Use the deterministic provider for development and tests. Real provider credentials belong only in
an ignored `.env.local` file.

## Pull requests

Keep each pull request focused and include:

- a concise description of the behavior and motivation;
- tests appropriate to the change;
- commands used for verification;
- screenshots for visible UI changes;
- documentation and `.env.example` updates for configuration changes.

Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` before submitting. Run
`npm run e2e` for user-flow changes. By contributing, you agree that your contribution is licensed
under the project's MIT License.
