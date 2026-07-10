export { applyCandidate } from "./engine.js";
export type {
	CandidateEdit,
	CandidatePatch,
	OptimizationRequest,
	RegionOptimizationSummary,
} from "./engine.js";

export { optimizeRegions } from "./optimizer.js";
export type { AxOptimizerOptions, RegionOptimizationContext } from "./optimizer.js";

export { findGeneratedRegion } from "./region.js";
export type { GeneratedRegion, RegionMarkerOptions } from "./region.js";
