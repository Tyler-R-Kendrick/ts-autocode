export function route(input: string): string {
	// autocode:generated-region begin region=router owner=ax
	return input.includes("invoice") ? "billing" : "fallback";
	// autocode:generated-region end region=router
}
