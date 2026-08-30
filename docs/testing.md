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
| Property | `test/property.test.ts` | A law that holds for chosen examples but not in general |
| Fuzz | `test/fuzz.test.ts` | A parser crashing, hanging, or corrupting source it did not write |
| Contract | `test/contract.test.ts` | A provider implementation that satisfies the types but not the contract |
| Chaos | `test/chaos.test.ts` | A dependency failing, hanging, or racing — and the damage that leaves behind |
| Characterization | `test/characterization*.test.ts` | A change to anything this library *generates* — rewritten source, emitted instrumentation, prompts, CLI output, the export surface |

## Running

```bash
npm test              # suite only
npm run test:coverage # suite with coverage and thresholds
npm run check         # typecheck + coverage + build
```

Coverage reports land in `test/output/coverage` (git-ignored). `lcov.info` is
there for editor and CI integrations.

## Characterization snapshots

For a library whose product is rewritten source, the generated text *is* the
product, and a diff of it is the only review that shows what actually changed.
`toContain("return input")` says almost nothing about an emitted module.

`test/support/verify.ts` follows the [Verify](https://github.com/VerifyTests/Verify)
model rather than Vitest's inline snapshots: one named file per subject under
`test/snapshots/`, committed and reviewed like any other artifact. An inline
`.snap` blob keyed by test name is hard to read in a diff, and a test rename
silently orphans it.

```
test/snapshots/rewrite/emitted-instrumentation.verified.ts
test/snapshots/prompts/ax-program-signature.verified.json
test/snapshots/surface/ts-autocode.txt
```

Approve a deliberate change with `npm test -- -u`, and **read the diff** — that
is the entire value. `scrub()` removes digests, UUIDs, timestamps and absolute
paths first, because a snapshot that churns is one everyone learns to
re-approve without reading.

Snapshots are excluded from `tsconfig.test.json`: they are generated artifacts,
and the emitted instrumentation deliberately references names from the module it
is appended to, so it does not typecheck standalone.

## Property and fuzz tests

`fast-check` states the law and hunts for a counterexample, rather than sampling
a few inputs by hand. Failures print a shrunk counterexample and a seed, so a
regression is reproducible rather than "it failed once on CI".

Properties target the pure, total functions where examples can only sample:
identity round-trips, digest canonicalization, gate aggregation, and the spread
helpers. Fuzzing targets the parsers, because every one of them runs against
code this library did not write — `augmentSource` sees every module a user
loads.

**A fuzz corpus must reach the code.** An early version used random punctuation;
instrumenting it showed **1 input in 3000** produced a discovered target, so
every property about offsets and rewriting was passing vacuously.
`test/support/sources.ts` now generates structurally plausible marked modules
and then damages them, and `test/fuzz.test.ts` asserts the corpus still reaches
real work — so the suite cannot quietly decay back into theatre.


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
