# ts-autocode

Train TypeScript functions from runtime traces and AgentV evals, then safely
rewrite the function that was marked trainable.

The normal path has four pieces:

```text
"use training" -> runtime captures -> AgentV evals -> Ax optimization -> guarded source update
```

Ax is the default optimizer. `TrainingEngine` remains a small provider boundary
for applications that use another engine.

## Install

```bash
npm install ts-autocode
```

Node.js 20 or newer is required.

## Use the directive

`useTraining` is the default export. It wraps methods whose first statement is
the literal directive, while preserving the object's public type.

```ts
import useTraining, { configureTraining } from "ts-autocode";
import { ai } from "@ax-llm/ax";

const training = configureTraining({
  ax: {
    studentAI: async ({ secrets }) => {
      const apiKey = await secrets?.get("OPENAI_API_KEY");
      if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
      return ai({ name: "openai", apiKey });
    },
  },
  secrets: secretManager,
});

class Router {
  route(input: string): string {
    "use training";
    return input.includes("invoice") ? "billing" : "fallback";
  }
}

const router = useTraining(new Router());
```

The same form works for a function:

```ts
const trainedRoute = useTraining(function route(input: string): string {
  "use training";
  return input;
});
```

The directive stays in source. TypeScript's compiler API uses it to discover
the exact function body and its signature; there are no generated-region
comments or external offsets to maintain.

## Use the decorator

The decorator is equivalent when an explicit identity is preferable:

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

- `ax` configures the default engine and its AI services.
- `engine` replaces Ax with another `TrainingEngine`.
- `secrets` and `variables` are passed to engine factories without entering traces.
- `store`, `tracer`, and `capture` configure recording.
- `source` overrides TypeScript project discovery when the default `tsconfig.json`
  is not the desired project.
- `concurrency` limits `optimizeAll()`; independent work runs concurrently.

`createTraining(settings)` creates an isolated training context.
`configureTraining(settings)` sets the application default used by `@trainable`
and `useTraining()`.

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
