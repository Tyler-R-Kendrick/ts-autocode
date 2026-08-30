// `exactOptionalPropertyTypes` forbids assigning an explicit `undefined` to an
// optional property, so every optional pass-through in this codebase was
// written as `...(x === undefined ? {} : { x })` -- about twenty-five times,
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
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) result[key] = value;
	}
	return result as { [K in keyof T]?: Exclude<T[K], undefined> };
}
