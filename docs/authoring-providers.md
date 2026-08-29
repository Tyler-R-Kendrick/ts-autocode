# Authoring providers

`ts-autocode` ships working implementations of everything it needs, but none of
them are the interface. Five seams are injected, and any structurally compatible
implementation works: the runtime never imports a provider, and providers never
import each other.

This guide is for writing one. Two things before you do:

- **Every seam ships a default.** The root package wires the Ax engine, a
  sandboxed executor, the governed harness loop, guarded source rewriting, and
  an in-memory store. Implementing a seam is always opt-in, never homework;
  `test/defaults.test.ts` enforces that a zero-config runtime lacks nothing but
  a credential.
- **You rarely need to name these types.** Passing an implementation inline to
  `createTrainingRuntime` or `configureTraining` gets full inference from
  contextual typing; the named types exist for implementations that live in
  their own package. An engine can be a bare function returning the new body,
  and `[input, expected]` pairs stand in for hand-built eval cases. An identity
  is **never a plain string** — that is an ADR, enforced at compile time: pass
  the trainable's symbol, its token, or the marked method itself.

```ts
import { createTrainingRuntime, defineTrainable, directExecutor } from "ts-autocode";

const training = createTrainingRuntime({
  engine: () => "return input.toUpperCase();",
  executor: directExecutor,
  source: { files: ["src/router.ts"] },
});

const run = await training.train({
  trainable: defineTrainable("Router.route").symbol,
  cases: [["abc", "ABC"], ["xyz", "XYZ"]],
});
```

Every snippet here is compiled by `test/docs.test.ts`, so it cannot drift from
the API.

## Which primitive do you want?

| You want to | Write |
|---|---|
| Use a different model or provider | **Nothing** — set `model`, see below |
| Add a rule a candidate must clear | A [`PromotionGate`](#promotiongate) |
| Call your own optimizer instead of Ax | A [`TrainingEngine`](#trainingengine) |
| Run candidate code somewhere safer | An [`ImplementationExecutor`](#implementationexecutor) |
| Change how rounds are explored | A [`TrainingLoop`](#trainingloop) |
| Write the result somewhere other than the source file | A [`Promoter`](#promoter) |
| Persist captured traces | A [`TrainingStore`](#trainingstore) |

The first row is the common wrong turn. Choosing a model is a **setting**, not a
reason to replace the engine:

```ts
import { configureTraining } from "ts-autocode";

configureTraining({
  model: { provider: "anthropic", name: "claude-sonnet-5" },
});
```

`apiKey` is optional there — it falls back to the configured `SecretProvider`,
then the environment. `teacher` names an optional stronger model for the
optimizer's teacher role. The `provider` string is handed to Ax's own provider
registry, not a list this library maintains.

When the descriptor does not fit — a self-hosted endpoint, a proxy, a client
you have already built — supply the client itself. The library then holds no
opinion about providers at all:

```ts
import { configureTraining } from "ts-autocode";

declare const myClient: { chat: (request: unknown) => Promise<unknown> };

configureTraining({
  model: { service: myClient },
});
```

`service` is carried opaquely to whichever engine is configured; the default Ax
engine accepts any `AxAIService` (or a factory returning one) and rejects
anything else with an error naming the setting.

## PromotionGate

The smallest thing most people write. A gate reads the decision context and
returns a failure reason — or `undefined` to allow. Returning a string is what
refuses; the strings land in `decision.failures` and in `PromotionRejectedError`.

```ts
import { defineTrainable, training } from "ts-autocode";

await training.train({
  trainable: defineTrainable("Router.route").symbol,
  cases: [["abc", "ABC"]],
  promotion: {
    gates: [({ candidate }) =>
      /\bfetch\s*\(/.test(candidate.implementation)
        ? "candidate makes a network call"
        : undefined],
  },
});
```

**`promotion.gates` extends the standard set** — the standard gates always run
first, then the configured policy, then yours, so a configured gate can only
ever make promotion stricter. (An earlier revision of this guide claimed the
opposite; spreading `defaultPromotionGates` into `gates` runs the defaults
twice.) Rules never mutate and never see each other; the context carries
`candidate`, `evaluations`, `results`, `conformance`, `meanScore`, `passRate`,
and the resolved `minScore` / `minPassRate` thresholds.

A gate may be async. `policy` is the deprecated spelling of the same idea — it
was always a gate that returned a boolean.

## TrainingEngine

**Default: the Ax engine — including any model or service chosen through
`model` above.** Proposes a replacement body. The only required output is a
string, and a bare `(request, context) => body` function is accepted anywhere
an engine is — the `{ id, optimize }` object form below is for engines with an
identity worth publishing.

The root README has [a complete worked example](../README.md#custom-engines).
Two things it does not cover:

```ts
import type { TrainingEngine } from "ts-autocode";

declare function callMyOptimizer(prompt: string, model: string | undefined): Promise<string>;

const engine: TrainingEngine = {
  id: "acme/optimizer",
  async optimize(request, context) {
    // Honor cancellation: the runtime aborts a round when the caller does, and
    // retrying work nobody wants costs real money.
    context.signal?.throwIfAborted();
    // `model` is the user's `TrainingSettings.model`, carried through
    // unmodified. The runtime knows nothing about any provider.
    const implementation = await callMyOptimizer(request.objective, context.model?.name);
    return { implementation };
  },
};
```

The core validates identity, source digests, and the final candidate regardless
of engine, so an engine that returns nonsense is refused rather than applied.

## ImplementationExecutor

Runs a proposed body against arguments, in isolation you own. **Default: a
sandboxed executor with a 5s timeout.** For tests and trusted local loops the
package also ships `directExecutor` — the no-isolation `new Function` runner
that every test double used to reimplement by hand — so the only reason to
write one is real isolation you own:

```ts
import { directExecutor, type ImplementationExecutor } from "ts-autocode";

declare function runInMySandbox(source: string, args: readonly unknown[], timeoutMs: number | undefined): Promise<unknown>;

const executor: ImplementationExecutor = async (target, implementation, args, options) =>
  runInMySandbox(`(${target.parameters.map((parameter) => parameter.name).join(", ")}) => { ${implementation} }`, args, options?.timeoutMs);

const testExecutor = directExecutor; // trusted candidates only
```

Rules the conformance suite enforces:

- **A throwing body must surface as a rejected promise**, not a synchronous
  throw. Callers `await` you; a synchronous throw escapes their `catch`.
- `options.timeoutMs` and `options.signal` are yours to honor. The shipped
  sandbox executor applies `execution.timeoutMs`, defaulting to 5s.
- `options.receiver` is the live `this` when a hot-swapped instance method is
  invoked. A sandboxed executor may ignore it.

The example above is deliberately the *unsafe* one — it is what a test double
looks like. A real executor runs the body in a worker, a VM context, or a
container.

## TrainingLoop

**Default: the governed harness loop; `sequentialLoop` is the simpler shipped
alternative and supports fan-out.** Orchestrates propose/review rounds. The runtime owns proposing and reviewing;
the loop owns iteration and stopping.

The root README has [a complete worked example](../README.md#extending-the-library)
using `createCandidateReview`, which builds the `CandidateReview` a loop must
return without any casts. The shapes you are handed:

```ts
import type { ProposalTurn, ReviewContext, TrainingLoopInput } from "ts-autocode";

declare const input: TrainingLoopInput;
// `slot` is the 1-based fan-out slot, always 1 without fan-out; `feedback`
// carries failure strings from earlier reviews of rejected candidates.
declare const turn: ProposalTurn;   // { round, slot, feedback, signal? }
declare const review: ReviewContext; // { label, signal? }
```

The one rule no type expresses:

> **The winning round must be last.** When a loop returns `outcome: "ready"`,
> the runtime activates `rounds.at(-1)`. A loop that finds a winner in round 2,
> keeps exploring, and returns all four rounds in order will activate round 4's
> candidate instead.

Also honor `input.signal`, and treat `maxRounds` and `fanOut` as budgets rather
than suggestions — `sequentialLoop` supports fan-out; the default governed
harness loop reviews one candidate per round and refuses more.

## Promoter

*(Formerly `PromotionApplier`; the old name remains as a deprecated alias.)*

Applies a gate-approved candidate, undoably. **Default: guarded source
rewriting from `ts-autocode-rewrite`, which refuses to write over a body that
changed since discovery.** How it applies is the provider's
concern — the shipped one rewrites the source file; yours could open a pull
request or patch a running process. Training requires only that it be reversible.

```ts
import { readFile, writeFile } from "node:fs/promises";
import type { Promoter } from "ts-autocode";

declare function patch(source: string, implementation: string): string;

const applier: Promoter = async (candidate, decision) => {
  // A decision names the candidate it was made about. Applying it to a
  // different one would write code that never passed a gate.
  if (!decision.promote || decision.candidateId !== candidate.id) {
    throw new Error(`candidate has not passed the promotion gate: ${candidate.id}`);
  }
  const artifact = candidate.target.artifactRef;
  const before = await readFile(artifact, "utf8");
  await writeFile(artifact, patch(before, candidate.implementation), "utf8");
  return {
    rollback: async () => { await writeFile(artifact, before, "utf8"); },
  };
};
```

The returned `rollback` is what `Activation.rollback()` calls. The shipped
applier refuses to roll back over an edit made after activation, by comparing
body digests; if yours writes to something a human can also edit, do the same.

## TrainingStore

**Default: `MemoryTrainingStore`, in-memory and volatile.** Two methods:

```ts
import type { TrainingRecord, TrainingStore } from "ts-autocode";

class ArrayStore implements TrainingStore {
  readonly #records: TrainingRecord[] = [];

  async append(record: TrainingRecord): Promise<void> {
    this.#records.push(structuredClone(record));
  }

  async list(trainableId?: string): Promise<readonly TrainingRecord[]> {
    // Never hand back live internal state: one caller's mutation would
    // corrupt every other reader.
    const all = this.#records.map((record) => structuredClone(record));
    return trainableId === undefined
      ? all
      : all.filter((record) => record.trainableId === trainableId);
  }
}
```

Rules the conformance suite enforces: **append order is preserved**, `list()`
does not alias internal state, and an omitted `trainableId` returns everything
while a given one filters. Training reads captured traces back as eval cases,
so a store that reorders or drops records silently changes what a candidate is
trained to reproduce.

## Registering what you wrote

Three ways in, for three different situations:

```ts
import { configureTraining, createTrainingRuntime } from "ts-autocode";
import type { ImplementationExecutor, PromotionApplier, TrainingEngine } from "ts-autocode";

declare const engine: TrainingEngine;
declare const executor: ImplementationExecutor;
declare const promote: PromotionApplier;

// Isolated: owns its settings, store and evolution state, registers nothing
// globally. Use this in tests and multi-tenant hosts.
const runtime = createTrainingRuntime({
  engine,
  executor,
  promote,
  execution: { timeoutMs: 10_000 },
  source: { files: ["src/router.ts"] },
  onEvent: (event) => console.log(event.type),
});

// Process-wide: what an application does once at startup. Replaces the
// previous settings unless you pass `{ merge: true }`.
configureTraining({ engine });
```

The third is `provideTrainingDefaults`, which supplies *lazy fallbacks* rather
than settings. It is for provider packages — `ts-autocode` itself calls it to
wire the Ax engine, its sandbox executor, the harness loop, and the rewrite
applier — not for applications. Explicit settings always win over it.

`resetTraining()` discards the process-wide runtime and its settings, restoring
the state of a fresh import. Without it, one test's `configureTraining` call is
visible to every later one.

## Proving it conforms

Types cannot state "the winning round must be last", or "append order is
preserved". Those rules are carried by a conformance kit that ships with the
package, so you can check your implementation against the same suite the
built-in providers are checked against:

```ts
import { trainingStoreContract, type TrainingStore } from "ts-autocode";

declare function it(name: string, body: () => Promise<void>): void;
declare function makeMyStore(): TrainingStore;

for (const check of trainingStoreContract) {
  it(check.name, () => check.run(() => makeMyStore()));
}
```

Deliberately framework-agnostic: a check is `{ name, run(subject) }` and throws
on violation, so it works under Vitest, Jest, `node:test`, or a bare loop.

One suite per seam — `trainingEngineContract`,
`implementationExecutorContract`, `trainingLoopContract`,
`promoterContract`, `trainingStoreContract` — plus `conformanceSuites`,
which bundles all five. Fixtures let you build a subject without a checkout of
this repo:

```ts
import { conformanceCandidate, conformanceTarget } from "ts-autocode";

// A discovered target and a candidate patch for it, ready to hand to an
// executor or an applier under test.
const target = conformanceTarget;
const candidate = conformanceCandidate("return input.toUpperCase();");
```

`conformanceAsyncTarget` is the same for a method returning a promise.

These suites are also how this repo checks its own providers: `test/contract.test.ts`
runs every shipped implementation through them, alongside a deliberately
different second store — a suite that only ever sees one shape is describing
that shape rather than a contract.
