# ts-autocode-rewrite

Guarded source rewriting and hot-swappable AOP interception for trainable
TypeScript methods. This package owns the two ways a gated candidate becomes
real:

- **Source rewrite** — `applyCandidate` replaces exactly the discovered method
  body behind a digest guard; `promoteCandidate`/`revertPromotion` add
  snapshots that refuse to overwrite subsequent edits.
- **Hot-swappable advice** — an [AspectJS](https://www.npmjs.com/package/@aspectjs/core)
  `Trainable` annotation and `@Around` aspect weave marked methods so their
  live implementation dispatches through a swap registry.
  `swapImplementation(id, fn)` replaces behavior in the running process
  without touching source; `restoreImplementation(id)` reverts it.

The `"use training"` literal directive stays the default marker: discovery in
`ts-autocode-training` finds directive-marked methods, and its runtime (or the
`ts-autocode/register` load hook) calls `annotateTrainable(owner, method, id)`
here to weave them. All AspectJS decorators are applied programmatically, so
the package works under both standard and legacy decorator configurations.

One process-wide `setTrainableInterceptor(fn)` observes every woven
invocation — `ts-autocode-training` wires runtime capture through it. The
interceptor's `proceed()` always resolves the live (possibly swapped)
implementation, so captures reflect what actually ran.

```ts
import { annotateTrainable, swapImplementation } from "ts-autocode-rewrite";

class Router {
  route(input: string): string {
    "use training";
    return input;
  }
}

annotateTrainable(Router, "route", "Router.route");
swapImplementation("Router.route", (input) => String(input).toUpperCase());
new Router().route("abc"); // "ABC" — no source touched
```

Most applications should depend on [`ts-autocode`](../../README.md); its
`training.promote()` writes the gated source rewrite **and** hot-swaps async
targets live through this package.

## License

[MIT](../../LICENSE)
