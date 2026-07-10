# ts-autocode

`ts-autocode` optimizes explicitly marked TypeScript regions with
[`@ax-llm/ax`](https://github.com/ax-llm/ax). It does three things:

1. Locates generated regions and records a digest of their current contents.
2. Runs Ax optimization for independent regions concurrently.
3. Applies the candidate only if every region is still unchanged.

The package does not implement its own LLM optimizer, OTLP model, or telemetry
event protocol. Ax performs the optimization, and tracing uses the official
OpenTelemetry API.

## Requirements

- Node.js 20 or newer
- An Ax-supported AI provider

```bash
npm install ts-autocode @ax-llm/ax
```

## Mark a region

Only code between matching markers can be replaced.

```ts
export function route(input: string) {
  // autocode:generated-region begin region=router owner=ax
  return "fallback";
  // autocode:generated-region end region=router
}
```

## Optimize and apply

```ts
import { readFile, writeFile } from "node:fs/promises";

import { ai, ax } from "@ax-llm/ax";
import {
  applyCandidate,
  findGeneratedRegion,
  optimizeRegions,
} from "ts-autocode";

const artifactRef = "src/router.ts";
const source = await readFile(artifactRef, "utf8");
const region = findGeneratedRegion(source, "router", { artifactRef });
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("Set OPENAI_API_KEY before running this example");
const studentAI = ai({
  name: "openai",
  apiKey,
});

const candidate = await optimizeRegions(
  {
    artifacts: { [artifactRef]: source },
    regions: [region],
    data: {
      task: "Route billing questions to billing and everything else to fallback",
      examples: [
        { input: "Where is my invoice?", expected: "billing" },
        { input: "Reset my password", expected: "fallback" },
      ],
    },
  },
  {
    studentAI,
    program: () =>
      ax("task:string, currentCode:string -> replacement:string"),
    examples: ({ currentSource, data }) =>
      data.examples.map((example) => ({
        task: `${data.task}\nInput: ${example.input}`,
        currentCode: currentSource,
        expected: example.expected,
      })),
    metric: ({ prediction, example }) =>
      prediction.replacement.includes(String(example.expected)) ? 1 : 0,
    input: ({ currentSource, data }) => ({
      task: data.task,
      currentCode: currentSource,
    }),
    replacement: (output) => output.replacement,
  },
);

const updated = applyCandidate(
  { [artifactRef]: source },
  candidate,
  [region],
);
await writeFile(artifactRef, updated[artifactRef], "utf8");
```

See [`examples/optimize.ts`](examples/optimize.ts) for a complete example.

## Concurrency

Each region gets its own Ax program and optimization run. By default all regions
train concurrently. Set `concurrency` when provider rate limits require a cap:

```ts
await optimizeRegions(request, { ...options, concurrency: 4 });
```

Ax controls concurrency inside each optimization run. `ts-autocode` only
schedules independent region runs.

## OpenTelemetry

Pass an official OpenTelemetry `Tracer` through `tracer`. The library creates a
parent optimization span and one child span per region. Ax can use the same
tracer provider for its model and optimizer spans.

```ts
const candidate = await optimizeRegions(request, {
  ...options,
  tracer: tracerProvider.getTracer("my-service"),
});
```

No custom span, status, event, or OTLP types are exported.

## Public API

- `findGeneratedRegion(source, regionId, options)` discovers a writable region.
- `optimizeRegions(request, options)` trains with Ax and returns a candidate.
- `applyCandidate(artifacts, candidate, regions)` verifies digests and applies
  full-region edits from right to left.

The remaining exports are the TypeScript types used by those three functions.
Import Ax and OpenTelemetry types from their official packages.

## Safety properties

- Hand-written code outside markers is never included in an edit.
- Candidates contain one full replacement per requested region.
- Applying a candidate fails if a region changed after optimization began.
- Input objects are not mutated.
- A failed Ax run rejects the operation; there is no fallback fake optimizer.

## Development

```bash
npm ci
npm run check
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Security
issues should follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
