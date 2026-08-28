# Testing strategy

The suite is organized by what each layer can actually catch. Coverage is
enforced as a ratchet in `vitest.config.ts` — raise the thresholds as suites
land, never lower them to get a build green.

| Layer | Where | Catches |
|---|---|---|
| Atomic unit | `packages/*/test/*.test.ts` | Behavior of one function or class, including every branch of its defaulting and rejection rules |
| Functional | `test/*.test.ts` | A whole path through the runtime: mark, capture, train, gate, activate, roll back |
| Documentation | `test/docs.test.ts` | README and architecture snippets that no longer compile |
| Surface | `test/surface.test.ts` | Re-export drift between the root package and its siblings |
| Protocol | `test/digest-protocol.test.ts` | Two packages that must agree without importing each other |
| Compatibility | `test/deprecated.test.ts` | A deprecated spelling that silently stopped working |

## Running

```bash
npm test              # suite only
npm run test:coverage # suite with coverage and thresholds
npm run check         # typecheck + coverage + build
```

Coverage reports land in `test/output/coverage` (git-ignored). `lcov.info` is
there for editor and CI integrations.

## Conventions

- **A test names the defect it prevents.** Where a test exists because
  something was once wrong, the comment says what was wrong. That is what makes
  it safe to change later: a reader can tell whether the constraint still
  matters.
- **Assert on structure, not incidental formatting.** Column padding and
  message wording change; `Router.route  0 successful` broke on a one-space
  alignment shift, and the fix was to match the meaning instead.
- **A test that cannot fail is worse than no test.** Where a check guards a
  specific past bug, verify it fails when that bug is reintroduced before
  trusting it. The grounding codegen test and the documentation test were both
  confirmed this way.
- **Fixtures and artifacts belong under `test/output/`**, which is git-ignored
  and excluded from TypeScript compilation.
