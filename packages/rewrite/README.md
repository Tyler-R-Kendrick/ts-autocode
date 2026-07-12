# ts-autocode-rewrite

Guarded source rewriting and hot-swappable AOP interception, driven by a
configurable `"use <name>"` marker. The package is general — it knows nothing
about training. A consumer registers a marker and its behavior once, and
marking a method with that directive is all that's needed after that.

## Two ways a candidate becomes real

- **Source rewrite** — `applyCandidate` replaces exactly the discovered method
  body behind a digest guard; `promoteCandidate`/`revertPromotion` add
  snapshots that refuse to overwrite subsequent edits.
- **Hot-swappable advice** — an [AspectJS](https://www.npmjs.com/package/@aspectjs/core)
  `Rewrite` annotation and `@Around` aspect weave marked methods so their live
  implementation dispatches through a swap registry. Promotion swaps behavior
  in the running process without touching source.

## Configure a marker, then just mark methods

`configureRewrite` is the single entry point. It binds a `"use <name>"` marker
to its rewrite behavior (an optional per-invocation interceptor). After that,
the `"use <name>"` directive is the shorthand — a consumer's discovery or load
hook weaves each marked method, and promotion drives the swap:

```ts
import { configureRewrite } from "ts-autocode-rewrite";

// A consumer registers its marker once (ts-autocode-training registers
// "use training" with its runtime-capture interceptor).
configureRewrite({
  marker: "use audit",
  intercept: (call) => {
    log(call.id, call.args);
    return call.proceed(); // resolves the live (possibly swapped) implementation
  },
});
```

```ts
class Router {
  route(input: string): string {
    "use audit"; // the marker is the only thing a consumer writes
    return input;
  }
}
```

Different markers route to different configurations, so several rewrite
behaviors can coexist in one process. The `"use <name>"` marker is normalized
and used as the annotation's configuration key.

## Advanced / test helpers

`annotateRewrite(owner, method, id, marker)` weaves a method directly, and
`swapImplementation(id, fn)` / `restoreImplementation(id)` change live behavior
without touching source. These back the shorthand above and are exported for
tests and custom orchestration — they are not part of the normal consumer path,
which is: configure a marker, mark methods, promote.

Every AspectJS decorator is applied programmatically, so the package works
under both standard and legacy decorator configurations.

Most applications should depend on [`ts-autocode`](../../README.md), which
configures the `"use training"` marker and drives promotion (source rewrite plus
live hot-swap of async targets) for you.

## License

[MIT](../../LICENSE)
