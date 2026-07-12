# ts-autocode

Train TypeScript functions from AgentV evals and captured runtime traces, then
safely rewrite the function marked trainable.

The normal path keeps the code primitives and agent loop in separate packages:

```text
"use training" -> AgentV evals -> governed training harness -> guarded source update
```

Ax is the default student optimizer. AgentV evaluation and the promotion gate
form the teacher. The provider-neutral runtime lives in the independent
`ts-autocode-training` package; guarded rewriting and hot-swappable AspectJS
interception live in `ts-autocode-rewrite`; governed agent coordination lives
in the independent `ts-autocode-harness` package. This package specifies the
connections: it re-exports the training runtime with Ax registered as the
default engine and executor and the harness adapted as the default
`TrainingLoop`. The harness's single Flue-style callback loop supports
configurable student, teacher, judge, and adversary Deep Agents, MXC
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

When no symbol is passed, one is auto-generated for the decorated method: the
identity above is `Router.route`, and `defineTrainable("Router.route").symbol`
recreates its stable symbol anywhere. Pass a symbol explicitly for a durable
id detached from the class name:

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
same symbol binds the method, its captures, AgentV results, optimizer
candidate, and promotion decision — so evals, tests, and training reuse it to
target exactly this trainable, binding evals to a training target at test time
instead of only iterating during runtime.

## Train and promote

AgentV owns eval definitions, graders, traces, scores, and result types. The
`training` export is ready to use without any setup call.

`train` takes the trainable's symbol (or its full token), never a raw string.
Reusing `route.symbol` — the same symbol passed to `@trainable(route.symbol)`
above — pins these evals to that exact method; for an auto-generated identity,
`defineTrainable("Router.route").symbol` recreates the symbol.

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
  trainable: route.symbol,
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

## Train from live traces

Training, optimization, and evolution are one operation. `train()` without
explicit `evaluation.tests` runs the same loop against captured traffic: it
turns successful captured calls into AgentV equality evals, trains a
replacement, verifies the candidate against the same cases, and applies the
promotion gate. `promote()` then updates the marked TypeScript body.

```ts
const run = await training.train({
  trainable: route,
  objective: "Preserve routing behavior observed in production",
  minTraces: 20,
  evaluation: {
    workers: 4,
    outputDir: ".agentv/live-router",
  },
});

const promoted = await training.promote(run.final.candidate, run.final.decision);
console.log(promoted.snapshot.candidateId);
```

Only successful traces with both captured input and output become eval cases.
Repeated inputs use the latest observed output, avoiding contradictory replay
cases. Capture redaction and serialization still come from global settings, so
secrets do not need to enter optimizer or eval artifacts. `promote()` refuses
to write unless the candidate passed candidate-bound AgentV evals and every
configured promotion policy.

Training rounds run through the provider-neutral `TrainingLoop` contract.
This package registers `createHarnessLoop()` as the default, so
`ts-autocode-harness` owns bounded rounds, feedback, cancellation, and stall
detection: the same callback path accepts arbitrary judge inputs, requires an
exact pass/fail decision, tests
approved candidates with an isolated adversary, and makes the teacher revise
the rubric when the adversary exposes an accepted gap. Baseline results are
never treated as proof that a rewrite passes. Set `TrainingSettings.loop` to
substitute your own orchestration; the lower-level `evaluate`,
`evaluateCandidate`, and promotion primitives also remain available.

No Ax program is supplied by the caller. The default engine derives its fields,
descriptions, executable examples, and return contract from the TypeScript
method signature. Ax optimizes the generated program, and its metric executes
proposed bodies in Ax's JavaScript sandbox against captured and AgentV examples.

## Configuration

Runtime dependencies enter through `TrainingSettings`:

- `engine` replaces the default Ax implementation with any `TrainingEngine`.
- `loop` replaces the default harness orchestration with any `TrainingLoop`.
- `secrets` and `variables` are passed to engine factories without entering traces.
- `store`, `capture`, and `tracing` configure recording globally.
- `source` overrides TypeScript project discovery when the default `tsconfig.json`
  is not the desired project.

AgentV's `workers` option parallelizes live-trace and candidate evals. Independent
trainables can be trained concurrently by the application, while the configured
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
