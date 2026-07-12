# ts-autocode-training

Provider-neutral runtime for training and safely rewriting directive-marked
TypeScript functions. This package owns discovery of `"use training"` methods,
runtime capture, AgentV evaluation, candidate validation, the promotion gate,
and a bounded sequential propose/review loop.

It has **no optimizer, execution, or orchestration provider**: `TrainingEngine`
(candidate optimization), `ImplementationExecutor` (running proposed bodies),
and `TrainingLoop` (driving training rounds) are injected boundaries. Supply
them per runtime through `TrainingSettings`, or register lazy defaults once
with `provideTrainingDefaults(...)` — that is how the `ts-autocode` package
wires Ax as the default engine and executor and the governed
`ts-autocode-harness` loop as the default orchestrator.

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
