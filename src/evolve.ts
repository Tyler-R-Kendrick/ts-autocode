// The evolve kill switch, kept apart from `ts-autocode/register` so it can be
// read and tested without installing a module load hook. Importing
// `src/register.ts` runs that installation, which is not something a unit test
// of a string-parsing rule should require, and on a Node without
// `module.registerHooks` it throws outright.

/** Environment switch for zero-config evolution. Loading `ts-autocode/register`
 * is itself the opt-in, so an unset variable leaves evolution on; the variable
 * exists to turn it back off without changing the command line. */
export const evolveVariable = "TS_AUTOCODE_EVOLVE";

const evolveOff = ["0", "false", "off", "no", "disabled"];
const evolveOn = ["1", "true", "on", "yes", "enabled"];

/** Reads the kill switch, failing closed: an unrecognized value throws rather
 * than being guessed at. Evolution rewrites the user's source files, so a
 * misspelled `TS_AUTOCODE_EVOLVE=nope` must never be read as consent. */
export function evolutionEnabled(value: string | undefined): boolean {
	const flag = (value ?? "").trim().toLowerCase();
	if (flag === "") return true;
	if (evolveOff.includes(flag)) return false;
	if (evolveOn.includes(flag)) return true;
	throw new Error(
		`${evolveVariable} must be one of ${[...evolveOn, ...evolveOff].join(", ")}; received ${JSON.stringify(value)}`,
	);
}
