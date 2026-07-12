# Architecture

## Source identity

`TrainableToken` is the durable join key. A token id binds a trainable method to
its runtime captures, AgentV evaluations, optimizer request, candidate, and
promotion decision.

The first-statement `"use training"` directive is the consumer-facing marker.
The TypeScript compiler API discovers the enclosing method directly and records
its identity, signature, parameter declarations, return type, body offsets, and
source digest. No registration wrapper or caller-provided source metadata is
used.

## Runtime capture

The optional `@trainable()` decorator intercepts calls without accepting
capture or tracing options. Identity is inferred from the decorated class and
method; an explicit symbol identity is optional. The exported `training`
runtime works without configuration, and global `configureTraining()` settings
determine whether calls are captured or traced and how values are serialized
and redacted. The target is always the decorated method. Calls preserve `this`,
arguments, synchronous or asynchronous return behavior, and thrown errors.

Captured traces use AgentV's `Trace`; spans use official OpenTelemetry and
OpenInference APIs.

## Hot-swappable weaving

`ts-autocode-rewrite` owns candidate application. Marked methods are woven with
an AspectJS `Trainable` annotation whose around advice dispatches through a
hot-swap registry, then a single pluggable interceptor (runtime capture), then
the original implementation. `training.promote()` writes the digest-guarded
source rewrite and swaps async targets live; `revert()` restores both. All
AspectJS decorators are applied programmatically, keeping consumer projects on
standard TC39 decorators.

## Zero-config runtime patch

`ts-autocode/register` installs a `node:module` load hook that appends guarded
instrumentation to every application module containing a `"use training"`
directive, wiring each discovered class method or function declaration into the
same capture path as the decorator. It also enables background evolution by
default: after `evolution.minTraces` successful captures, the runtime runs the
same `evolve()` pipeline — replay evals, candidate verification, promotion
gate, guarded rewrite — off the hot path, reporting failures through
`onError("evolve")`. Calls made during a module's own top-level evaluation
precede its instrumentation; traffic after startup is captured. The training
runtime itself lives in the provider-neutral `ts-autocode-training` package;
`ts-autocode` wires Ax as the default engine and executor via
`provideTrainingDefaults`.

`evolve()` is the explicit runtime-to-source bridge. It converts distinct,
successful captured inputs and outputs into official AgentV eval cases, replays
them as the baseline, and evaluates generated TypeScript against those same
cases. Runtime capture never initiates a source write on its own.

## Evaluation and optimization

AgentV's TypeScript `evaluate()` API runs eval cases and binds results to the
trainable id. `TrainingEngine` is provider-neutral and returns a replacement
method implementation.

Ax is the default engine. It builds an Ax signature from the TypeScript method
signature, creates examples from runtime captures and AgentV results, and scores
candidate implementations by running them in Ax's sandbox. Applications can
replace it through the provider-neutral `engine` setting without changing
capture, evaluation, or promotion. Provider-specific options do not appear in
the root configuration contract.

Candidate bodies are evaluated separately through AgentV before promotion.
Baseline results can train the optimizer but cannot satisfy the promotion gate.
Live-trace evals use AgentV's worker pool, and optimizer requests receive both
the original traces and the bound baseline results.

## Agent harness

`ts-autocode` depends on the standalone `ts-autocode-harness` package. The
harness supports independently configured student, teacher, judge, and
adversary Deep Agents. A write-ahead bus records proposed actions before an
exact pass/fail judge decision and prevents denied agent or MXC sandbox actions
from executing. AgentV supplies objective evidence; judge rejection never invents
feedback. Teacher feedback guides the student, and judge-approved adversarial
challenges require the teacher to improve the rubric. Deep Agents and direct
application functions both implement the same Flue-style callback contract;
there is no separate agent execution path.
Agent and skill optimization are deliberately outside the harness. Consumers
may evolve agents independently and inject the resulting callbacks into the
same run contract; the library remains focused on evaluated code evolution.

Independent `optimizeAll()` requests run concurrently with a caller-controlled
limit. AgentV retains its own `workers` setting for eval parallelism.

## Promotion

Candidates can replace only the discovered method body. Application verifies the
body digest before editing. Promotion additionally requires conformance, AgentV
thresholds, and optional policy. Revert stores only the previous and promoted
method body and refuses to overwrite subsequent edits.
