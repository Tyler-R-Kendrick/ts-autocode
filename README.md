# ts-autocode

Train TypeScript functions from AgentV evals and optional runtime traces, then
safely rewrite the function marked trainable.

The normal path has three pieces:

```text
"use training" -> AgentV evals -> Ax optimization -> guarded source update
```

Ax is the default optimizer. `TrainingEngine` remains a small provider boundary
for applications that use another engine.

## Install

```bash
npm install ts-autocode
```

Node.js 20 or newer is required.

## Use the directive

Place the literal directive first in a function or method body. No import,
decorator, wrapper, registration call, or source-region argument is required.

```ts
import { configureTraining } from "ts-autocode";

const training = configureTraining();

class Router {
  route(input: string): string {
    "use training";
    return input.includes("invoice") ? "billing" : "fallback";
  }
}

function normalize(input: string): string {
  "use training";
  return input.trim();
}

const router = new Router();
```

The directive stays in source. TypeScript's compiler API uses it to discover
the exact enclosing function body, identity, and signature. Consumer calls stay
unchanged because the directive is the marker; there is no runtime proxy.

## Optional runtime capture

The decorator is optional when calls must be intercepted for runtime capture.
It accepts only the trainable identity; global configuration controls capture
and tracing. The decorated method is the source target, so callers never provide
source metadata.

```ts
import { defineTrainable, trainable } from "ts-autocode";

const route = defineTrainable("Router.route");

class Router {
  @trainable(route)
  route(input: string): string {
    return input;
  }
}
```

A token contains a durable string id and stable `Symbol.for(...)` symbol. The
same id binds the method, captures, AgentV results, optimizer candidate, and
promotion decision. String identities such as `@trainable("Router.route")` are
also accepted.

## Train and promote

AgentV owns eval definitions, graders, traces, scores, and result types.

```ts
const tests = [
  {
    id: "billing",
    input: "Where is my invoice?",
    assert: [{ type: "equals", value: "billing" }],
  },
  {
    id: "fallback",
    input: "Reset my password",
    assert: [{ type: "equals", value: "fallback" }],
  },
];

const run = await training.train({
  trainable: "Router.route",
  objective: "Preserve correct billing and fallback routing",
  evaluation: {
    tests,
    task: (input) => router.route(input),
    workers: 2,
  },
  policy: (candidate) => deploymentPolicy.allows(candidate),
});

const promoted = await training.promote(run.candidate, run.decision);

// Refuses to overwrite later changes.
await training.revert(promoted.snapshot);
```

`train()` runs baseline AgentV evals, optimization, sandboxed candidate evals,
and the promotion gate. Baseline results are never treated as proof that a
rewrite passes. The lower-level `evaluate`, `optimize`, `evaluateCandidate`, and
gate functions remain available for custom orchestration.

No Ax program is supplied by the caller. The default engine derives its fields,
descriptions, executable examples, and return contract from the TypeScript
method signature. Ax optimizes the generated program, and its metric executes
proposed bodies in Ax's JavaScript sandbox against captured and AgentV examples.

## Configuration

Runtime dependencies enter through `TrainingSettings`:

- `engine` replaces the default Ax implementation with any `TrainingEngine`.
- `secrets` and `variables` are passed to engine factories without entering traces.
- `store`, `capture`, and `tracing` configure recording globally.
- `source` overrides TypeScript project discovery when the default `tsconfig.json`
  is not the desired project.
- `concurrency` limits `optimizeAll()`; independent work runs concurrently.

`configureTraining(settings)` is the single public runtime configuration entry
point. Settings are optional. The default Ax implementation reads
`OPENAI_API_KEY` from the configured secret provider or process environment.
Provider-specific Ax tuning remains isolated to the optional `ts-autocode/ax`
adapter and is passed through the provider-neutral `engine` slot.

## Custom engines

Custom engines return only the new method implementation:

```ts
const engine: TrainingEngine = {
  id: "acme/optimizer",
  async optimize(request, context) {
    return {
      implementation: await rewrite({
        signature: request.target.signature,
        implementation: request.target.implementation,
        objective: request.objective,
        evaluations: request.evaluations,
        secrets: context.secrets,
      }),
    };
  },
};
```

The core validates identity, source digests, and the final candidate regardless
of engine.

## Official telemetry types

- AgentV `Trace` and `EvaluationResult` come from `@agentv/core`.
- OpenInference span kinds and semantic conventions come from
  `@arizeai/openinference-semantic-conventions`.
- OpenTelemetry spans, tracers, attributes, and status codes come from
  `@opentelemetry/api`.

This package does not duplicate those types.

## Development

```bash
npm ci
npm run check
```

Tests write generated artifacts only under `test/output/`. The directory is
ignored by Git and excluded from TypeScript compilation.

See [examples/optimize.ts](examples/optimize.ts),
[docs/architecture.md](docs/architecture.md), [CONTRIBUTING.md](CONTRIBUTING.md),
and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
