# Rules for agents working in this repository

These are maintainer decisions, not suggestions. Violating one is a hard
failure: stop, revert the violating change, and re-read this file. Several
have already been violated by agents "simplifying" the API; the enforcement
tests named below exist because of those incidents.

## Source policy

All agents and tools must write self-documenting code. Do not add explanatory
comments, deferred-work markers, planning documents, ADRs, design or architecture documents,
or audit backlogs. Complete the work in code and executable tests. Preserve
only comments required by a compiler, tool, license, or generated-file marker.
Tool directives contain only arguments consumed by the tool, without explanatory
text. Evidence must exercise real behavior rather than fabricated results.
The source policy runs in agent hooks, the pre-commit hook, and CI.

## Trainable identity (hard failure)

**A string literal must never define a trainable identity in application
code, examples, or documentation. Not as `trainable: "X"`, and not as
`defineTrainable("X")`. Both are rejected.**

Applications use these invariants:

1. The application declares a **`unique symbol`** it owns:

   ```ts
   export const route: unique symbol = Symbol("route");
   ```

2. The `@trainable(symbol)` **decorator on the trainable code** uses that
   symbol as the key and registers the declaration under it.

3. Training reuses the same symbol (`training.train(route)`), so discovery
   is simple symbol-key indexing. Object identity of the symbol is the
   uniqueness guarantee; no registry string, no retyped name, nothing a typo
   can silently fork.

What follows from this:

- `Symbol.for(...)` registry symbols are a compatibility path for the
  zero-config directive flow, where the *machinery* derives ids from parsed
  source. Machinery-derived ids are allowed; user-typed ones are not.
- `defineTrainable(id)` is machinery: source discovery, replay, and the
  register hook use it internally. It must not appear in any README,
  docs snippet, example, or suggested CLI output as something an
  application calls.
- Enforcement: `test/adr.test.ts` pins the string form as a compile error
  and scans every documentation snippet for `defineTrainable(`: a doc that
  teaches the banned pattern fails CI.

## Other standing rules

- Additive changes only within a release; deprecated aliases keep working
  byte-for-byte (`test/deprecated.test.ts`).
- Every injected seam ships a default (`test/defaults.test.ts`) and a
  conformance suite; naming and shape conventions live in `CONTRIBUTING.md`.
- Doc snippets compile in CI (`test/docs.test.ts`); a new doc must be added
  to its list or its snippets silently go unchecked.
- Root tests and docs resolve sibling packages through their built `dist/`;
  rebuild the sibling before concluding a new type "doesn't exist".

<!-- antislop:start -->
## antislop
For UI, copy, people, mobile layout, or code comments work, load the antislop skill for the task:
- Core filter, always on: `antislop`
- Code comments: `antislop-code`
- Copy & text: `antislop-copywriting`
Apply these skills during the work and follow the source policy above when their instructions conflict.
<!-- antislop:end -->
