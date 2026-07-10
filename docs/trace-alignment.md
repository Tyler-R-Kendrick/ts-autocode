# Microsoft Trace alignment

ts-autocode is inspired by **Microsoft Trace** — the AutoDiff-like framework
for optimizing AI systems end to end from general feedback — and by HoBo's
code-evolution pattern built on it. This document maps Trace's concepts and
value propositions onto ts-autocode, states where they are equivalent, and
records the deliberate differences.

Sources: [Trace repo](https://github.com/microsoft/Trace) ·
[docs](https://microsoft.github.io/Trace/) ·
["Trace is the New AutoDiff" (NeurIPS 2024)](https://arxiv.org/abs/2406.16218) ·
[MSR blog](https://www.microsoft.com/en-us/research/blog/tracing-the-path-to-self-adapting-ai-agents/) ·
[LLM optimizers via agent-system interfaces](https://arxiv.org/abs/2410.15625)

## Concept map

| Microsoft Trace | ts-autocode | Notes |
|---|---|---|
| `node(value, trainable=True)` — a trainable parameter | `GeneratedRegion` (marker-delimited source span) | The region's body **is** the parameter; markers make the write scope explicit in the artifact. |
| `@bundle(trainable=True)` — a function whose body is learnable | `trainable(fn, { runtime, run, method })` | Wrapping binds the function to its region and records a trajectory per invocation. |
| `@model` — an optimizable agent | A set of regions optimized jointly | `OptimizeRequest.generatedRegions` carries all trainable regions of one run. |
| Execution trace / computation graph | `Trajectory` (OpenInference span tree + payloads) | Spans form a parent/child tree, not a full operator dataflow DAG — see "Deferred". |
| Feedback oracle: scalar, text, or error into `.backward()` | `TrajectoryReward` + `Feedback` (`score` \| `text` \| `error`) | Trajectory-level and run-level (`OptimizeRequest.feedback`); `trainable()` records thrown errors as error feedback automatically. |
| OPTO: iterate (params, trace, feedback) | `runOptimizationLoop` | Each rejected round's reasons become error feedback on the next request; stops on ready-for-gate, stall, or round budget. |
| `optimizer.zero_feedback()` / `backward()` / `step()` | one loop round | The loop clones the request per round; feedback accumulates explicitly instead of by optimizer state. |
| OptoPrime / OPRO / TextGrad (swappable optimizers) | `TrainingEngine` implementations | The port is sync-or-async, so LLM-backed engines plug in directly. `createBuiltInOptoEngine()` is the deterministic reference engine. |
| OptoPrime's pseudo-code report to the LLM | `renderOptimizeReport(request, …)` | Renders instruction, region code, span trees, rewards/feedback, and the exact `CandidatePatch` JSON shape to return. The library never calls a model itself. |
| Minimal subgraph propagation | Region containment + per-region edits | Engines see only requested regions; candidate edits are validated to stay inside them. |
| In-place parameter update after `step()` | Champion/challenger **promotion** | The deliberate difference — see below. |

## Value propositions and how they carry over

1. **Optimize the whole program, not just prompts.** Trace rewrites code,
   prompts, and hyperparameters. ts-autocode's parameter is literal source
   inside generated regions; anything expressible in a region body is
   optimizable, and multiple regions optimize jointly in one request.
2. **General feedback, not just scalars.** Scores, natural-language critiques,
   and runtime errors are all first-class `Feedback`; `trainable()` captures
   throws as error feedback, matching Trace's "errors are signal" stance.
3. **Swappable optimizers behind one interface.** Any engine implementing
   `optimize(request) → CandidatePatch | Promise<CandidatePatch>` slots in.
   `runEngineConformance` certifies determinism and region binding before an
   engine is trusted — the analogue of Trace keeping OptoPrime/OPRO/TextGrad
   interchangeable.
4. **PyTorch-like declare / forward / optimize.** Declare with region markers
   and `trainable()`; forward runs record trajectories automatically; optimize
   with the loop. The shapes intentionally mirror the Trace workflow.

## Deliberate differences (governance on top of Trace)

- **Gated promotion instead of in-place update.** Trace's `step()` mutates
  parameters directly. ts-autocode inserts the three-lens gate (conformance ∧
  eval floors ∧ policy), signed provenance (with optional real Ed25519
  verification), and champion/challenger promotion — auto-apply only for
  low-risk non-prod; PR delta for prod/high-risk; log-driven revert.
- **Determinism and replay.** Training runs and captures emit `training.*`
  event logs with byte-stable digests; `replayTrainingRun` rebuilds state from
  the log alone. Trace has no equivalent audit trail.
- **Hard write boundary.** Trace trusts the optimizer with the whole graph;
  ts-autocode validates that every candidate edit stays inside its named
  generated region at validation, screening, and promotion.
- **Redaction rules at capture.** Sensitive payloads must be tokenized or
  run-scoped-encrypted before a trajectory may enter a training run.

## Deferred (known gaps vs Trace)

- **Operator-level dataflow graph.** Trace records a DAG of operations on
  nodes and propagates feedback through minimal subgraphs. ts-autocode's
  trajectories are span *trees* per invocation; there is no cross-node
  dataflow to slice. If a future engine needs it, the seam is the
  `Trajectory` shape.
- **Bundled LLM optimizer.** Trace ships OptoPrime with LiteLLM/AutoGen
  backends. ts-autocode stays zero-dependency: it ships the report renderer
  and the async port, and consumers bring their own LLM client (mirroring
  HoBo's ADR-0025 decision to keep optimizer choice behind a port).
- **Hyperparameter nodes.** Trace can mark scalars trainable. In ts-autocode a
  hyperparameter is optimizable only by encoding it in region source.

## See also

What each trajectory collects — and how it maps to OTel GenAI semconv,
OpenInference, LangSmith, and Langfuse — is documented in
[`observability-alignment.md`](./observability-alignment.md).
