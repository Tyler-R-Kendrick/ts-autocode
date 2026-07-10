import {
	CANDIDATE_PATCH_SCHEMA,
	type CandidatePatch,
	OPTIMIZE_REQUEST_SCHEMA,
	type OptimizeRequest,
	type TrainingEngine,
	findGeneratedRegion,
	hashTrajectory,
	PROVENANCE_PAYLOAD_SCHEMA,
	type SignedProvenance,
	type Trajectory,
	TRAJECTORY_SCHEMA,
} from "../src/index.js";

export const FIXTURE_TS = "2026-06-28T19:10:00.000Z";

export function classifierSource(): string {
	return [
		"export function classify(input) {",
		"  const handWrittenGuard = true;",
		"  // autocode:generated-region begin region=classify-body owner=training-engine",
		'  return "identity-support";',
		"  // autocode:generated-region end region=classify-body",
		"}",
		"",
	].join("\n");
}

export function classifierRegion(source = classifierSource()) {
	return findGeneratedRegion(source, "classify-body", {
		artifactRef: "git://repo/src/classify.ts#classify",
	});
}

export function makeTrajectory({
	id,
	input,
	baselineLabel,
	expectedLabel,
	score = 0.9,
	region = classifierRegion(),
}: {
	id: string;
	input: string;
	baselineLabel: string;
	expectedLabel: string;
	score?: number;
	region?: ReturnType<typeof classifierRegion>;
}): Trajectory {
	return {
		schema: TRAJECTORY_SCHEMA,
		id,
		traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		run: {
			id: `run-${id}`,
			tenantId: "tenant-a",
			agent: {
				id: "agent:classifier",
				principalRef: "spiffe://tenant-a/agent/classifier",
			},
		},
		subject: {
			method: "classify",
			contractRef: "contract://classify@1.0.0",
			generatedRegion: region,
		},
		spans: [
			{
				id: `${id}-root`,
				parentId: null,
				name: "classify",
				startTime: "2026-06-25T09:00:00.000Z",
				endTime: "2026-06-25T09:00:00.120Z",
				attributes: {
					"openinference.span.kind": "CHAIN",
					"input.value": input,
				},
				inputs: { input },
				outputs: { label: baselineLabel },
			},
			{
				id: `${id}-llm`,
				parentId: `${id}-root`,
				name: "llm.classify",
				startTime: "2026-06-25T09:00:00.010Z",
				endTime: "2026-06-25T09:00:00.100Z",
				attributes: {
					"openinference.span.kind": "LLM",
					"llm.model_name": "stub-classifier",
				},
				inputs: { promptTemplate: "classify input" },
				outputs: { label: expectedLabel },
			},
		],
		payloads: {
			input: { classification: "public", redaction: "none", value: input },
			expectedLabel: { classification: "public", redaction: "none", value: expectedLabel },
			baselineLabel: { classification: "public", redaction: "none", value: baselineLabel },
		},
		reward: {
			source: "live-eval",
			rubricRef: "rubric://classify@1.0.0",
			eventId: "eval-1",
			score,
			observedAt: "2026-06-25T09:00:01.000Z",
		},
	};
}

export function billingTrajectories(): Trajectory[] {
	return [
		makeTrajectory({
			id: "train-billing-1",
			input: "billing invoice refund",
			baselineLabel: "general-support",
			expectedLabel: "billing-support",
		}),
		makeTrajectory({
			id: "train-billing-2",
			input: "billing chargeback",
			baselineLabel: "general-support",
			expectedLabel: "billing-support",
		}),
		makeTrajectory({
			id: "train-billing-3",
			input: "billing subscription renewal",
			baselineLabel: "general-support",
			expectedLabel: "billing-support",
		}),
	];
}

export function heldOutTrajectories(): Trajectory[] {
	return [
		makeTrajectory({
			id: "heldout-billing",
			input: "billing invoice refund",
			baselineLabel: "general-support",
			expectedLabel: "billing-support",
		}),
	];
}

export function makeOptimizeRequest(overrides: Partial<OptimizeRequest> = {}): OptimizeRequest {
	const region = classifierRegion();
	return {
		schema: OPTIMIZE_REQUEST_SCHEMA,
		requestId: "optimize-request-1",
		generatedRegion: region,
		trajectories: billingTrajectories(),
		rubric: {
			id: "rubric://classify@1.0.0",
			objective: "promote billing label without breaking fallback",
			minimumImprovement: 0.5,
			heldOutThreshold: 1,
		},
		contract: {
			ref: "contract://classify@1.0.0",
			method: "classify",
			allowedRegionId: region.regionId,
			invariants: {
				allowedOutputs: ["billing-support", "identity-support", "general-support"],
				forbiddenOutputs: ["admin-support"],
				requiredFallback: "general-support",
			},
		},
		...overrides,
	};
}

/** An engine that edits outside the requested region — must be rejected. */
export function createOutOfRegionEngine(): TrainingEngine {
	return {
		engineId: "example.training-engine/out-of-region@0.1.0",
		optimize(request): CandidatePatch {
			return {
				schema: CANDIDATE_PATCH_SCHEMA,
				id: "candidate-out-of-region",
				engineId: "example.training-engine/out-of-region@0.1.0",
				region: structuredClone(request.generatedRegion),
				edits: [
					{
						startOffset: request.generatedRegion.endOffset + 1,
						endOffset: request.generatedRegion.endOffset + 4,
						replacement: "overwrite unrelated code",
					},
				],
				provenance: {
					trajectoryHashes: request.trajectories.map(hashTrajectory),
					rubricRef: request.rubric.id,
					contractRef: request.contract.ref,
				},
			};
		},
	};
}

export function completeProvenance(): SignedProvenance {
	return {
		kind: "generation-provenance",
		signature: {
			alg: "Ed25519",
			payloadDigest: `sha256:${"2".repeat(64)}`,
			value: "signed-fixture",
		},
		payload: {
			schema: PROVENANCE_PAYLOAD_SCHEMA,
			model: {
				provider: "local",
				id: "opto-fixture",
				digest: `sha256:${"3".repeat(64)}`,
			},
			prompt: {
				id: "prompt:classifier",
				frozenPromptDigest: `sha256:${"4".repeat(64)}`,
			},
			seed: "seed-fixture",
			evalReportRefs: [
				{
					kind: "eval-report",
					name: "shadow-eval",
					digest: `sha256:${"5".repeat(64)}`,
				},
			],
			conformanceReportRef: {
				kind: "conformance-report",
				name: "classifier-contract",
				digest: `sha256:${"6".repeat(64)}`,
			},
			artifact: {
				kind: "generated-region",
				name: "classify",
				digest: `sha256:${"7".repeat(64)}`,
			},
			issuedAt: FIXTURE_TS,
		},
	};
}
