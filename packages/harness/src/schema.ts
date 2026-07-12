import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

// Parse, don't validate: inputs are parsed into constrained subtypes at the
// package boundary, so values that would be invalid cannot exist past it.

export const actorName = z.string().trim().min(1, "agent message actor must be non-empty").brand<"ActorName">();
export type ActorName = z.output<typeof actorName>;

export const messageKind = z.string().trim().min(1, "agent message kind must be non-empty").brand<"MessageKind">();
export type MessageKind = z.output<typeof messageKind>;

export const messageId = z.string().trim().min(1, "agent message id must be non-empty").brand<"MessageId">();
export type MessageId = z.output<typeof messageId>;

export const sequenceNumber = z.number().int().positive("sequence must be a positive integer").brand<"SequenceNumber">();
export type SequenceNumber = z.output<typeof sequenceNumber>;

export const agentMessage = z.object({
	actor: actorName,
	kind: messageKind,
	payload: z.unknown().optional(),
});
/** What callers hand to `append`: plain strings, parsed on entry. */
export type AgentMessage = z.input<typeof agentMessage>;
export type ParsedAgentMessage = z.output<typeof agentMessage>;

export const agentBusEntry = agentMessage.extend({
	id: messageId,
	sequence: sequenceNumber,
	timestamp: z.string(),
});
export type AgentBusEntry = z.output<typeof agentBusEntry>;

export const judgeDecision = z.enum(["pass", "fail"], { error: "judge must return exactly pass or fail" });
export type JudgeDecision = z.output<typeof judgeDecision>;

export const absolutePath = z.string()
	.refine(isAbsolute, "path must be absolute")
	.transform((path) => resolve(path))
	.brand<"AbsolutePath">();
export type AbsolutePath = z.output<typeof absolutePath>;

export const roundLimit = z.number().int().positive("maxRounds must be a positive integer").brand<"RoundLimit">();
export type RoundLimit = z.output<typeof roundLimit>;

export const rubricText = z.string().trim().min(1, "judge rubric must be non-empty").brand<"Rubric">();
export type Rubric = z.output<typeof rubricText>;

export const candidateKey = z.string().trim().min(1, "candidateId must return a non-empty string").brand<"CandidateKey">();
export type CandidateKey = z.output<typeof candidateKey>;
