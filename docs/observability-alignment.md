# Observability alignment: what a trajectory collects, and why

Trajectories are the evidence the optimizer learns from. This document maps
the trajectory schema (v2) against the current GenAI observability standards
and platforms, states the **collection policy**, and records what is
intentionally out of scope.

Researched sources: [OTel GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai)
(`gen_ai.*`; spans/metrics/events; status **Development**) ·
[OTel GenAI blog](https://opentelemetry.io/blog/2024/otel-generative-ai/) ·
[OpenInference spec](https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md) ·
[LangSmith observability concepts](https://docs.langchain.com/langsmith/observability-concepts) ·
[Langfuse data model](https://langfuse.com/docs/observability/data-model).

## Collection policy

1. **Collect more than necessary.** The schema is a deliberate superset of
   what any single improvement methodology needs today. Cost/latency-aware
   optimization, preference-pair mining, multi-metric eval gating, and
   session-level credit assignment all read from the same capture.
2. **Never bet on one vocabulary.** Capture and export emit **both** OTel
   `gen_ai.*` and OpenInference `llm.*` attribute keys
   (`dualConventionAttributes`); ingest reads either
   (`fromConventionAttributes`). A shift in which convention wins never
   forces recapture.
3. **Validation never strips unknown attributes.** Span `attributes` are open
   maps; extra keys ride along through capture, hashing, export, and ingest.
4. **Content capture is mode-gated** (`contentCapture: "inline" | "ref" |
   "none"`), mirroring OTel's opt-in guidance — with our redaction rules on
   top (sensitive payloads must be tokenized or run-scoped-encrypted and must
   not retain raw values).
5. **Attribution is mandatory.** Every trajectory names the
   `code.regionDigest` (and optionally `candidateId` + `arm`) of the code
   that produced it. Evolution without attribution is noise.

## Field-by-field comparison

| Signal | ts-autocode v2 | OTel GenAI | OpenInference | LangSmith | Langfuse |
|---|---|---|---|---|---|
| Trace correlation | `traceparent` (W3C), span `traceId` | W3C context | OTel-native | run/trace ids | trace ids |
| Step tree | `spans[]` (parentId tree) | spans | spans + kinds | runs (nested) | observations (nested) |
| Step kind | `openinference.span.kind` (required) | `gen_ai.operation.name` | `openinference.span.kind` | run type | observation type |
| Model | `genAi.requestModel` / `responseModel` (**required on LLM spans**) | `gen_ai.request.model` / `gen_ai.response.model` | `llm.model_name` | invocation params | `model` |
| Provider | `genAi.provider` | `gen_ai.provider.name` | `llm.provider` / `llm.system` | — | — |
| Invocation params | `genAi.invocationParameters` | `gen_ai.request.temperature/top_p/…` | `llm.invocation_parameters` | invocation params | `modelParameters` |
| Token usage | `genAi.usage` (**required on LLM spans**) + trajectory rollup | `gen_ai.usage.input_tokens/output_tokens/cache_read/reasoning` | `llm.token_count.*` | token usage | `usageDetails` |
| Cost | `genAi.cost` + rollup `costUsd` | — (derived) | `llm.cost.*` | cost | `costDetails` |
| Latency | span times + rollup `latencyMs` | span duration | span duration | run times | observation times |
| Messages | `genAi.inputMessages/outputMessages/systemInstructions` (`{ref}` supported) | `gen_ai.input.messages/output.messages/system_instructions` (opt-in) | `llm.input_messages.*` | inputs/outputs | input/output |
| Errors | span `status` + `Feedback{kind:"error"}` | `error.type`, span status | `exception.*` | error field | level/statusMessage |
| Evaluation | `scores[]` (name, numeric/categorical/boolean value, source, comment, rubricRef) | evaluation events | EVALUATOR spans | feedback (key/score/comment) | scores (typed, comment, source) |
| Session/user | `context.session.id` / `context.user.id` | `gen_ai.conversation.id` | `session.id` / `user.id` | thread/session metadata | sessions/users |
| Tags/metadata | `context.tags` / `context.metadata` | — | `tag.tags` / `metadata` | tags/metadata | tags/metadata |
| Environment/release | `context.environment` / `context.release` | resource attrs | — | metadata | environments/releases |
| Redaction | payload classification + tokenized/encrypted refs; content-capture modes | opt-in content, external storage refs | — | — | masking |
| **Code attribution** | **`code.regionDigest` + `candidateId` + `arm` (required)** | — | — | — | release/version (app-level) |
| Audit | hash-verified event log, replay, evidence recovery | — | — | — | — |

The last two rows are where ts-autocode deliberately exceeds the standards:
platforms version the *application*; the evolution loop must version the
*generated region* per invocation, and must be able to prove which
trajectories justified which candidate.

## Interop surfaces

- **Export** — `toOtlpJson(trajectories)` emits standard OTLP/JSON
  (`resourceSpans` → `scopeSpans` → spans with KeyValue attributes, nano
  timestamps, status codes). Attributes carry both vocabularies plus
  `autocode.*` binding attributes; scores/feedback ride as span events.
  Any OTel collector — and OTLP ingesters like Langfuse or Arize Phoenix —
  can consume it. Raw sensitive payload values are **never** exported, only
  their run-scoped refs.
- **Ingest** — `fromOtelSpans(otlpJson, { bind? })` rebuilds trajectories:
  round-trips our own export losslessly via the `autocode.*` attributes, and
  adopts foreign `gen_ai.*` / OpenInference instrumentation when the caller
  supplies the region/code binding. Unmappable traces are reported in
  `skipped`, never silently dropped.
- **Gate bridge** — `evalResultFromScores(scores, …)` aggregates captured
  scores into the three-lens gate's `EvalResult`.

## Intentionally out of scope (for now)

- **Metrics pipeline** — OTel GenAI defines client metrics
  (`gen_ai.client.token.usage`, `gen_ai.client.operation.duration`); these
  are derivable from the trajectory/event log, and emitting OTel metrics is a
  consumer concern. `aggregateTrajectoryUsage` provides the rollup.
- **OTLP protobuf** — export is OTLP/JSON only; collectors re-encode.
- **Platform-specific APIs** — no LangSmith/Langfuse SDK clients; both ingest
  OTLP, which is the interop surface we standardize on.
