export function generatedRegionSource(
	regions: ReadonlyArray<{ id: string; body: string; owner?: string }>,
	wrapper?: (regions: string) => string,
): string {
	const marker = "autocode:generated-region";
	const content = regions.map(({ id, body, owner = "training" }) => [
		`// ${marker} begin region=${id} owner=${owner}`,
		body,
		`// ${marker} end region=${id}`,
	].join("\n")).join("\n");
	return `${wrapper ? wrapper(content) : content}\n`;
}
