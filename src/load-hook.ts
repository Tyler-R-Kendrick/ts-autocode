import module from "node:module";


export function canRegisterLoadHook(): boolean {
	return typeof module.registerHooks === "function";
}

export function registerLoadHook(hooks: Parameters<typeof module.registerHooks>[0]): void {
	if (!canRegisterLoadHook()) {
		throw new Error(
			`ts-autocode/register needs module.registerHooks, which ${process.version} does not provide (Node 22.15 or newer does). `
			+ "The rest of ts-autocode works on Node 20; only the load-time instrumentation this entry installs does not. "
			+ "Mark methods with the @trainable() decorator and call training.train(...) directly, or upgrade Node.",
		);
	}
	module.registerHooks(hooks);
}
