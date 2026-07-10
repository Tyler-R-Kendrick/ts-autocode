# Contributing

## Setup

Use Node.js 20 or newer.

```bash
npm ci
npm run check
```

## Pull requests

- Keep changes focused and add tests for behavior changes.
- Import protocol and SDK types from their owning package.
- Keep the root export surface small; internal helpers should stay internal.
- Avoid global mutable configuration and exported string constants.
- Document public API changes in the README and add a runnable example when
  behavior is not obvious.
- Do not commit credentials, generated `dist/` files, or `.env` files.

The CI workflow runs type checking, tests, and the package build on supported
Node.js versions.
