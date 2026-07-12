import { AxJSRuntime } from "@ax-llm/ax";
import ts from "typescript";

import { candidateDeclaration, type TrainableTarget } from "ts-autocode-training";

/** How long a candidate may run in the Ax sandbox when no timeout is configured. */
export const defaultExecutionTimeoutMs = 5_000;

export async function executeImplementation(
	target: TrainableTarget,
	implementation: string,
	args: readonly unknown[],
	options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<unknown> {
	const runtime = new AxJSRuntime({ outputMode: "return", timeout: options.timeoutMs ?? defaultExecutionTimeoutMs });
	const session = runtime.createSession({ args: [...args] });
	try {
		const javascript = ts.transpileModule(candidateDeclaration(target, implementation), {
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
		}).outputText;
		return await session.execute(
			`${javascript}\nreturn await candidate(...args);`,
			options.signal === undefined ? undefined : { signal: options.signal },
		);
	} finally {
		session.close();
	}
}
