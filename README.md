# ts-autocode

Train TypeScript functions from AgentV evals and captured runtime traces, then
safely rewrite the function marked trainable.

The normal path keeps the code primitives and agent loop in separate packages:

```text
"use training" -> AgentV evals -> governed training harness -> guarded source update
```

Ax is the default student optimizer. AgentV evaluation and the promotion gate
form the teacher. The provider-neutral runtime lives in the independent
`ts-autocode-training` package (this package re-exports it with Ax wired in as
the default engine and executor), guarded rewriting and hot-swappable AspectJS
interception live in `ts-autocode-rewrite`, and iterative coordination is
delegated to the independent `ts-autocode-harness` package. Its single Flue-style callback loop
supports configurable student, teacher, judge, and adversary Deep Agents, MXC
execution, and a write-ahead approval bus. Consumers can supply callbacks from
their own agent lifecycle or optimization pipeline without coupling it to this
code-evolution library.

## Install

```bash
npm install ts-autocode
```

Node.js 20 or newer is required.

## Use the directive

Place the literal directive first in a function or method body. No import,
decorator, wrapper, registration call, or source-region argument is required.

```ts
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

## Runtime capture and the optional decorator

Runtime capture comes with marking, not as a separate opt-in: whether a method
carries the `"use training"` directive or the `@trainable()` decorator, its
calls route through the same runtime-capture interceptor. What is optional is
the decorator itself — it is an alternative marker to the directive. Identity
is inferred from the decorated class and method, so nothing is declared twice;
global configuration controls how captures are serialized, redacted, and
traced. The decorated method is the source target, so callers never provide
source metadata.

```ts
import { trainable } from "ts-autocode";

class Router {
  @trainable()
  route(input: string): string {
    return input;
  }
}
```

The inferred identity above is `Router.route`. Passing an identity is optional
and takes a symbol, for callers that need a durable id detached from the class
name:

```ts
import { defineTrainable, trainable } from "ts-autocode";

const route = defineTrainable("acme.route");

class Router {
  @trainable(route.symbol)
  route(input: string): string {
    return input;
  }
}
```

A token contains a durable string id and stable `Symbol.for(...)` symbol. The
same id binds the method, captures, AgentV results, optimizer candidate, and
promotion decision.

## Train and promote

AgentV owns eval definitions, graders, traces, scores, and result types. The
`training` export is ready to use without any setup call.

```ts
import { training } from "ts-autocode";

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

const promoted = await training.promote(run.final.candidate, run.final.decision);

// Refuses to overwrite later changes.
await training.revert(promoted.snapshot);
```

Promotion writes the gated source rewrite and, for async targets, hot-swaps the
running implementation through `ts-autocode-rewrite`'s AspectJS advice — woven
methods dispatch to the promoted candidate immediately, no restart required.
`revert()` restores both the source and the live implementation.

## Zero-config evolution

Load the runtime patch once and directive-marked functions evolve from live
traffic with no further code — capture, training, verification, gating, and the
guarded source rewrite all apply automatically:

```bash
node --import ts-autocode/register ./dist/server.js
```

The register hook instruments every `"use training"` function at module load.
Once a trainable accumulates `evolution.minTraces` successful traces (default
3), it is trained against those traces, verified candidate-bound, gated, and —
only when the gate passes — its source body is rewritten. Failures surface
through `TrainingSettings.onError` with the `"evolve"` phase and never block or
alter application calls. Set `TS_AUTOCODE_EVOLVE=off` (or configure
`evolution: { enabled: false }`) to capture without rewriting, and use
`evolution.onEvolved` to observe applied rewrites.

## Evolve from live traces explicitly

Without the register patch, `evolve()` is the explicit form of the same loop:
it turns successful captured calls into AgentV equality evals, trains a
replacement, verifies the candidate against the same cases, applies the
promotion gate, and updates the marked TypeScript body.

```ts
const result = await training.evolve({
  trainable: route,
  objective: "Preserve routing behavior observed in production",
  minTraces: 20,
  evaluation: {
    workers: 4,
    outputDir: ".agentv/live-router",
  },
});

console.log(result.promotion.snapshot.candidateId);
```

Only successful traces with both captured input and output become eval cases.
Repeated inputs use the latest observed output, avoiding contradictory replay
cases. Capture redaction and serialization still come from global settings, so
secrets do not need to enter optimizer or eval artifacts. `evolve()` refuses to
write unless the candidate passes candidate-bound AgentV evals and every
configured promotion policy.

`ts-autocode-harness` owns bounded rounds, feedback, cancellation, and stall
detection. The same callback path accepts arbitrary judge inputs, requires an
exact pass/fail decision, tests
approved candidates with an isolated adversary, and makes the teacher revise
the rubric when the adversary exposes an accepted gap. Baseline results are
never treated as proof that a rewrite passes. The lower-level `evaluate`,
`optimize`, `evaluateCandidate`, and promotion primitives remain available for
custom orchestration.

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

AgentV's `workers` option parallelizes live-trace and candidate evals. Independent
trainables can be evolved concurrently by the application, while the configured
engine and store remain injectable.

Configuration is optional: the exported `training` runtime works out of the
box, and `configureTraining(settings)` only overrides its settings. The default
Ax implementation reads `OPENAI_API_KEY` from the configured secret provider or
process environment.
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
[packages/harness/README.md](packages/harness/README.md),
[docs/architecture.md](docs/architecture.md), [CONTRIBUTING.md](CONTRIBUTING.md),
and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
