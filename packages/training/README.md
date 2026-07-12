# ts-autocode-training

Provider-neutral runtime for training and safely rewriting directive-marked
TypeScript functions. This package owns discovery of `"use training"` methods,
runtime capture, AgentV evaluation, candidate validation, the promotion gate,
and a bounded sequential propose/review loop.

It depends on **no sibling package and no provider**, and it has no knowledge
of weaving, AOP, or source rewriting: `TrainingEngine` (the candidate
optimization strategy, composed into the internal engine), `ImplementationExecutor`
(running proposed bodies), `TrainingLoop` (driving training rounds), and
`PromotionApplier` (applying a gate-approved candidate undoably) are all
injected boundaries, and `captureTrainable(...)` is the entry any external
instrumentation calls to route a marked call through runtime capture. Supply
engine, executor, and loop per runtime through `TrainingSettings`, or register
lazy defaults once with `provideTrainingDefaults(...)` — that is how the
`ts-autocode` package wires Ax as the default engine and executor, the
governed `ts-autocode-harness` loop as the default orchestrator, and
`ts-autocode-rewrite` as capture interception and the promotion applier.

```ts
import { configureTraining, provideTrainingDefaults } from "ts-autocode-training";

provideTrainingDefaults({
  engine: () => myEngine,
  executor: (target, implementation, args) => myRunner.run(target, implementation, args),
});
```

Most applications should depend on [`ts-autocode`](../../README.md), which
re-exports this package's API with Ax defaults already registered.

## License

[MIT](../../LICENSE)
