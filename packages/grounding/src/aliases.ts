import { COMPONENT_METADATA, REGISTERED_METHODS } from "./component.js";
import { PENDING_GROUNDINGS } from "./decorators.js";

// Every other package in this workspace names its exported symbols in
// camelCase. These three were the only SCREAMING_SNAKE exports; the originals
// stay for one release.

/** Where pending granular groundings accumulate on class metadata. */
export const pendingGroundings: typeof PENDING_GROUNDINGS = PENDING_GROUNDINGS;

/** Where a decorated class's finished component metadata lands. */
export const componentMetadata: typeof COMPONENT_METADATA = COMPONENT_METADATA;

/** Where registered methodRefs accumulate on class metadata. */
export const registeredMethods: typeof REGISTERED_METHODS = REGISTERED_METHODS;
