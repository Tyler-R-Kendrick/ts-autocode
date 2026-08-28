import { describe, it } from "vitest";

import {
	CandidateSyntaxError,
	EngineContractError,
	EngineNotConfiguredError,
	EngineProposalError,
	ExecutorNotConfiguredError,
	InsufficientTracesError,
	InvalidSettingsError,
	InvalidTrainableIdentityError,
	LoopCapabilityError,
	MissingSecretError,
	OperationInterruptedError,
	OperationTimeoutError,
	PromotionApplierNotConfiguredError,
	PromotionRejectedError,
	SourceDiscoveryError,
	TraceNotFoundError,
	TrainingIncompleteError,
} from "../src/index.js";
import { verify } from "./support/verify.js";

// Error text is the library's most-read documentation: it is what a stuck user
// sees. It is also load-bearing here, because the typed hierarchy promised to
// preserve every message byte for byte so existing catch blocks and substring
// assertions keep working. An approved catalogue makes any drift reviewable,
// and reads as a table of contents for what can go wrong.

const catalogue: ReadonlyArray<Error> = [
	new EngineNotConfiguredError(),
	new ExecutorNotConfiguredError(),
	new PromotionApplierNotConfiguredError(),
	new PromotionRejectedError("cand-1"),
	new InsufficientTracesError(1, 0),
	new InsufficientTracesError(3, 2),
	new TraceNotFoundError("Where is my invoice?"),
	new CandidateSyntaxError("Router.route"),
	new EngineContractError("engine returned an empty implementation"),
	new EngineProposalError("Ax did not optimize Router.route"),
	new MissingSecretError("OPENAI_API_KEY", "default optimizer requires OPENAI_API_KEY or a custom TrainingSettings.engine"),
	new LoopCapabilityError("the governed harness loop reviews one candidate per round"),
	new InvalidTrainableIdentityError("trainable id must be a non-empty string"),
	new SourceDiscoveryError("trainable source was not found: Router.route"),
	new OperationInterruptedError("engine.propose"),
	new InvalidSettingsError("minScore must be between 0 and 1"),
	new OperationTimeoutError({ operation: "engine.propose", timeoutMs: 30_000 }),
	TrainingIncompleteError.noRounds("stalled"),
	TrainingIncompleteError.noPromotableCandidate("exhausted"),
];

describe("error message catalogue", () => {
	it("reads as the user sees it", async () => {
		const lines = catalogue.map((error) => {
			const code = (error as Error & { code?: string }).code ?? "-";
			return `${error.name.padEnd(36)} ${String(code).padEnd(26)} ${error.message}`;
		});
		await verify("errors/catalogue.txt", `${lines.join("\n")}\n`);
	});
});
