# Architecture

The library has one pipeline:

```text
marked source -> GeneratedRegion -> Ax optimization -> CandidatePatch -> guarded apply
```

## Region boundary

`findGeneratedRegion` returns offsets, ownership, and a digest of the current
region body. The digest is the optimistic-concurrency token used when a
candidate is applied.

## Ax adapter

`optimizeRegions` accepts Ax programs, examples, metrics, and AI services. It
calls Ax's `optimize()` for every region. Each optimized program performs one
final forward pass whose output is mapped to a region replacement.

Regions are independent work units. They run concurrently by default, with an
optional concurrency cap for provider limits.

## Apply boundary

`applyCandidate` accepts full artifact text, the candidate, and the original
regions. It verifies that each edit:

- targets a requested region;
- covers the full region;
- appears exactly once; and
- still matches the region's source digest.

Edits are applied from the highest offset to the lowest so earlier offsets do
not move.

## Observability

The optimizer uses `Tracer`, `Span`, and `SpanStatusCode` from
`@opentelemetry/api`. Ax owns its lower-level LLM and optimizer telemetry. The
library does not define an OTLP transport model or duplicate OpenTelemetry
interfaces.
