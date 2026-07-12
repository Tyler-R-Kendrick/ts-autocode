# ts-autocode-training

Provider-neutral runtime for training and safely rewriting directive-marked
TypeScript functions. This package owns discovery of `"use training"` methods,
runtime capture, AgentV evaluation, candidate validation, the promotion gate,
and a bounded sequential propose/review loop.

It depends on **no sibling package and no provider**: `TrainingEngine`
(candidate optimization), `ImplementationExecutor` (running proposed bodies),
`TrainingLoop` (driving training rounds), `MethodWeaver` (hot-swappable
weaving), and `SourcePromoter` (guarded source rewriting) are all injected
boundaries. Supply engine, executor, and loop per runtime through
`TrainingSettings`, or register lazy defaults once with
`provideTrainingDefaults(...)` — that is how the `ts-autocode` package wires Ax
as the default engine and executor, the governed `ts-autocode-harness` loop as
the default orchestrator, and `ts-autocode-rewrite` as the weaver and
promoter.

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
