# ts-autocode-training

Provider-neutral runtime for training and safely rewriting directive-marked
TypeScript functions. This package owns discovery of `"use training"` methods,
runtime capture, AgentV evaluation, candidate validation, the promotion gate,
and the bounded student/teacher loop (via `ts-autocode-harness`).

It has **no optimizer or execution provider**: `TrainingEngine` (candidate
optimization) and `ImplementationExecutor` (running proposed bodies) are
injected boundaries. Supply them per runtime through `TrainingSettings.engine`
and `TrainingSettings.executor`, or register lazy defaults once with
`provideTrainingDefaults(...)` — that is how the `ts-autocode` package wires Ax
as the default engine and Ax's JavaScript sandbox as the default executor.

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
