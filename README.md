# ts-autocode

Self-evolving TypeScript, as a library. `ts-autocode` packages the
**code-evolution pattern** pioneered in [HoBo](https://github.com/Tyler-R-Kendrick/HoBo):
an optimizer may rewrite designated regions of your source — and *only* those
regions — with every rewrite screened offline, gated three ways, promoted
champion/challenger style, and revertible from its event log.

## The loop

```
capture trajectories ──▶ training engine (port) ──▶ candidate patch
        ▲                                              │
        │                              offline screen (held-out + contract)
        │                                              │
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

2. **Trajectories** (`trajectory.ts`) — evidence the optimizer learns from:
   OpenInference-kind spans, a reward in [0, 1], and named payloads with
   redaction rules (sensitive payloads must be tokenized or encrypted before
   they may enter a training run). Trajectories are content-hashed
   (`hashTrajectory`) for provenance.

3. **The training-engine port** (`engine.ts`) — any optimizer (rule deriver,
   LLM rewriter, RL trainer) implements `TrainingEngine.optimize(request) →
   CandidatePatch`. `optimizeCandidate` sandboxes the call; `runEngineConformance`
   certifies an engine as deterministic and region-bound before you trust it.

4. **The built-in OPTO engine** (`optimizer.ts`) — a deterministic reference
   optimizer that derives keyword→label rewrite rules from the trajectories
   the baseline got wrong. `runBuiltInOptoTrainingRun` runs the full offline
   loop: optimize → validate patch → check contract invariants (allowed /
   forbidden outputs, required fallback) → evaluate against held-out
   trajectories → emit a replayable event log.

5. **The three-lens gate** (`gate.ts`) — `evaluatePromotionGate` promotes only
   when **conformance** is green AND every **eval** metric floor is met over
   at least the minimum sample count AND **policy** allows. Refusals record
   the failing lenses. `promotionEventNames` maps the decision to its
   past-tense facts (`training.Promoted` + `impl.Promoted`, or `eval.GateFailed`).

6. **Champion/challenger promotion** (`promotion.ts`) — `shadowTraffic` runs
   the challenger without serving it; `promoteCandidate` applies a certified,
   provenance-signed candidate in place for low-risk non-prod environments, or
   returns a **PR delta** for prod / high-risk changes; `revertPromotion`
   restores the pre-promotion region from the `impl.Promoted` snapshot in the
   event log. Promotion is idempotent (`already-applied`).

7. **Event log** (`events.ts`) — every step is an appended `training.*` fact.
   `replayTrainingRun` rebuilds run state from the log alone, and refuses to
   project an invalid log.

## Usage

```ts
import {
  findGeneratedRegion,
  runBuiltInOptoTrainingRun,
  evaluatePromotionGate,
  promoteCandidate,
  revertPromotion,
} from "ts-autocode";

const region = findGeneratedRegion(source, "classify-body");

const run = runBuiltInOptoTrainingRun({ request, heldOutTrajectories });
if (run.outcome === "ready-for-gate" && run.candidate) {
  const decision = evaluatePromotionGate({
    candidateId: run.candidate.id,
    conformance: true,
    policy: true,
    evalResult,
    thresholds,
  });
  if (decision.outcome === "promote") {
    const promoted = promoteCandidate({
      source,
      region,
      candidate: run.candidate,
      gate: { effect: "certify", certified: true },
      provenance,
      environment: "preview",
      riskClass: "low",
    });
    // promoted.source has the rewrite; promoted.events carry the revert snapshot.
  }
}
```

Bring your own engine by implementing the port:

```ts
import type { TrainingEngine } from "ts-autocode";

const llmRewriter: TrainingEngine = {
  engineId: "acme.training-engine/llm-rewriter@1.0.0",
  optimize(request) {
    // return a CandidatePatch whose edits stay inside request.generatedRegion
  },
};
```

## Guarantees

- **Region containment** — a candidate whose edits leave the generated region
  is rejected at validation, screening, and promotion.
- **Determinism** — the built-in engine is byte-stable for identical requests;
  `runEngineConformance` checks the same for yours.
- **No ungated writes** — promotion requires a certified gate verdict and
  signed provenance (model, frozen prompt, artifact, conformance report, and
  eval report digests).
- **Auditability** — training runs and promotions are event logs first;
  replay and revert are derived from them, not from hidden state.

## Development

```sh
npm install
npm run typecheck   # src + tests
npm test            # vitest
npm run build       # emit dist/
```

## Provenance

The pattern is ported from HoBo's training-pipeline package and its draft
proofs (training-engine port, built-in OPTO engine, evals/training promotion
gates, champion/challenger promotion), generalized to be domain-neutral:
schema ids live under `ts-autocode.*`, the routed-text vocabulary is
`input`/`expectedLabel`/`baselineLabel`, and region markers, stopwords, and
fallbacks are configurable.
