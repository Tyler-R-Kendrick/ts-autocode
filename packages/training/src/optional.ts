// `exactOptionalPropertyTypes` forbids assigning an explicit `undefined` to an
// optional property, so every optional pass-through in this codebase was
// written as `...(x === undefined ? {} : { x })`, about twenty-five times,
// plus a one-off `maybeSignal()` helper that did the same thing for one field.

/** Spreads `{ [key]: value }` when `value` is defined, and nothing when it is
 * not. `{ ...optional("signal", signal) }` replaces
 * `...(signal === undefined ? {} : { signal })`. */
export function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
	return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** Spreads every defined entry of `values`, dropping the undefined ones.
 * `{ ...defined({ signal, timeoutMs }) }` replaces a run of `optional` calls. */
export function defined<T extends object>(values: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
	// `Object.fromEntries`, not `result[key] = value`. Assignment goes through
	// the `__proto__` setter on Object.prototype, so a `__proto__` key was
	// silently dropped, and with an object value it replaced the result's
	// prototype instead of adding a key. `fromEntries` defines own properties,
	// which is what a key/value copy should do. Found by a property test.
	return Object.fromEntries(
		Object.entries(values).filter(([, value]) => value !== undefined),
	) as { [K in keyof T]?: Exclude<T[K], undefined> };
}
