# ts-autocode-training

Provider-neutral runtime for training and safely rewriting directive-marked
TypeScript functions. This package owns discovery of `"use training"` methods,
runtime capture, AgentV evaluation, candidate validation, the promotion gate,
and a bounded sequential propose/review loop.

It depends on **no sibling package and no provider**, and it has no knowledge
of weaving, AOP, or source rewriting: `TrainingEngine` (the candidate
optimization strategy, composed into the internal engine), `ImplementationExecutor`
(running proposed bodies), `TrainingLoop` (driving training rounds),
`PromotionApplier` (applying a gate-approved candidate undoably), and
`TrainingStore` (persisting captured traces) are all
injected boundaries, and `captureTrainable(...)` is the entry any external
instrumentation calls to route a marked call through runtime capture. Supply
any of them per runtime through `TrainingSettings`, or register
lazy defaults once with `provideTrainingDefaults(...)`: that is how the
`ts-autocode` package wires Ax as the default engine and executor, the
governed `ts-autocode-harness` loop as the default orchestrator, and
`ts-autocode-rewrite` as capture interception and the promotion applier.

```ts
import { provideTrainingDefaults, type ImplementationExecutor, type TrainingEngine } from "ts-autocode-training";

declare const myEngine: TrainingEngine;
declare const myRunner: { run: ImplementationExecutor };

provideTrainingDefaults({
  engine: () => myEngine,
  executor: (target, implementation, args) => myRunner.run(target, implementation, args),
});
```

`configureTraining` configures one process-wide runtime; `createTrainingRuntime`
builds an isolated one that registers nothing globally, for tests and for hosts
serving several tenants. `resetTraining()` restores a fresh-import state.

Extension points are constructible: a custom `TrainingLoop` must return a
`CandidateReview` containing a `TrainableEvalRun`, and `createCandidateReview`,
`createEvalRun` and `createPromotionDecision` build those without a cast.

Every failure carries a `code` and is recognized by `isTsAutocodeError`; the
ones that have always been `TypeError`s still are.

Implementing any of these seams is documented in
[docs/authoring-providers.md](../../docs/authoring-providers.md), including the
conformance suites this package publishes for checking one.

Most applications should depend on [`ts-autocode`](../../README.md), which
re-exports this package's API with Ax defaults already registered.

## License

[MIT](../../LICENSE)
