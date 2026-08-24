# Open-source publication checklist

Complete these steps immediately before or after changing the repository visibility to public.

## Before publication

- [ ] Decide whether to rewrite the Git history to replace the author email with a GitHub noreply
      address. History rewriting requires a force-push and must happen before contributors fork it.
- [ ] Confirm that every committed fixture and evaluation case may be redistributed under MIT.
- [ ] Confirm that no real book, local job directory, generated report, or provider response is
      committed.
- [ ] Run `npm audit`, `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`.

## GitHub settings

- [ ] Add the repository description and topics.
- [ ] Enable private vulnerability reporting and secret scanning.
- [ ] Enable CodeQL default setup for JavaScript/TypeScript.
- [ ] Protect `main`: require pull requests, CI, conversation resolution, and no force-pushes.
- [ ] Enable Dependabot alerts and security updates.
- [ ] Review Actions permissions and keep the default workflow token read-only.

## After publication

- [ ] Verify the README, license, contribution guide, security policy, and issue forms render.
- [ ] Verify CI and dependency review pass on a test pull request.
- [ ] Review the GitHub community profile checklist.
- [ ] Create an initial release and changelog when the public API is ready.
