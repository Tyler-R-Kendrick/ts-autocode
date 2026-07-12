# ts-autocode-harness

A policy-enforced code-training harness: a bounded callback loop, a durable
agent message bus, and an MXC-sandboxed execution backend.

The harness coordinates four callbacks a consumer supplies:

- **student** proposes a candidate from the rubric, teacher feedback, and recent bus history;
- **teacher** assesses objective evidence and revises the rubric when an adversarial challenge exposes a gap;
- **judge** accepts any input, returns only `pass` or `fail`, and never supplies rejection feedback;
- **adversary** receives only the artifact under test and its own prior messages, so it has no knowledge of the training loop.

The harness does not create, configure, or select agents — no models, prompts,
or agent frameworks appear in its API. Callbacks are the whole contract: bring
agents from any pipeline (or plain functions) and inject them.

## Install

```bash
npm install ts-autocode-harness
```

## Run the loop

```ts
import { join } from "node:path";
import { defineTrainingHarness, WriteAheadAgentBus } from "ts-autocode-harness";

const harness = defineTrainingHarness<Candidate, Assessment, string>({
  maxRounds: 3,
  candidateId: (candidate) => candidate.id,
});

const result = await harness.run({
  bus: new WriteAheadAgentBus({ file: join(root, "actions.jsonl") }),
  task: { objective, target },
  rubric: "The candidate must pass AgentV and preserve its public contract.",
  student: myStudent,
  teacher: myTeacher,
  judge: myJudge,
  adversary: myAdversary,
  reviseRubric: myRubricRevision,
});
```

The judge first evaluates the candidate. A `fail` carries no judge feedback;
the next student turn receives only teacher feedback. A passing candidate is
challenged by the adversary. The candidate is accepted only when that
challenge fails. If the challenge passes, the teacher must revise the rubric
before the next round.

## The message bus

`WriteAheadAgentBus` is a durable append-only JSONL message log. It knows
nothing about any actor: `append({ actor, kind, payload })` records a message
with identity, ordering, and time, and `read(actor?)` returns the trailing
window. An optional `allow` hook decides whether a given append or read may
proceed. Configure `redact` when payloads may contain sensitive application
data.

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
Without a gate, `dispatchAction` still records intent and outcome.

## Sandboxed execution

`MxcSandbox` adapts [Microsoft MXC](https://www.npmjs.com/package/@microsoft/mxc-sdk)
to a Deep-Agents-compatible sandbox backend. Every execute/upload/download
operation is dispatched through the bus as the configured `actor`, gated when
a `gate` is supplied. `createHarnessPolicy` builds the sandbox policy: the bus
file must be outside every writable sandbox workspace, and network,
local-network, UI, clipboard, and input access are denied by default. Add
`allowedHosts` only when a sandboxed tool genuinely needs outbound access.

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
