// The SCREAMING_SNAKE names below are unique in this workspace; camelCase
// aliases match the rest of it. Both are exported for one release.
export {
	componentMetadata,
	pendingGroundings,
	registeredMethods,
} from "./aliases.js";

export {
	composeOptions,
	defineGrounding,
	description,
	granularOptionsFor,
	inferredIntent,
	intent,
	param,
	PENDING_GROUNDINGS,
	returns,
	type FieldDescription,
	type GroundingOptions,
	type PendingGrounding,
	type PendingMap,
	type ShapeDescriptor,
} from "./decorators.js";
export {
	COMPONENT_METADATA,
	componentMetadataOf,
	createComponentDecorator,
	finalizeTrainableClass,
	REGISTERED_METHODS,
	type ComponentMetadata,
	type ComponentOptions,
	type ComponentSymbols,
	type GroundingRegistry,
} from "./component.js";
export {
	generateDeclaredRegistrations,
	scanDeclaredTrainables,
	type DeclaredOperation,
	type DeclaredParameter,
	type DeclaredTrainableClass,
	type RegistrationEmitOptions,
} from "./scan.js";
export {
	camelCase,
	digest,
	textDigest,
	normalizePath,
	normalizeText,
	pascalCase,
	stableStringify,
	toStableValue,
	union,
} from "./text.js";
