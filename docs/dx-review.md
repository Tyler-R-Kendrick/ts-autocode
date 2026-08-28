# Developer experience and API design review

An adversarial review of the consumer-facing surface of `ts-autocode` and its four sibling
packages, and the plan for addressing it.

The core idea is good and the layering is unusually well held: siblings never import each
other, and only the root package wires them together. The problems are almost entirely in
the *consumer-facing* surface, which has grown outward from the internals rather than
inward from a use case.

## The rubric

`CONTRIBUTING.md` already states four API-design rules. The current public surface violates
all four, so this review uses them as its rubric rather than outside taste.

| Stated rule | Reality at the time of review |
|---|---|
| "Keep the root export surface small; internal helpers should stay internal" | Root exported 25 values and 62 types, including rewrite primitives (`applyCandidate`, `commitRewrite`, `revertRewrite`, `swapImplementation`, `restoreImplementation`) and instrumentation-author APIs (`captureTrainable`, `provideTrainingDefaults`, `withPolicy`) that no application needs |
| "Avoid global mutable configuration" | `configuredTraining` and `defaultProviders` module singletons, the `configureRewrite` registry, and `installInstrumentation` writing to `globalThis[Symbol.for("ts-autocode.instrument")]` |
| "Avoid exported string constants" | `defaultOutputDir`, `defaultTsconfig`, `trainingMarker`, `inMemoryArtifactRef`, `evolveVariable`, `defaultActionLogDir` |
| "Document public API changes in the README and add a runnable example" | `examples/` held one file that imported `../src/index.js` rather than the package name, exported rather than ran, and was referenced by no test or script |

## A. Defects

Things that are wrong, not merely inelegant.

### A1. README code does not compile

`README.md` printed `activation.promotion.snapshot.candidateId`. `Activation` has exactly
two members, `run` and `rollback`. The flagship quickstart additionally referenced a
`deploymentPolicy` that is never defined or imported, and used `route` roughly forty lines
before introducing it.

### A2. `ts-autocode-grounding` generates code against an API that does not exist

`packages/grounding/src/scan.ts` emitted
`export const <method> = training.define({ ... })`. `Training` has `records`, `evaluate`,
`train`, and `flush` — no `define`. Every generated registration file failed to typecheck.
The scan test asserted only the emitted *string*, so nothing caught it.

### A3. `"sideEffects": false` is false, and can silently break the package

All five manifests declared it, yet `src/index.ts` performs top-level
`provideTrainingDefaults(...)` and `configureRewriteCapture()`, `src/register.ts` is
entirely side effects, and `installInstrumentation` writes to a `globalThis` symbol. A
bundler honoring the hint may legally drop the wiring, leaving the user with
`no training engine is configured; import "ts-autocode"` — after importing `ts-autocode`.

### A4. `TrainInput.fanOut` was silently ignored under the default configuration

The README documented it as a first-class knob, and `trainingRounds` honors it. But the
*default* loop is the harness loop, and `createHarnessLoop` pinned `slot: 1` and never read
`input.fanOut`. An option that silently no-ops is worse than an absent one.

### A5. Documented symbols were unreachable from the root package

The README documented `trainingRounds()` and `sequentialLoop`; neither was exported from
`ts-autocode`. Also missing, yet needed to *use* documented extension points:
`defaultPromotionGates` (so `TrainInput.gates` could not be composed with the standard
set), `trainableTokenFromSymbol`, `discoverInSource`, `candidateDeclaration`,
`defaultFanOut`, `defaultMaxRounds`, and the `ProposalTurn` and `ReviewContext` types
required to implement a custom `TrainingLoop`. Only 5 of `ts-autocode-rewrite`'s 15 values
reached the root, and **nothing at all** from `ts-autocode-harness` — even though the root's
own `HarnessLoopOptions` is typed in terms of that package's `ContextProvider`,
`JudgeRequest`, and `JudgeDecision`. Configuring the default loop therefore required taking
a second, undocumented dependency.

### A6. The judge was handed a placeholder string instead of the real threshold

`promotionRubric()` emitted
`Minimum evaluation score: ${input.minScore ?? "evaluation default"}`. The real default is
`0.8`, an inline literal inside `evaluatePromotionGate`. The governed harness judge read
the literal text "evaluation default" as its criterion.

### A7. `TS_AUTOCODE_EVOLVE` failed open

The register hook disabled evolution only for `0`, `false`, and `off`. `TS_AUTOCODE_EVOLVE=no`
or `=disabled` **enabled** self-rewriting source mutation. For a kill switch on a feature
that edits the user's source files, fail-open is the wrong default.

### A8. Two unrelated candidate-execution timeouts, and the one that matters was unreachable

`AxEngineOptions.executionTimeoutMs` affects only scoring inside the engine. The default
*executor* — `executeImplementation`, registered with no options — fell back to a hardcoded
5s with no configuration path through `TrainingSettings` at all.

## B. Missing capabilities

### B1. No supported way to choose a model or provider

The default engine hardcoded `openai` plus `OPENAI_API_KEY`/`OPENAI_APIKEY`. Using anything
else meant importing `createAxEngine` from `ts-autocode/ax`, passing `studentAI`, and
handing the whole engine to `configureTraining({ engine })` — abandoning the zero-config
path. That subpath was mentioned once in the README with no example anywhere in the repo.
Picking a model is the first thing most users do.

### B2. No CLI

No package declared `bin`. Yet the product is "instrument your app and let it rewrite
itself": inspecting what is trainable, what has been captured, or what would be rewritten
required writing a script that imports `discoverTrainables`. That function is already
synchronous and sufficient to back a `discover` / `status` / `train` command.

## C. Consistency

### C1. Four verbs for global state; four patterns for construction

`configureTraining(settings): Training` **replaced** the singleton, so a second call
discarded the first. `provideTrainingDefaults(providers): void` **merged**. Alongside them,
`configureRewrite(config)` and `configureRewriteCapture()`. Construction split four ways:
`new` classes (`MemoryTrainingStore`, `WriteAheadAgentBus`, `HarnessSandbox`), `create*`
(`createAxEngine`, `createHarnessLoop`, `createSandboxPolicy`, `createRewriter`,
`createComponentDecorator`), `define*` (`defineTrainable`, `defineTrainingHarness`), and
global mutators. `defineTrainable` returns a value object while `defineTrainingHarness`
returns a service — the same verb for different kinds of thing.

### C2. Options-bag naming splits three ways with no rule

`…Settings` (10 types), `…Options` (6), and `…Input` / `…Request` / `…Config` /
`…Providers` (8). `createHarnessLoop(options: HarnessLoopOptions)` and
`defineTrainingHarness(settings: HarnessSettings)` sit one call apart and disagree.

### C3. `enabled` meant three different defaults on three sibling settings objects

`capture.enabled` defaulted on (checked `=== false`), `tracing.enabled` defaulted on, and
`evolution.enabled` defaulted *off* (checked `!== true`). The same field name with opposite
polarity inside one config object.

### C4. Gate configuration was half-grouped, half-flat, and duplicated

`TrainInput` grouped `evaluation` but flattened `minScore`, `minPassRate`, `policy`,
`gates`, `maxRounds`, and `fanOut`. `policy` is itself a `PromotionGate` in disguise — the
gate evaluator wraps it into one — so there were two ways to express one concept.
`maxRounds` appears on `TrainInput`, `TrainingLoopInput`, *and* `HarnessSettings`.

### C5. Duplicate public names across packages, some not interchangeable

`digest` exists three times and two are public with **different signatures**: the rewrite
package's takes `unknown`; grounding's takes `string` and normalizes line endings first.
Both emit `sha256:…`, so substituting one for the other silently changes hashes. `Marker`
is defined in both training and rewrite. `defaultMaxRounds = 3` is exported by both training
and harness, and neither reached the root — presumably because they would collide.
`Activation.rollback` and `AppliedPromotion.rollback` are two names for one shape.

### C6. Identity typing contradicts its own doctrine

`TrainableIdentity` is documented "never a raw string", and the `trainable()` decorator
throws on non-symbols. Yet `defineTrainable(id: string)`, `captureTrainable(id, …)`,
`instrumentTrainable(…, id)`, `wrapTrainable(fn, id)`, and `swapImplementation(id, …)` are
all raw-string APIs. The brand buys type safety at exactly one call site, and
`defineTrainable("Router.route")` is an unchecked magic string whose typo yields a different
symbol with no error. A `discover` CLI command is the practical mitigation.

### C7. Sync and async are unpredictable between neighbours

`discoverTrainables`, `applyCandidate`, `commitRewrite`, and `candidateDeclaration` are
sync; everything on `Training` and `evaluatePromotionGate` is async. `captureTrainable`
returns `Result` synchronously but branches on `isPromise` internally. `RoundObserver`
callbacks are sync-only, while `PromotionGate`, `ActionGate`, `ContextProvider`, and
`TrainInput.policy` all accept `T | Promise<T>`.

### C8. Three concurrency idioms reachable from one call

Promises (`Training`), a cold observable (`RoundSequence.subscribe(observer): () => void`),
and callback-bundle inversion of control (`HarnessInput`'s student/teacher/judge/adversary).
`training.train` traverses all three.

### C9. Twelve exported default constants — except the two that mattered

`defaultEvolution`, `defaultObjective`, `defaultOutputDir`, `defaultRetry`,
`defaultTsconfig`, `defaultMaxRounds`, `defaultFanOut`, `defaultContextWindow`,
`defaultActionLogDir`, `defaultExecutionTimeoutMs`, `defaultPromotionGates`, and
`inMemoryArtifactRef` across five modules. Meanwhile `minScore ?? 0.8` and
`minPassRate ?? 1` were inline literals.

## D. Errors and observability

### D1. Three error models, and Zod leaked through

Plain `Error`, `TypeError`, and `SyntaxError` at roughly forty sites; `AgentActionDeniedError`,
a hand-rolled class with a `readonly _tag`; and `OperationTimeoutError`, an Effect
`Data.TaggedError`. Zod errors escaped unwrapped, so `minScore: 1.5` yielded a raw
`ZodError` rather than a library error. Consumers had no discriminant beyond message text,
and the tests proved it — they assert on substrings such as
`"requires 2 distinct successful runtime traces; found 1"`.

The error *copy* is genuinely good: the provider-missing messages each name the exact
setting and the shortcut import. That quality is preserved verbatim in the typed hierarchy.

### D2. `activate()` throws for an expected outcome

`TrainingRun.outcome` is already `"ready" | "stalled" | "exhausted"`, yet the only way to
learn why a run could not be applied was to call `activate()` and catch. Background
evolution constructed an `Error` for `outcome !== "ready"` purely to route it into
`onError`.

### D3. `onError(error: unknown, phase)` was the entire background-observability surface

Capture, store, and evolve failures funnelled through one untyped callback, while
`evolution.onEvolved` sat in a different object. There was no "evolution started" and no
"evolution skipped", and the documented `onError("evolve")` sad path had no test.

## E. Boilerplate and testability

### E1. The runtime was a module-level mutable singleton with no reset or isolation

`configuredTraining` and `defaultProviders` are module globals and `TrainingRuntime` was not
exported, so tests and multi-tenant hosts could not build an isolated runtime.
`packages/training/test/wiring.ts` existed solely to work around this.

### E2. Consumer-facing types were not consumer-constructible, forcing casts

Anyone implementing a custom `TrainingLoop` must produce a `CandidateReview` containing a
`TrainableEvalRun` they cannot build, so the tests write
`{ token, run: {}, evaluations: [] } as unknown as TrainableEvalRun` and `{} as never`.
Testing `@trainable()` required fabricating a `ClassMethodDecoratorContext` cast, and
`AxEngineOptions` was not stubbable.

### E3. `defineTrainingHarness<A, B, C>()` needed three uninferrable generics

`settings` is optional and mentions only `TCandidate`, so a bare call infers
`unknown, unknown, unknown` and every documented call site writes all three out. A fourth
parameter, `TChallenge`, is scoped to `run` and *does* infer — showing the others could be
restructured the same way.

### E4. A real training test needed five pieces of setup, repeated verbatim in six files

A temp `.ts` file on disk, `source: { files: [...] }`, a stub `engine`, a hand-written
`ImplementationExecutor` needing an `as unknown` cast around `new Function`, and
`tracing: { enabled: false }`.

### E5. `...(x === undefined ? {} : { x })` appeared roughly twenty-five times

A consequence of `exactOptionalPropertyTypes` with no shared helper. `createHarnessLoop`
invented a one-off `maybeSignal()` for exactly this.

### E6. Evaluation is string-in, string-out, with a lossy JSON guess

`evaluationArgs()` `JSON.parse`s the eval input and spreads arrays as arguments, so a
function legitimately taking the single string `"[1,2]"` receives two numbers. Outputs are
stringified before assertion. Multi-argument and non-string trainables are poorly served,
and this was documented nowhere.

### E7. `effect` was a root runtime dependency for very little

`src/attempt.ts` used `Effect` to express a `try`/`catch`. Only `resilience.ts` genuinely
benefits, which put a large dependency in every consumer's tree.

## Remediation plan

All five tiers are in scope, and the work is **additive**: every renamed or reshaped API is
added alongside the existing one, with the old path kept working and marked `@deprecated`
naming its replacement.

- Old option names stay accepted and are normalized at the entry point, so `minScore` and
  `promotion.minScore` both work.
- Renamed functions keep a re-export under the old name.
- New typed errors extend `Error` and preserve their message strings byte for byte, so
  existing `catch` blocks and substring assertions keep working while `instanceof` becomes
  available.
- `onError` stays and is implemented on top of the new `onEvent`.
- Nothing is deleted in this release. A follow-up may remove the deprecated surface.

`test/deprecated.test.ts` exercises every legacy path, so the compatibility promise is
enforced rather than asserted.

### Tier 1 — defects

1. Fix the README so its code compiles; define `deploymentPolicy` and order the quickstart.
2. Declare `sideEffects` accurately.
3. Export `defaultMinScore` and `defaultMinPassRate`, and make the rubric print resolved
   numbers.
4. Make `TS_AUTOCODE_EVOLVE` fail closed on an explicit allow-list.
5. Honor `fanOut` in the harness loop, or reject it loudly — never ignore it.
6. Close the root re-export gap and rename the colliding `defaultMaxRounds`.
7. Add `TrainingSettings.execution.timeoutMs`, threaded into the default executor.
8. Make grounding's codegen emit the real API and typecheck its output.

### Tier 2 — additions

9. `TrainingSettings.model` as a first-class provider/model slot.
10. A `ts-autocode` CLI with `discover`, `status`, and `train`.
11. Runnable examples that import by package name and are checked in CI.

### Tier 3 — consistency

12. `createTraining(settings)` returning an isolated runtime; `configureTraining` merges.
13. Normalized `enabled` polarity across capture, tracing, and evolution.
14. Grouped `TrainInput.rounds` and `TrainInput.promotion`, with `policy` folded into
    `gates`.
15. One options-bag suffix; duplicate `Marker`, `digest`, and `defaultMaxRounds` resolved.
16. A smaller root surface, with author-level APIs behind a subpath.

### Tier 4 — errors and observability

17. A `TsAutocodeError` hierarchy replacing the string throws, preserving every message.
18. A non-throwing way to inspect whether a run can be activated.
19. One `onEvent` discriminated union, with `onError` retained as a shim.

### Tier 5 — boilerplate

20. Exported builders for the types that currently force casts.
21. Inferred harness generics.
22. A shared optional-spread helper.
23. A documented evaluation-argument contract with an explicit escape hatch.
24. `effect` dropped from the root and from `attempt.ts`.

## How these are kept fixed

- A **surface test** asserts every symbol exported by `ts-autocode-training` and
  `ts-autocode-rewrite` is reachable from `ts-autocode`, so A5 cannot recur.
- **Documentation is typechecked**: TypeScript blocks are extracted from the READMEs and
  compiled in CI. This is what would have caught A1.
- Grounding's generated output is typechecked rather than string-matched, catching A2.
- A tree-shaking bundle test asserts the Ax engine survives, catching A3.
- Targeted regression tests cover `fanOut`, the rubric thresholds, the evolve kill switch,
  and the `onError("evolve")` sad path.
