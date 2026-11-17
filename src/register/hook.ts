import { createRewriter } from "ts-autocode-rewrite";
import { discoverInSource, trainingMarker } from "ts-autocode-training";

export { instrumentKey } from "ts-autocode-rewrite";

export const augmentSource = createRewriter(discoverInSource, trainingMarker);
