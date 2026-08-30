# ts-autocode-grounding

Granular grounding decorators, ambient trainable-class scanning, and
deterministic text helpers for trainable TypeScript codegen.

This package is **host-agnostic**: it never imports a training runtime. It
composes what a class declares into provider-neutral `GroundingOptions`, and a
host — `ts-autocode`, or any other — registers those against its own registry.

Most applications do not need it. Reach for it when you want an implementation
described one fact at a time, or when trainables are declared ambiently and
their registrations are generated.

## Granular decorators

Every decorator is optional. A method with none still grounds: intent is
inferred from the name and the TypeScript signature is the declared shape.

```ts
import { description, intent, returns } from "ts-autocode/grounding";

class Greeter {
  @intent("Produce a simple hello-world program")
  @returns("Hello World! or Hello, <name>! when supplied")
  greet(name?: string): string {
    return name ? `Hello, ${name}!` : "Hello World!";
  }
}
```

TC39 stage-3 decorators have no parameter decorators, so parameter descriptions
ride the options object as `params: { name: description("…") }` values.

## Ambient declarations and codegen

An `export declare class` is erased at compile time, so no decorator ever runs.
`scanDeclaredTrainables` reads the declaration statically — a real TypeScript
AST walk, never a regex — and `generateDeclaredRegistrations` emits registration
source for it:

```ts
import { generateDeclaredRegistrations, scanDeclaredTrainables } from "ts-autocode/grounding";

const [declared] = scanDeclaredTrainables(`
  @trainable
  export declare class Program {
    @intent("Greet someone")
    greet(name?: string): string;
  }
`);

const source = generateDeclaredRegistrations(declared!);
```

The emitted source calls `defineGrounding`, exported from this package. It
previously called `training.define`, which does not exist on the `Training`
runtime, so every generated file failed to typecheck; the scan test now
compiles what it emits rather than string-matching it.

Point the generated import elsewhere with `runtimeModule`:

```ts
import { generateDeclaredRegistrations, type DeclaredTrainableClass } from "ts-autocode/grounding";

declare const declared: DeclaredTrainableClass;

generateDeclaredRegistrations(declared, { runtimeModule: "@acme/runtime" });
```

## Registering against a host

`finalizeTrainableClass` registers every granular-declared method (or, when
nothing was annotated, every own prototype method) against a host-provided
`GroundingRegistry`. The registry and metadata symbols are parameters, which is
what keeps this package free of any runtime dependency.

## Text helpers

`camelCase`, `pascalCase`, `normalizeText`, `normalizePath`, `stableStringify`,
`toStableValue`, `union`, and `textDigest` back deterministic codegen.

> `textDigest` hashes line-ending-normalized **text**. It is not the same
> function as `ts-autocode-rewrite`'s `digest`, which canonicalizes an arbitrary
> value as key-sorted JSON. Both emit a `sha256:` prefix, so substituting one
> for the other silently changes every hash. It was called `digest` here too;
> that name remains as a deprecated alias.

## License

[MIT](../../LICENSE)
