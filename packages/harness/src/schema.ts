import { isAbsolute, resolve } from "node:path";

import { z } from "zod";


export const actorName = z.string().trim().min(1, "agent message actor must be non-empty").brand<"ActorName">();
export type ActorName = z.output<typeof actorName>;

export const messageKind = z.string().trim().min(1, "agent message kind must be non-empty").brand<"MessageKind">();
export type MessageKind = z.output<typeof messageKind>;

export const messageId = z.string().trim().min(1, "agent message id must be non-empty").brand<"MessageId">();
export type MessageId = z.output<typeof messageId>;

export function positiveIntegerSetting(message: string) {
	return z.number({ error: message }).int(message).positive(message);
}

export const sequenceNumber = positiveIntegerSetting("sequence must be a positive integer").brand<"SequenceNumber">();
export type SequenceNumber = z.output<typeof sequenceNumber>;

export const agentMessage = z.object({
	actor: actorName,
	kind: messageKind,
	payload: z.unknown().optional(),
});
export type AgentMessage = z.input<typeof agentMessage>;
export type ParsedAgentMessage = z.output<typeof agentMessage>;

export const agentBusEntry = agentMessage.extend({
	id: messageId,
	sequence: sequenceNumber,
	timestamp: z.string(),
});
export type AgentBusEntry = z.output<typeof agentBusEntry>;

export const absolutePath = z.string()
	.refine(isAbsolute, "path must be absolute")
	.transform((path) => resolve(path))
	.brand<"AbsolutePath">();
export type AbsolutePath = z.output<typeof absolutePath>;

export const roundLimit = positiveIntegerSetting("maxRounds must be a positive integer").brand<"RoundLimit">();
export type RoundLimit = z.output<typeof roundLimit>;

export const rubricText = z.string().trim().min(1, "judge rubric must be non-empty").brand<"Rubric">();
export type Rubric = z.output<typeof rubricText>;

export const candidateKey = z.string().trim().min(1, "candidateId must return a non-empty string").brand<"CandidateKey">();
export type CandidateKey = z.output<typeof candidateKey>;
