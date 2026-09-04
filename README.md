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
`TrainingLoop`. The harness's single callback loop coordinates student,
teacher, judge, and adversary callbacks over a durable agent message bus, with
optional MXC-sandboxed execution. It creates no agents of its own: consumers
supply callbacks from their own agent lifecycle or optimization pipeline
without coupling it to this code-evolution library.

## Install

```bash
npm install ts-autocode
```

Node.js 20 or newer is required.

## Command line

```bash
npx ts-autocode discover
```

`discover` lists every method the project marks and prints the exact identity
to bind evals to, the one place this otherwise type-safe design falls back to
a string, where a typo yields a different symbol with no error:

```text
Router.route  src/router.ts
              route(input: string): string

1 trainable.

Bind evals with your own symbol key:
  export const route: unique symbol = Symbol("route");
  // @trainable(route) on Router.route, then:
  await training.train(route, { /* ... */ });
```

`ts-autocode status` reports how many traces each trainable has captured, which
is what background evolution counts against `evolution.minTraces`. Both accept
`--cwd`, `--project`, `--file` (repeatable), `--output-dir`, and `--json`.

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
the decorator itself, an alternative marker to the directive. Identity
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

Declare your own `unique symbol` and hand it to the decorator. The symbol is
the key. `@trainable(route)` registers the method under it, and every training
API reuses the *same* symbol, so discovery is plain symbol-key indexing and
the symbol's object identity is the uniqueness guarantee. The durable string
id the machinery needs (for stores and source rewriting) is derived from the
declaring class and method, so you never type a name anywhere:

```ts
import { trainable } from "ts-autocode";

export const route: unique symbol = Symbol("route");

class Router {
  @trainable(route)
  route(input: string): string {
    return input;
  }
}
```

The same symbol binds the method, its captures, AgentV results, optimizer
candidate, and promotion decision. Evals, tests, and training all key off it
to target exactly this trainable. The binding registers at first construction
of the class.

## Train and activate

AgentV owns eval definitions, graders, traces, scores, and result types. The
`training` export is ready to use without any setup call.

`train` takes the same symbol `@trainable(route)` put on the code, never a
raw string. Symbol in the decorator, symbol at the call: one key, indexed.

```ts
import { trainable, training } from "ts-autocode";

export const route: unique symbol = Symbol("route");

class Router {
  @trainable(route)
  route(input: string): string {
    "use training";
    return input.includes("invoice") ? "billing" : "fallback";
  }
}
void new Router();

const run = await training.train(route, {
  objective: "Preserve correct billing and fallback routing",
  cases: [
    ["Where is my invoice?", "billing"],
    ["Reset my password", "fallback"],
  ],
  promotion: {
    // Any extra rule a candidate must clear, on top of the standard gates.
    gates: [({ candidate }) => candidate.implementation.length < 4_000 ? undefined : "candidate too large"],
  },
});

const activation = await run.activate();

// Refuses to overwrite later changes.
await activation.rollback();
```

The identity is never a plain string. That is an ADR, enforced at compile
time: a string is not a sufficient identity to guarantee uniqueness. The key
is the symbol you declared (as above); the marked method itself also works,
since instrumentation stamps it with the identity it registered:

```ts
import { training } from "ts-autocode";

declare class Router { route(input: string): string; }

await training.train(Router.prototype.route, { cases: [["a", "a"]] });
```

`cases` are `[input, expected]` pairs that become equality eval cases,
evaluated exactly as replayed live traffic is. `evaluation.tests` with
explicit asserts and a `task` remains the escape hatch when a case is not
input/expected equality.

Activating a training run writes the gated source rewrite and, for async
targets, hot-swaps the running implementation through `ts-autocode-rewrite`'s
AspectJS advice: woven methods dispatch to the promoted candidate immediately,
no restart required. `activate()` throws unless the final candidate passed the
promotion gate, and the returned activation's `rollback()` restores both the
source and the live implementation.

## Zero-config evolution

Load the runtime patch once and directive-marked functions evolve from live
traffic with no further code: capture, training, verification, gating, and the
guarded source rewrite all apply automatically:

```bash
node --import ts-autocode/register ./dist/server.js
```

> This entry point installs a synchronous module load hook via
> `module.registerHooks`, which needs **Node 22.15 or newer**. The rest of
> `ts-autocode` works on Node 20; on an older runtime this entry says so and
> points at the `@trainable()` decorator, which needs no load hook.

The register hook instruments every `"use training"` function at module load.
Once a trainable accumulates `evolution.minTraces` successful traces (default
3), it is trained against those traces, verified candidate-bound, and gated.
Its source body is rewritten only when the gate passes. Failures surface
through `TrainingSettings.onEvent` (and the deprecated `onError` with the
`"evolve"` phase) and never block or alter application calls. Loading the hook is itself the opt-in, so evolution is on unless you turn it
off: set `TS_AUTOCODE_EVOLVE` to `0`, `false`, `off`, `no`, or `disabled` (or
configure `evolution: { enabled: false }`) to capture without rewriting, and use
`evolution.onEvolved` to observe applied rewrites. Because the feature rewrites
your source, the switch fails closed: an unrecognized value throws rather than
being read as consent.

## Train from live traces

Training, optimization, and evolution are one operation. `train()` without
explicit `evaluation.tests` runs the same loop against captured traffic: it
turns successful captured calls into AgentV equality evals, trains a
replacement, verifies the candidate against the same cases, and applies the
promotion gate. Activating the run then updates the marked TypeScript body.

```ts
import { training } from "ts-autocode";

// Under `--import ts-autocode/register`, the instrumented method itself is
// an identity: it carries the id the machinery derived from the source.
declare const router: { route(input: string): string };

const run = await training.train(router.route, {
  objective: "Preserve routing behavior observed in production",
  minTraces: 20,
  evaluation: {
    workers: 4,
    outputDir: ".agentv/live-router",
  },
});

const activation = await run.activate();
console.log(activation.run.final.candidate.id);
```

Only successful traces with both captured input and output become eval cases.
Repeated inputs use the latest observed output, avoiding contradictory replay
cases. Capture redaction and serialization still come from global settings, so
secrets do not need to enter optimizer or eval artifacts. `activate()` refuses
to write unless the candidate passed candidate-bound AgentV evals and every
configured promotion policy.

Training rounds run through the provider-neutral `TrainingLoop` contract.
This package registers `createHarnessLoop()` as the default, so
`ts-autocode-harness` owns bounded rounds, feedback, cancellation, and stall
detection. By default, training reviews serve as the harness's evidence,
though a configured judge may decide differently: a candidate
passes exactly when its review reports no gate failures, accepted candidates
are re-reviewed by an isolated adversary, and a standing challenge tightens
the rubric before the next round. Baseline results are never treated as proof
that a rewrite passes. Set `TrainingSettings.loop` to substitute your own
orchestration; the lower-level `evaluate` and `ts-autocode-rewrite`
promotion primitives also remain available.

The built-in loop is an observable round sequence (`trainingRounds()`
pushes each reviewed round to a subscriber; `sequentialLoop` collects the
subscription into one run). `TrainInput.rounds.fanOut` caps how many candidates a
round proposes and reviews concurrently. The best gated candidate wins the
round. Fan-out belongs to `sequentialLoop`: the default governed harness loop
reviews exactly one candidate per round, because its judge, adversary and
rubric-revision sequence is serial, so it **rejects** a `fanOut` above 1 rather
than accepting one it would ignore. `TrainInput.promotion.gates` appends custom
promotion rules to the standard `defaultPromotionGates` set; the deprecated
`policy` runs as one such rule.

No Ax program is supplied by the caller. The default engine derives its fields,
descriptions, executable examples, and return contract from the TypeScript
method signature. Ax optimizes the generated program, and its metric executes
proposed bodies in Ax's JavaScript sandbox against captured and AgentV examples.

## Configuration

Runtime dependencies enter through `TrainingSettings`:

- `engine` replaces the default Ax implementation with any `TrainingEngine`.
- `loop` replaces the default harness orchestration with any `TrainingLoop`.
- `model` selects the provider and model the engine uses; see below.
- `secrets` and `variables` are passed to engine factories without entering traces.
- `store`, `capture`, and `tracing` configure recording globally.
- `resilience` attaches named timeout/retry policies to runtime operations:
  `propose` (the engine/LLM call), `evaluate` (each candidate execution inside
  an eval run), and `store` (capture writes). A policy composes a per-attempt
  `timeoutMs` (surfacing as a typed `OperationTimeoutError`) with jittered
  exponential-backoff retries; operations without a policy behave exactly as
  before. For example, to retry rate-limited proposals up to three times with
  a 30-second cap per attempt:

  ```ts
  import { configureTraining } from "ts-autocode";

  configureTraining({
    resilience: {
      propose: { timeoutMs: 30_000, retry: { attempts: 3 } },
    },
  });
  ```

- `execution` shapes each candidate run inside the executor. `timeoutMs` caps a
  single execution (default 5 seconds), distinct from
  `resilience.evaluate.timeoutMs`, which bounds the whole attempt and may retry
  it. `decodeArgs` turns an eval case's string input into the trainable's
  argument list; see below.
- `source` overrides TypeScript project discovery when the default `tsconfig.json`
  is not the desired project.
- `outputDir` relocates run artifacts and eval output (default `.agentv`,
  exported as `defaultOutputDir`); a run's `EvalConfig.outputDir` still
  overrides it. Every `createHarnessLoop` collaborator is injectable:
  `storage` builds the [unstorage](https://unstorage.unjs.io) instance backing
  a run's write-ahead bus with any driver (unset, the fs driver under
  `<outputDir>/harness-actions`), `judge` gates every harness action and
  verdict, and `contextProvider` replaces the default rolling-window context
  management (`windowedContext`), for example with a rolling-summary reducer.

AgentV's `workers` option parallelizes live-trace and candidate evals. Independent
trainables can be trained concurrently by the application, while the configured
engine and store remain injectable.

Round and promotion options are grouped on `TrainInput`:

```ts
import { training, type TrainInput } from "ts-autocode";

declare const base: TrainInput;

await training.train({
  ...base,
  rounds: { max: 5, fanOut: 1 },
  promotion: {
    minScore: 0.9,
    minPassRate: 1,
    gates: [({ candidate }) => candidate.implementation.includes("eval(") ? "no eval" : undefined],
  },
});
```

The flat `maxRounds`, `fanOut`, `minScore`, `minPassRate`, `gates`, and `policy`
still work and are deprecated. A `policy` was always a gate that returns a
failure when it refuses, so one `gates` list now expresses both.

### Scoping a runtime

`configureTraining(settings)` configures one process-wide runtime, which the
exported `training` const delegates to, and **replaces** the current settings.
Pass `{ merge: true }` to layer onto what is already configured, and
`resetTraining()` to restore a fresh-import state, useful between tests.

For a runtime that registers nothing globally (a test, or a host serving
several tenants side by side), use `createTrainingRuntime(settings)`. Provider
defaults still apply, so it gets the Ax engine and governed loop from
`import "ts-autocode"` exactly as the shared runtime does.

```ts
import { createTrainingRuntime } from "ts-autocode";

const tenant = createTrainingRuntime({ outputDir: ".agentv/tenant-a" });
```

### Choosing a model

`model` selects the provider and model the configured engine uses. Choosing one
does not mean replacing the engine:

```ts
import { configureTraining } from "ts-autocode";

configureTraining({
  model: {
    provider: "anthropic",
    name: "claude-sonnet-4-5",
    // A stronger model for the optimizer's teacher role, if you want one.
    teacher: { provider: "anthropic", name: "claude-opus-4-1" },
  },
});
```

The descriptor is provider-neutral (`ts-autocode-training` carries it to
whatever engine is configured, exactly as it carries `secrets` and
`variables`), and the default Ax engine interprets `provider` as an Ax
provider name (`openai`, `anthropic`, `google-gemini`, `azure-openai`,
`cohere`, `mistral`, `deepseek`, `reka`, `grok`, ...).

Credentials resolve in order: an explicit `model.apiKey`, then the configured
secret provider, then the environment variable conventional for that provider
(`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, and so on). With nothing configured the
default is OpenAI reading `OPENAI_API_KEY`.

The descriptor is sugar, not a support matrix. When it does not fit (a
self-hosted endpoint, a proxy with its own auth, a client you have already
built), supply the client itself as `model.service` and the library holds no
opinion about providers at all. The default Ax engine accepts any
`AxAIService`, or a factory returning one:

```ts
import { configureTraining } from "ts-autocode";
import { ai } from "@ax-llm/ax";

configureTraining({
  model: {
    service: ai({ name: "openai", apiKey: process.env.MY_PROXY_KEY ?? "", apiURL: "https://llm.internal.example" }),
  },
});
```

For Ax-specific tuning beyond model choice (optimizer options, a separate
teacher service), the `ts-autocode/ax` adapter builds an engine you pass
through the provider-neutral `engine` slot:

```ts
import { configureTraining } from "ts-autocode";
import { createAxEngine } from "ts-autocode/ax";
import { ai } from "@ax-llm/ax";

configureTraining({
  engine: createAxEngine({
    studentAI: ai({ name: "openai", apiKey: process.env.OPENAI_API_KEY ?? "" }),
    optimize: { verbose: true },
    executionTimeoutMs: 10_000,
  }),
});
```

Configuration is optional: the exported `training` runtime works out of the
box, and `configureTraining(settings)` only overrides its settings. The default
Ax implementation reads `OPENAI_API_KEY` from the configured secret provider or
process environment.
All cross-package wiring lives in this root package: importing `ts-autocode`
connects `ts-autocode-rewrite` (interception into runtime capture, the guarded
promotion applier) and `ts-autocode-harness` (governed rounds) into
`ts-autocode-training`'s provider slots. The training package itself has no
knowledge of weaving or rewriting; the `trainable` decorator and load-time
instrumentation live here, next to that wiring. The sibling packages never
import each other, so any structurally compatible implementation can replace
them.
Provider-specific Ax tuning remains isolated to the optional `ts-autocode/ax`
adapter and is passed through the provider-neutral `engine` slot.

## Custom engines

Custom engines return only the new method implementation:

```ts
import type { TrainingEngine } from "ts-autocode";

// Your own optimizer call, whatever produces a replacement method body.
declare function rewrite(request: {
  signature: string;
  implementation: string;
  objective: string;
  evaluations: unknown;
  secrets: unknown;
}): Promise<string>;

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

## Evaluation arguments

AgentV evaluation is string-in, string-out. By default an eval input is
`JSON.parse`d and a resulting array is spread as the trainable's arguments,
which is a guess: a function taking the single string `"[1,2]"` receives two
numbers instead. Replace it when your arguments are not what the guess
produces:

```ts
import { configureTraining } from "ts-autocode";

configureTraining({
  // Pass the raw eval input through as one string argument.
  execution: { decodeArgs: (input) => [input] },
});
```

## Extending the library

Implementing a custom `TrainingLoop` means returning a `CandidateReview`
containing a `TrainableEvalRun`. Builders construct both, so extending the
library never requires a cast:

```ts
import { createCandidateReview, type CandidatePatch, type TrainingLoop } from "ts-autocode";

const loop: TrainingLoop = async (input) => {
  const candidate: CandidatePatch = await input.propose({ round: 1, slot: 1, feedback: [] });
  const review = createCandidateReview({ candidate, failures: ["not tried yet"] });
  return { outcome: "exhausted", rounds: [{ round: 1, candidate, ...review }] };
};
```

`createEvalRun` and `createPromotionDecision` build the parts individually when
you have real evidence to carry.

[docs/authoring-providers.md](docs/authoring-providers.md) covers all five
injected seams (engine, executor, loop, promotion applier and store) with the
rules each one must satisfy and the conformance suites that check them.

## Errors

Every failure this library raises is a `TsAutocodeError` carrying a `code` you
can switch on, so telling "not enough traces" from "no engine configured" from
"the gate refused" no longer means matching on message text. Errors that have
always been `TypeError`s or `SyntaxError`s still are, and every message string
is unchanged, so existing `catch` blocks keep working.

```ts
import {
  InsufficientTracesError,
  isTsAutocodeError,
  PromotionRejectedError,
  training,
} from "ts-autocode";

declare const input: Parameters<typeof training.train>[0];

try {
  const run = await training.train(input);
  await run.activate();
} catch (error) {
  if (error instanceof InsufficientTracesError) {
    console.log(`need ${error.required} traces, have ${error.found}`);
  } else if (error instanceof PromotionRejectedError) {
    console.log(error.failures);
  } else if (isTsAutocodeError(error)) {
    console.log(error.code);
  } else {
    throw error;
  }
}
```

`activate()` throwing is the ergonomic path, not the only one:
`run.canActivate()` reports the same decision without an exception, which is
what you want when `"stalled"` and `"exhausted"` are ordinary outcomes rather
than surprises.

```ts
import { training } from "ts-autocode";

declare const input: Parameters<typeof training.train>[0];

const run = await training.train(input);
const readiness = run.canActivate();
if (readiness.ready) await run.activate();
else console.log(readiness.outcome, readiness.failures);
```

## Background events

`TrainingSettings.onEvent` reports everything the runtime does off the call
path, including capture and store failures and the full evolution lifecycle:

```ts
import { configureTraining } from "ts-autocode";

configureTraining({
  onEvent: (event) => {
    switch (event.type) {
      case "evolution.started": return console.log("training", event.trainable.id);
      case "evolution.applied": return console.log("rewrote", event.trainable.id);
      case "evolution.skipped": return console.log(`${event.traces}/${event.required} traces`);
      case "evolution.failed": return console.error(event.error);
      default: return undefined;
    }
  },
});
```

`onError` still works and is a projection of the same stream: it receives every
event carrying an `error`, with the phase it always did.

## Import surface

| Import | For |
|---|---|
| `ts-autocode` | Everything an application needs: the directive, `@trainable`, `training`, settings, errors. |
| `ts-autocode/internal` | Author-level seams: building an engine, loop, executor, store, or instrumentation mechanism. |
| `ts-autocode/ax` | Tuning the default Ax engine. |
| `ts-autocode/grounding` | Grounding decorators and ambient-class scanning. |
| `ts-autocode/register` | The zero-config runtime patch (`node --import`). |
| `npx ts-autocode` | `discover` and `status` from the command line. |

Everything on `/internal` is still exported from the root, so no existing
import breaks; the subpath exists so that what an application imports is only
what an application needs.

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
