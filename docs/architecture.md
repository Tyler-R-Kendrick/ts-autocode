# Architecture

## Identity

`TrainableToken` is the join key for the system. Its string id is persisted;
its symbol provides stable runtime identity. Regions, captures, AgentV results,
optimization requests, candidates, and promotion decisions must agree on that
id.

## Runtime capture

`@trainable` wraps a class method without changing its call contract. It emits
an OpenTelemetry/OpenInference span and writes a `TrainingRecord` containing an
AgentV `Trace`. Storage is injected through `TrainingSettings` and capture
writes do not extend request latency.

The package imports telemetry types and conventions from their official
packages. It does not define another span or OTLP graph.

## Evaluation

AgentV's TypeScript `evaluate()` API runs eval cases. Inline cases receive the
trainable id in AgentV metadata, and returned `EvaluationResult` values are
bound to the same token before entering optimization or promotion.

## Engine boundary

`TrainingEngine` is an async provider interface. It receives generated regions,
captured records, AgentV results, objectives, constraints, settings variables,
an optional secret provider, and an abort signal. Ax is implemented behind the
optional `ts-autocode/ax` subpath; other engines implement the same interface.

## Concurrency

Independent eval cases, optimization jobs, and Ax region runs can execute in
parallel. Each layer exposes a concurrency setting so provider limits remain
under caller control.

## Promotion

The promotion gate checks conformance, AgentV score/pass thresholds, and caller
policy. Candidate application verifies token binding, complete-region edits,
artifact offsets, and source digests. Revert snapshots cover only promoted
regions and refuse to overwrite later changes.
