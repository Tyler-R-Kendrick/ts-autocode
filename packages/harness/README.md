# ts-autocode-harness

A policy-enforced code-training harness: a bounded callback loop, a durable
agent message bus, and an MXC-sandboxed execution backend.

The harness coordinates callbacks the consumer supplies. Only two are
required:

- **student** proposes a candidate from the rubric, teacher feedback, and recent bus history;
- **teacher** assesses objective evidence and reports feedback against the candidate.

Every other role has a default, and all defaults follow one evidence
convention — feedback is the verdict:

- **judge** accepts any input and returns only `pass` or `fail`. Unset, a candidate passes when the teacher reports no feedback, a challenge stands when the adversary reports evidence, and actions are logged ungated.
- **adversary** is a config of its own: its required `challenge` callback receives only the artifact under test and its own prior messages, and reports `{ challenge, feedback }`; its optional `reviseRubric` callback tightens the rubric after a standing challenge — unset, the challenge evidence is appended as new criteria. With no adversary at all, a passing candidate is accepted without adversarial review.
- **bus** defaults to an in-memory write-ahead bus, returned on the run result for auditing.

The harness does not create, configure, or select agents — no models, prompts,
or agent frameworks appear in its API. Callbacks are the whole contract: bring
agents from any pipeline (or plain functions) and inject them.

## Install

```bash
npm install ts-autocode-harness
```

## Run the loop

The minimal loop is two callbacks:

```ts
import { defineTrainingHarness } from "ts-autocode-harness";

const result = await defineTrainingHarness<Candidate, Assessment, string>().run({
  task: { objective, target },
  rubric: "The candidate must pass AgentV and preserve its public contract.",
  student: myStudent,
  teacher: myTeacher,
});
```

Every default is replaceable — a durable bus, a gating judge, an adversary,
and a bespoke rubric revision:

```ts
import { join } from "node:path";
import { defineTrainingHarness, WriteAheadAgentBus } from "ts-autocode-harness";
import { createStorage } from "unstorage";
import fsDriver from "unstorage/drivers/fs";

const harness = defineTrainingHarness<Candidate, Assessment, string>({
  maxRounds: 3,
  candidateId: (candidate) => candidate.id,
});

const result = await harness.run({
  bus: new WriteAheadAgentBus({ storage: createStorage({ driver: fsDriver({ base: join(root, "actions") }) }) }),
  task: { objective, target },
  rubric: "The candidate must pass AgentV and preserve its public contract.",
  student: myStudent,
  teacher: myTeacher,
  judge: myJudge,
  adversary: { challenge: myAdversary, reviseRubric: myRubricRevision },
});
```

The judge first evaluates the candidate. A `fail` carries no judge feedback;
the next student turn receives only teacher feedback. A passing candidate is
challenged by the adversary. The candidate is accepted only when that
challenge fails. If the challenge stands, the rubric must be revised before
the next round.

## The message bus

`WriteAheadAgentBus` is an ordered append-only message log. It knows nothing
about any actor: `append({ actor, kind, payload })` records a message with
identity, ordering, and time, and `read(actor?)` returns the full history.
`agent(actor)` binds one actor to the bus and returns a writer — `write(kind,
payload?)` — so a caller that always writes as the same agent states the actor
once. An optional `allow` hook decides whether a given append or read may
proceed.
Configure `redact` when payloads may contain sensitive application data.

Storage is [unstorage](https://unstorage.unjs.io) — the bus owns no storage
logic of its own. Pass any unstorage instance through
`AgentBusSettings.storage` and pick the driver that fits the deployment:
memory (the default when unset), fs, redis, http, cloud KV, and the rest of
the driver ecosystem. Entries live under the `entry:*` keys of that storage;
a bus expects sole write access to them, so mount or prefix a shared storage
rather than pointing two writers at the same keys. Messages and entries are
parsed at the boundary with zod schemas (`agentMessage`, `agentBusEntry`), so
malformed values never enter the log.

The bus does **no context management** — no trailing windows, no truncation.
Shaping history into actor context is the consumer's job through
`HarnessInput.contextProvider`, which can window, summarize (in the style of
Semantic Kernel's chat-history reduction), or filter before each turn. The
`ts-autocode` package ships a rolling-window provider as its default.

The write-ahead convention is layered on top by `dispatchAction(bus, actor,
kind, payload, gate, execute)`:

1. append the intent;
2. ask the gate for an exact `pass` or `fail`;
3. append the verdict — the judge is just another actor, and its decision is
   an ordinary `agent.decision` message on the bus;
4. execute only after a pass;
5. append the outcome (`<kind>.completed` or `<kind>.failed`).

`defineTrainingHarness` dispatches every student, teacher, and adversary
invocation through this convention with the run's judge callback as the gate.
Without a configured judge, `dispatchAction` still records intent and outcome,
and the evidence convention's verdicts are appended the same way.

## Sandboxed execution

`MxcSandbox` adapts [Microsoft MXC](https://www.npmjs.com/package/@microsoft/mxc-sdk)
to a Deep-Agents-compatible sandbox backend. Every execute/upload/download
operation is dispatched through the bus as the configured `actor`, gated when
a `gate` is supplied. `createHarnessPolicy` builds the sandbox policy: network,
local-network, UI, clipboard, and input access are denied by default, and
`protectedPaths` (for example a file-backed bus log) must lie outside every
writable sandbox workspace. Add `allowedHosts` only when a sandboxed tool
genuinely needs outbound access.

```ts
import { createHarnessPolicy, MxcSandbox, WriteAheadAgentBus } from "ts-autocode-harness";

const sandbox = new MxcSandbox({
  id: "student",
  workspace,
  policy: createHarnessPolicy({ workspace, timeoutMs: 60_000 }),
  bus,
  actor: "student",
  gate: (action, context) => myJudge({ subject: "action", action, context }),
});
```

> [!WARNING]
> MXC is an early preview. Its upstream documentation warns that current profiles should not yet be treated as production security boundaries. Evaluate the selected MXC backend for your deployment.

## License

[MIT](LICENSE)
