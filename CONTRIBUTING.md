# Contributing

## Setup

Use Node.js 20 or newer.

```bash
npm ci
npm run check
```

## Pull requests

- Keep changes focused and add tests for behavior changes.
- Import protocol and SDK types from their owning package.
- Keep the root export surface small; internal helpers should stay internal.
- Avoid global mutable configuration and exported string constants.
- Document public API changes in the README and add a runnable example when
  behavior is not obvious.
- Do not commit credentials, generated `dist/` files, or `.env` files.

## Naming and shape conventions

- Factories are `create*`; identity/value constructors are `define*`; nothing
  else mints new verbs for construction.
- Configuration objects: `…Settings` configures something long-lived (a
  runtime, a service); `…Options` parameterizes one call or one factory
  invocation. Do not introduce `…Config`/`…Params` variants.
- Injected seams are agent nouns: `TrainingEngine`, `ImplementationExecutor`,
  `TrainingLoop`, `TrainingStore`, `Promoter`, `PromotionGate`. Every seam
  ships a default implementation (`test/defaults.test.ts` enforces it) and a
  conformance suite (`packages/training/src/conformance.ts`); adding a seam
  means adding both.
- Provider choices are settings, not code: anything a user picks (a model, a
  timeout, a threshold) belongs on `TrainingSettings`/`TrainInput`, carried
  opaquely if provider-specific — never a hardcoded registry in this repo.
- **A trainable identity is never a plain string (ADR).** A string is not a
  sufficient identity to guarantee uniqueness. Accepted identities are the
  symbol, the `TrainableToken`, or the marked method/function itself (which
  instrumentation stamps). `test/adr.test.ts` pins the rejection at compile
  time; do not re-admit strings as call-site sugar.
- Validate settings at the boundary with `parseSetting`, so misconfiguration
  fails as `InvalidSettingsError` naming the setting, not deep in a run.

The CI workflow runs type checking, tests, and the package build on supported
Node.js versions.
