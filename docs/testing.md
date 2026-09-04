# Testing strategy

The suite is organized by what each layer can actually catch. Coverage is
enforced as a ratchet in `vitest.config.ts` — raise the thresholds as suites
land, never lower them to get a build green.

| Layer | Where | Catches |
|---|---|---|
| Atomic unit | `packages/*/test/*.test.ts` | Behavior of one function or class, including every branch of its defaulting and rejection rules |
| Functional | `test/*.test.ts` | A whole path through the runtime: mark, capture, train, gate, activate, roll back |
| Documentation | `test/docs.test.ts` | A snippet in any document this repository publishes that no longer compiles |
| Surface | `test/surface.test.ts` | Re-export drift between the root package and its siblings |
| Protocol | `test/digest-protocol.test.ts` | Two packages that must agree without importing each other |
| Compatibility | `test/deprecated.test.ts` | A deprecated spelling that silently stopped working |
| Property | `test/property.test.ts` | A law that holds for chosen examples but not in general |
| Fuzz | `test/fuzz.test.ts` | A parser crashing, hanging, or corrupting source it did not write |
| Contract | `test/contract.test.ts` | A provider implementation that satisfies the types but not the contract |
| Chaos | `test/chaos.test.ts` | A dependency failing, hanging, or racing — and the damage that leaves behind |
| Behavior | `test/behavior.test.ts` | A documented promise that stopped being true even though every unit still passes |
| Mutation | `stryker.config.json` | A test that runs the code without actually pinning its decisions |
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
test/snapshots/surface/ts-autocode.verified.txt
```

A file per subject makes the diff readable, but on its own it does not solve
the orphan: rename the subject and the old `.verified.*` file stays on disk,
unread and indistinguishable from a current one — which is worse than having no
snapshot, because a reviewer reads it as current. Vitest tracks obsolete
`.snap` blobs but not file snapshots, so `verify()` records each comparison and
`test/run.mjs` reconciles the records against `test/snapshots/` afterwards. A
full `npm test` fails and names any approved file nothing compared against.
A filtered run (`npm test -- test/cli.test.ts`) skips the check, because it
legitimately touches almost none of them.

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

## Mutation testing

`stryker.config.json` mutates the modules where a surviving mutant is alarming
rather than merely untidy: each decides something the library *does to a user's
machine* — whether generated code is written to a source file, whether it lands
on the body it was verified against, whether the library may rewrite that
source at all, what the sandbox may reach, and what gets appended to a user's
own module. Mutating everything would take hours and mostly re-measure line
coverage, which `vitest` already enforces.

The `break` threshold is a ratchet like the coverage thresholds. A genuinely
equivalent mutant — one no test could distinguish, verified rather than assumed
— is excluded at the line with `// Stryker disable next-line <mutator>:
<reason>`, which a reviewer can see and argue with. Lowering the threshold is
not the answer.

## Keeping the suite honest

Three checks exist because a suite decays quietly, and each was added after
finding that it already had:

- **`noUnusedLocals` / `noUnusedParameters`.** Three deliberately-broken
  conformance stores and their driver sat unreferenced in
  `test/contract.test.ts`, copied from the file where the negative contract
  tests actually live. Nothing flagged them.
- **Discovered documentation, not a list.** `test/docs.test.ts` and
  `test/adr.test.ts` each worked from a hand-maintained list of documents, and
  both had drifted — `AGENTS.md`, which *states* the identity ADR and carries
  the snippet demonstrating it, was in neither. `test/support/docs.ts`
  discovers them instead.
- **Orphaned snapshot detection**, described above.

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
