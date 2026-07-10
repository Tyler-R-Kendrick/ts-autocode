# ts-autocode

Self-evolving TypeScript, as a library. `ts-autocode` packages the
**code-evolution pattern** pioneered in [HoBo](https://github.com/Tyler-R-Kendrick/HoBo)
and inspired by [Microsoft Trace](https://github.com/microsoft/Trace):
an optimizer may rewrite designated regions of your source — and *only* those
regions — with every rewrite screened offline, gated three ways, promoted
champion/challenger style, and revertible from its event log.

## The loop

```text
declare (regions + trainable) ──▶ forward: capture trajectories ──▶ training engine (port)
        ▲                                                                 │
        │                                     candidate patch ◀───────────┘
        │                                            │
        │                    offline screen (held-out + contract) ⟲ runOptimizationLoop
        │                                            │
   live traffic ◀── promote / PR delta ◀── three-lens gate (conformance · eval · policy)
                          │
                    revert (log-driven)
```

1. **Generated regions** (`region.ts`) — the optimizer's write scope is a
   marker-delimited span of source:

   ```ts
   export function classify(input) {
     const handWrittenGuard = true;
     // autocode:generated-region begin region=classify-body owner=training-engine
     return "identity-support";
     // autocode:generated-region end region=classify-body
   }
   ```

   `findGeneratedRegion` locates it, `checkGeneratedRegionDrift` detects hand
   edits inside it, and every candidate edit is validated to stay within it.
   The marker prefix is configurable (`markerPrefix`) so existing marker
   vocabularies keep working.

2. **Trajectory capture** (`capture.ts`, `trajectory.ts`) — the forward phase.
   `trainable(fn, { runtime, run, method })` wraps an optimizable function so
   every call records a trajectory into an append-only event log; a throw is
   captured as error feedback with an ERROR span status and rethrown.
   Trajectories collect a **superset** of the GenAI observability standards:
   OpenInference span trees with OTel `status`, first-class `genAi` data per
   span (model, provider, invocation params, token usage, cost, messages —
   required on LLM spans), multiple named typed **`scores`** plus general
   `Feedback`, session/user/tags/metadata/environment/release context, a
   usage/cost/latency rollup, and mandatory **code attribution**
   (`code.regionDigest` + candidate + champion/challenger arm). Message
   content capture is mode-gated (`inline`/`ref`/`none`), and sensitive
   payloads must be tokenized or run-scoped-encrypted with no raw values
   retained. `reconstructTrajectoryFromLog` and
   `recoverCandidateTrajectorySet` are the hash-verified audit path.

3. **The training-engine port** (`engine.ts`) — any optimizer (rule deriver,
   LLM rewriter, RL trainer) implements
   `TrainingEngine.optimize(request) → CandidatePatch | Promise<CandidatePatch>`.
   Requests carry **all trainable regions jointly** (`generatedRegions`),
   optional region source text, trajectories, the rubric/contract, and
   run-level feedback. `runEngineConformance` certifies an engine as
   deterministic and region-bound before you trust it.

4. **The built-in OPTO engine** (`optimizer.ts`) — a deterministic reference
   optimizer that derives keyword→label rewrite rules from the trajectories
   the baseline got wrong and emits one full-region edit per requested
   region. `runBuiltInOptoTrainingRun` runs one offline round: optimize →
   validate patch → check contract invariants → evaluate against held-out
   trajectories → emit a replayable event log (terminal `training.Rejected`
   on failure).

5. **The iterative loop** (`loop.ts`) — Trace's `zero_feedback → backward →
   step` epochs, bounded: `runOptimizationLoop` feeds each rejected round's
   reasons back to the engine as error `Feedback` and stops on
   `ready-for-gate`, a stalled engine, or the round budget.

6. **The three-lens gate** (`gate.ts`) — `evaluatePromotionGate` promotes only
   when **conformance** is green AND every **eval** metric floor is met over
   at least the minimum sample count AND **policy** allows.
   `promotionEventNames` maps the decision to its past-tense facts.

7. **Champion/challenger promotion** (`promotion.ts`) — `shadowTraffic` runs
   the challenger without serving it; `promoteCandidate` applies a certified,
   provenance-signed candidate in place for low-risk non-prod environments
   (one revert snapshot per region), or returns a **PR delta** for prod /
   high-risk changes; `revertPromotion` restores every region from the
   `impl.Promoted` snapshots. Wire `createEd25519ProvenanceVerifier(publicKey)`
   into `verifySignature` to cryptographically verify provenance before any
   promotion.

8. **Event log** (`events.ts`) — every step is an appended `training.*` /
   `telemetry.*` fact. `replayTrainingRun` rebuilds run state from the log
   alone, and refuses to project an invalid log.

## Inspiration: Microsoft Trace

The pattern follows Trace's OPTO formulation — optimize parameters from an
execution **trace** plus general **feedback** (a score, a critique, or an
error), with swappable LLM optimizers behind one interface:

| Trace | ts-autocode |
|---|---|
| `node(…, trainable=True)` | `GeneratedRegion` — region body is the parameter |
| `@bundle(trainable=True)` | `trainable(fn, …)` capture wrapper |
| execution trace | `Trajectory` (OpenInference span tree) |
| `.backward(feedback)` | `TrajectoryReward` + `Feedback` (score/text/error) |
| OptoPrime / OPRO / TextGrad | `TrainingEngine` implementations |
| `optimizer.step()` epochs | `runOptimizationLoop` |
| OptoPrime's LLM report | `renderOptimizeReport` |
| in-place update | **gated champion/challenger promotion** (deliberate difference) |

See [`docs/trace-alignment.md`](docs/trace-alignment.md) for the full mapping,
the value propositions carried over, deliberate differences, and deferred
gaps. Links: [repo](https://github.com/microsoft/Trace) ·
[docs](https://microsoft.github.io/Trace/) ·
[paper](https://arxiv.org/abs/2406.16218) ·
[MSR blog](https://www.microsoft.com/en-us/research/blog/tracing-the-path-to-self-adapting-ai-agents/).

## Standards interop (OTel GenAI · OpenInference · LangSmith · Langfuse)

Trajectory capture is aligned with — and deliberately collects a superset of —
the current GenAI observability standards, so future improvement
methodologies and shifts in industry conventions don't force recapture:

- **Dual attribute vocabularies** — `dualConventionAttributes` stamps both
  OTel `gen_ai.*` and OpenInference `llm.*` keys on spans;
  `fromConventionAttributes` reads either back. Constants exported as
  `GEN_AI_ATTR`, `OPENINFERENCE_ATTR`, `AUTOCODE_ATTR`.
- **OTLP export** — `toOtlpJson(trajectories)` emits standard OTLP/JSON any
  OTel collector (or Langfuse/Phoenix) can ingest; scores and feedback ride
  as span events; sensitive payloads export refs only, never raw values.
- **OTLP ingest** — `fromOtelSpans(otlpJson, { bind? })` rebuilds
  trajectories: lossless round-trip of our own export via `autocode.*`
  binding attributes, or foreign `gen_ai.*`/OpenInference instrumentation
  with a caller-supplied region binding. Unmappable traces are reported, not
  dropped.
- **Gate bridge** — `evalResultFromScores` turns captured multi-metric
  scores (LangSmith-feedback / Langfuse-score shaped) into the three-lens
  gate's `EvalResult`.

The full field-by-field comparison and collection policy live in
[`docs/observability-alignment.md`](docs/observability-alignment.md).

## Usage

```ts
import {
  createBuiltInOptoEngine,
  createCaptureRuntime,
  evaluatePromotionGate,
  findGeneratedRegion,
  promoteCandidate,
  revertPromotion,
  runOptimizationLoop,
  trainable,
} from "ts-autocode";

// Declare + forward: wrap the baseline; calls record trajectories.
const region = findGeneratedRegion(source, "classify-body");
const runtime = createCaptureRuntime();
const classify = trainable(baselineClassify, {
  runtime,
  run: { id: "run-1", traceparent },
  method: { name: "classify", contractRef: "contract://classify@1.0.0", generatedRegion: region },
});

// Optimize: iterate propose → screen, feeding rejections back as feedback.
const loop = await runOptimizationLoop({
  request, // OptimizeRequest over [region] with trajectories + rubric + contract
  engine: createBuiltInOptoEngine(),
  heldOutTrajectories,
});

if (loop.outcome === "ready-for-gate" && loop.finalRun.candidate) {
  const decision = evaluatePromotionGate({
    candidateId: loop.finalRun.candidate.id,
    conformance: true,
    policy: true,
    evalResult,
    thresholds,
  });
  if (decision.outcome === "promote") {
    const promoted = promoteCandidate({
      source,
      regions: [region],
      candidate: loop.finalRun.candidate,
      gate: { effect: "certify", certified: true },
      provenance,
      verifySignature, // e.g. createEd25519ProvenanceVerifier(publicKeyPem)
      environment: "preview",
      riskClass: "low",
    });
    // promoted.source has the rewrite; promoted.events carry the revert snapshots.
  }
}
```

Bring your own engine by implementing the port — `renderOptimizeReport` turns
a request into an OptoPrime-style prompt for your LLM:

```ts
import { renderOptimizeReport, type TrainingEngine } from "ts-autocode";

const llmRewriter: TrainingEngine = {
  engineId: "acme.training-engine/llm-rewriter@1.0.0",
  async optimize(request) {
    const prompt = renderOptimizeReport(request);
    const patch = await callYourLlm(prompt); // must return a CandidatePatch
    return patch;
  },
};
```

## Guarantees

- **Region containment** — a candidate whose edits leave its named generated
  region is rejected at validation, screening, and promotion; promotion
  additionally requires exactly one full-region edit per region so revert
  snapshots always describe whole regions.
- **Determinism** — the built-in engine is byte-stable for identical requests;
  `runEngineConformance` checks the same for yours.
- **No ungated writes** — promotion requires a certified gate verdict and
  signed provenance; wire a `ProvenanceVerifier` for real Ed25519
  verification.
- **Auditability** — training runs, captures, and promotions are event logs
  first; replay, revert, and evidence recovery are derived from them, not
  from hidden state.

## Development

```sh
npm install
npm run typecheck   # src + tests
npm test            # vitest
npm run build       # emit dist/
```

## Provenance

The pattern is ported from HoBo's training-pipeline package and its draft
proofs (training-engine port, built-in OPTO engine, trajectory capture,
evals/training promotion gates, champion/challenger promotion), generalized to
be domain-neutral: schema ids live under `ts-autocode.*`, the routed-text
vocabulary is `input`/`expectedLabel`/`baselineLabel`, and region markers,
stopwords, and fallbacks are configurable. The conceptual design follows
Microsoft Trace (see above).
