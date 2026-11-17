
export const evolveVariable = "TS_AUTOCODE_EVOLVE";

const evolveOff = ["0", "false", "off", "no", "disabled"];
const evolveOn = ["1", "true", "on", "yes", "enabled"];

export function evolutionEnabled(value: string | undefined): boolean {
	const flag = (value ?? "").trim().toLowerCase();
	if (flag === "") return true;
	if (evolveOff.includes(flag)) return false;
	if (evolveOn.includes(flag)) return true;
	throw new Error(
		`${evolveVariable} must be one of ${[...evolveOn, ...evolveOff].join(", ")}; received ${JSON.stringify(value)}`,
	);
}
