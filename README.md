# ts-autocode

`ts-autocode` connects runtime traces and AgentV evaluations to safe,
marker-delimited TypeScript rewrites.

```text
@trainable invocation -> AgentV Trace -> AgentV evals -> TrainingEngine -> candidate -> gate -> promote/revert
```

The core is provider-neutral. Ax is available as an optional engine adapter,
not a required architecture choice.

## Install

```bash
npm install ts-autocode
```

Install Ax only when using that adapter:

```bash
npm install @ax-llm/ax
```

Node.js 20 or newer is required.

## Define the trainable identity

A trainable token is the stable join key for code regions, runtime captures,
AgentV results, optimizer candidates, and promotion decisions.

```ts
import { defineTrainable } from "ts-autocode";

export const routeToken = defineTrainable("router.route");
```

The token contains a serializable `id` and a stable `Symbol.for(...)` symbol.
Use one token for every region and eval case belonging to the same trainable
unit.

## Mark the generated region

```ts
export class Router {
  // autocode:generated-region begin region=route owner=training
  route(input: string) {
    return "fallback";
  }
  // autocode:generated-region end region=route
}
```

```ts
const region = findGeneratedRegion(source, "route", {
  artifactRef: "src/router.ts",
});
```

Only the text between those markers may be replaced. The region includes a
digest used to reject stale writes.

## Configure training

All runtime values enter through settings. The library does not read process
environment variables or maintain global provider configuration.

```ts
const training = useTraining({
  engine,
  store,
  tracer,
  variables: {
    environment: "staging",
  },
  secrets: {
    async get(name) {
      return secretManager.read(name);
    },
  },
  concurrency: 4,
  capture: {
    redact(value, field) {
      return field === "input" ? redactInput(value) : value;
    },
  },
});
```

`createTraining(settings)` is the canonical factory. `useTraining(settings)`
is equivalent syntactic sugar.

## Decorate trainable methods

The settings-bound form is concise:

```ts
class Router {
  @training.trainable({ token: routeToken, region })
  async route(input: string) {
    return classify(input);
  }
}
```

The standalone decorator is equivalent:

```ts
class Router {
  @trainable({ training, token: routeToken, region })
  async route(input: string) {
    return classify(input);
  }
}
```

Both forms preserve the method's `this`, arguments, return type, synchronous
behavior, and thrown errors. Capture writes are non-blocking; call
`training.flush()` during shutdown or before reading records.

OpenInference span kinds come from
`@arizeai/openinference-semantic-conventions`. Span, status, tracer, and
attribute types come from `@opentelemetry/api`. Captured execution traces use
AgentV's `Trace` type; this package does not redefine those models.

## Evaluate with AgentV

`training.evaluate()` calls AgentV's TypeScript SDK directly and binds every
result to the trainable token.

```ts
const evaluated = await training.evaluate(routeToken, {
  tests: [
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
  ],
  task: (input) => router.route(input),
  workers: 2,
});
```

AgentV owns eval configuration, graders, traces, scores, and result types.
`ts-autocode` only adds the trainable-token binding needed for attribution.

## Implement an engine

Any async implementation of `TrainingEngine` can optimize candidates:

```ts
const engine: TrainingEngine = {
  id: "acme/rewrite-engine",
  async optimize(request, context) {
    const apiKey = await context.secrets?.get("REWRITE_API_KEY", context.signal);
    const edits = await rewrite({
      apiKey,
      objective: request.objective,
      regions: request.regions,
      records: request.records,
      evaluations: request.evaluations,
      variables: context.variables,
    });

    return {
      id: crypto.randomUUID(),
      trainableId: request.trainableId,
      engineId: "acme/rewrite-engine",
      edits,
    };
  },
};
```

The engine receives configuration through `EngineContext`; secrets are never
added to traces, candidates, or event metadata by the core.

## Optional Ax engine

```ts
import { ai, ax } from "@ax-llm/ax";
import { createAxEngine } from "ts-autocode/ax";

const engine = createAxEngine({
  studentAI: async ({ secrets }) => {
    const apiKey = await secrets?.get("OPENAI_API_KEY");
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
    return ai({ name: "openai", apiKey });
  },
  program: () => ax("task:string, currentCode:string -> replacement:string"),
  examples: ({ request, currentSource }) =>
    request.evaluations.map(({ result }) => ({
      task: request.objective,
      currentCode: currentSource,
      expected: result.output,
    })),
  metric: ({ prediction, example }) =>
    prediction.replacement.includes(String(example.expected)) ? 1 : 0,
  input: ({ request, currentSource }) => ({
    task: request.objective,
    currentCode: currentSource,
  }),
  replacement: (output) => output.replacement,
});
```

Ax uses its real `optimize()` implementation. Independent regions run in
parallel, with an optional adapter-level concurrency limit.

## Optimize and promote

```ts
const candidate = await training.optimize({
  token: routeToken,
  objective: "Improve routing without losing the fallback",
  artifacts: { "src/router.ts": source },
});

const decision = await evaluatePromotionGate({
  candidate,
  evaluations: evaluated.evaluations,
  conformance: true,
  policy: () => deploymentPolicy.allows(candidate),
});

const promoted = promoteCandidate({
  artifacts: { "src/router.ts": source },
  candidate,
  regions: training.regions(routeToken),
  decision,
});
```

Promotion requires conformance, AgentV score/pass thresholds, and policy.
`revertPromotion(promoted.artifacts, promoted.snapshot)` restores only the
promoted regions and refuses to overwrite subsequent edits.

## Concurrency

- AgentV uses its `workers` setting for eval cases.
- `TrainingSession.optimizeAll()` runs independent training jobs concurrently.
- The Ax adapter runs independent regions concurrently.
- Both training and Ax concurrency can be capped through settings.

## Safety

- Candidates must match the trainable token.
- Records and AgentV results must match the same token.
- Every requested region must have exactly one complete-region edit.
- Region digests prevent stale writes.
- Promotion is gated and revert verifies the promoted text before restoring.
- Secrets and runtime variables are injected through settings/providers.

## Development

```bash
npm ci
npm run check
```

Tests may write generated artifacts only under `test/output/`. That directory
is ignored by Git and excluded from TypeScript compilation.

See [examples/optimize.ts](examples/optimize.ts),
[docs/architecture.md](docs/architecture.md), [CONTRIBUTING.md](CONTRIBUTING.md),
and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
