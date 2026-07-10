import { CANDIDATE_PATCH_SCHEMA, type CandidatePatch, type OptimizeRequest } from "./engine.js";
import type { CandidateScreening } from "./optimizer.js";
import type { Feedback, Trajectory, TrajectorySpan } from "./trajectory.js";

// OptoPrime presents the recorded execution to an LLM as a structured
// pseudo-code report and asks for updated parameters. This renderer produces
// the ts-autocode equivalent: instruction, the trainable code, the trace,
// and the feedback — ending with the exact patch shape the engine must
// return. Consumers embed it in their own LLM-backed TrainingEngine; the
// library itself never calls a model.

export interface RenderOptimizeReportOptions {
	/** The previous round's candidate, when iterating. */
	readonly previousCandidate?: CandidatePatch;
	/** The previous round's screening, when iterating. */
	readonly screening?: CandidateScreening;
}

/** Renders an optimize request as an OptoPrime-style report for an LLM engine. */
export function renderOptimizeReport(
	request: OptimizeRequest,
	{ previousCandidate, screening }: RenderOptimizeReportOptions = {},
): string {
	const sections: string[] = [];

	sections.push(
		"# Instruction",
		`Objective: ${request.rubric.objective}`,
		`Rubric: ${request.rubric.id}`,
		`Contract: ${request.contract.ref} (method ${request.contract.method})`,
		...renderInvariants(request),
	);

	sections.push("", "# Code");
	for (const region of request.generatedRegions) {
		sections.push(
			`## Region ${region.regionId} (${region.artifactRef}, owner ${region.owner})`,
			`Editable offsets: [${region.startOffset}, ${region.endOffset})`,
		);
		const source = request.regionSources?.[region.regionId];
		if (source !== undefined) {
			sections.push("```", source, "```");
		} else {
			sections.push("(current region source not provided)");
		}
	}

	sections.push("", "# Trace");
	for (const trajectory of request.trajectories) {
		sections.push(...renderTrajectory(trajectory));
	}

	sections.push("", "# Feedback");
	const runFeedback = request.feedback ?? [];
	if (runFeedback.length === 0) {
		sections.push("(no run-level feedback)");
	} else {
		sections.push(...runFeedback.map(renderFeedbackItem));
	}
	if (screening) {
		sections.push(
			`Previous screening outcome: ${screening.outcome}`,
			...screening.rejectionReasons.map((reason) => `- rejected: ${reason}`),
		);
	}
	if (previousCandidate) {
		sections.push(`Previous candidate: ${previousCandidate.id}`);
	}

	sections.push(
		"",
		"# Request",
		"Propose new source for the editable region(s) only. Respond with a candidate patch:",
		"```json",
		JSON.stringify(
			{
				schema: CANDIDATE_PATCH_SCHEMA,
				id: "<candidate id>",
				engineId: "<your engine id>",
				regions: request.generatedRegions,
				edits: request.generatedRegions.map((region) => ({
					regionId: region.regionId,
					startOffset: region.startOffset,
					endOffset: region.endOffset,
					replacement: "<new region source>",
				})),
				provenance: {
					trajectoryHashes: ["<sha256 of each trajectory>"],
					rubricRef: request.rubric.id,
					contractRef: request.contract.ref,
				},
			},
			null,
			2,
		),
		"```",
	);

	return sections.join("\n");
}

function renderInvariants(request: OptimizeRequest): string[] {
	const invariants = request.contract.invariants;
	if (!invariants) {
		return [];
	}
	const lines: string[] = [];
	if (invariants.allowedOutputs?.length) {
		lines.push(`Allowed outputs: ${invariants.allowedOutputs.join(", ")}`);
	}
	if (invariants.forbiddenOutputs?.length) {
		lines.push(`Forbidden outputs: ${invariants.forbiddenOutputs.join(", ")}`);
	}
	if (invariants.requiredFallback) {
		lines.push(`Required fallback: ${invariants.requiredFallback}`);
	}
	return lines;
}

function renderTrajectory(trajectory: Trajectory): string[] {
	const lines = [
		`## Trajectory ${trajectory.id} (method ${trajectory.subject.method}, region digest ${trajectory.code.regionDigest.slice(0, 19)}…${trajectory.code.arm ? `, arm ${trajectory.code.arm}` : ""})`,
	];
	for (const span of trajectory.spans) {
		lines.push(renderSpan(span, trajectory.spans));
	}
	if (trajectory.usage) {
		const cost = trajectory.usage.costUsd === undefined ? "" : `, $${trajectory.usage.costUsd}`;
		const latency = trajectory.usage.latencyMs === undefined ? "" : `, ${trajectory.usage.latencyMs}ms`;
		lines.push(
			`usage: ${trajectory.usage.inputTokens} in / ${trajectory.usage.outputTokens} out tokens${cost}${latency}`,
		);
	}
	for (const score of trajectory.scores ?? []) {
		lines.push(
			`score ${score.name}: ${String(score.value)} (${score.source}${score.rubricRef ? `, ${score.rubricRef}` : ""})${score.comment ? ` — ${score.comment}` : ""}`,
		);
	}
	for (const item of trajectory.feedback ?? []) {
		lines.push(renderFeedbackItem(item));
	}
	return lines;
}

function renderSpan(span: TrajectorySpan, spans: readonly TrajectorySpan[]): string {
	const depth = spanDepth(span, spans);
	const kind = span.attributes["openinference.span.kind"];
	const inputs = span.inputs ? ` inputs=${JSON.stringify(span.inputs)}` : "";
	const outputs = span.outputs ? ` outputs=${JSON.stringify(span.outputs)}` : "";
	const genAi = span.genAi
		? ` model=${span.genAi.requestModel ?? "?"}${span.genAi.usage ? ` tokens=${span.genAi.usage.inputTokens}/${span.genAi.usage.outputTokens}` : ""}${span.genAi.cost?.totalUsd !== undefined ? ` cost=$${span.genAi.cost.totalUsd}` : ""}`
		: "";
	const status = span.status && span.status.code !== "OK" ? ` status=${span.status.code}` : "";
	return `${"  ".repeat(depth)}- [${String(kind)}] ${span.name}${genAi}${status}${inputs}${outputs}`;
}

function spanDepth(span: TrajectorySpan, spans: readonly TrajectorySpan[]): number {
	let depth = 0;
	let current: TrajectorySpan | undefined = span;
	while (current?.parentId) {
		const parentId: string = current.parentId;
		current = spans.find((candidate) => candidate.id === parentId);
		if (!current) {
			break;
		}
		depth += 1;
	}
	return depth;
}

function renderFeedbackItem(item: Feedback): string {
	switch (item.kind) {
		case "score":
			return `- feedback(score): ${item.score}`;
		case "text":
			return `- feedback(text): ${item.text}`;
		case "error":
			return `- feedback(error): ${item.message}${item.detail ? ` — ${item.detail}` : ""}`;
	}
}
