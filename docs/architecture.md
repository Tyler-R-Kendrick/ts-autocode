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

The optional `@trainable(id)` decorator adds runtime capture when an application
needs it. It infers the target from the decorated method and accepts no source
region. Calls preserve `this`, arguments, synchronous or asynchronous return
behavior, and thrown errors. Capture storage is asynchronous and configurable.

Captured traces use AgentV's `Trace`; spans use official OpenTelemetry and
OpenInference APIs.

## Evaluation and optimization

AgentV's TypeScript `evaluate()` API runs eval cases and binds results to the
trainable id. `TrainingEngine` is provider-neutral and returns a replacement
method implementation.

Ax is the default engine. It builds an Ax signature from the TypeScript method
signature, creates examples from runtime captures and AgentV results, and scores
candidate implementations by running them in Ax's sandbox. Applications can
replace the engine without changing capture, evaluation, or promotion.

Candidate bodies are evaluated separately through AgentV before promotion.
Baseline results can train the optimizer but cannot satisfy the promotion gate.

Independent `optimizeAll()` requests run concurrently with a caller-controlled
limit. AgentV retains its own `workers` setting for eval parallelism.

## Promotion

Candidates can replace only the discovered method body. Application verifies the
body digest before editing. Promotion additionally requires conformance, AgentV
thresholds, and optional policy. Revert stores only the previous and promoted
method body and refuses to overwrite subsequent edits.
