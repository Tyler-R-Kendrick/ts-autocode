import module from "node:module";

// `module.registerHooks` is the synchronous in-thread loader API. Node 20 does
// not provide it, so `ts-autocode/register` (the documented zero-config entry
// point, `node --import ts-autocode/register`) threw
// `TypeError: registerHooks is not a function` there, despite `engines`
// declaring Node 20 support. Nothing imported that module in a test, so it went
// unnoticed until CI ran the suite on 20.20.2.

/** True when this runtime can install a synchronous module load hook. */
export function canRegisterLoadHook(): boolean {
	return typeof module.registerHooks === "function";
}

/** Installs the load hook, or explains what is missing and what to do instead
 * of surfacing an internal TypeError. */
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
