# Architecture

## Source identity

`TrainableToken` is the durable join key. A token id binds a trainable method to
its runtime captures, AgentV evaluations, optimizer request, candidate, and
promotion decision.

Methods are marked with `@trainable(id)` or a first-statement `"use training"`
directive. The TypeScript compiler API discovers the method directly and records
its signature, parameter declarations, return type, body offsets, and source
digest. No marker comments or caller-provided region objects are used.

## Runtime capture

The decorator and the default `useTraining()` wrapper share the same capture
runtime. Calls preserve `this`, arguments, synchronous or asynchronous return
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
