# ts-autocode-harness

A policy-enforced training harness built on LangChain Deep Agents, Microsoft MXC, and GEPA.

The harness coordinates four independently configurable roles:

- **student** proposes a candidate from the rubric, teacher feedback, and recent action history;
- **teacher** assesses objective evidence and revises the rubric when an adversarial challenge exposes a gap;
- **judge** accepts any input, returns only `pass` or `fail`, and never supplies rejection feedback;
- **adversary** receives only the artifact under test and its own prior actions, so it has no knowledge of the training loop.

AgentV remains responsible for objective evaluation. Model credentials stay outside the sandbox.

## Install

```bash
npm install ts-autocode-harness
```

## Configure agents

Each role may use its own model and system prompt. The top-level model is only a default.

```ts
import { join } from "node:path";
import { createHarnessPolicy, createTrainingAgents } from "ts-autocode-harness";

const root = "/absolute/path/to/training-output";
const role = (name: string) => {
  const workspace = join(root, "sandboxes", name);
  return {
    sandbox: {
      id: name,
      workspace,
      policy: createHarnessPolicy({ workspace, timeoutMs: 60_000 }),
    },
  };
};

const agents = createTrainingAgents({
  bus: { file: join(root, "actions.jsonl") },
  model: "openai:gpt-5.4-mini",
  gepa: { reflection_lm: "openai/gpt-5.4", numThreads: 4, auto: "light" },
  student: { ...role("student"), systemPrompt: "Propose minimal TypeScript improvements.", evolution: studentEvolution },
  teacher: { ...role("teacher"), systemPrompt: "Assess AgentV evidence and maintain the rubric.", evolution: teacherEvolution },
  judge: { ...role("judge"), model: "openai:gpt-5.4", systemPrompt: "Return exactly pass or fail.", evolution: judgeEvolution },
  adversary: { ...role("adversary"), systemPrompt: "Find concrete failures in the supplied artifact.", evolution: adversaryEvolution },
  outputs: {
    student: decodeCandidate,
    teacher: decodeAssessment,
    adversary: decodeChallenge,
    revision: decodeRubricRevision,
  },
});
```

The bus file must be outside every writable sandbox workspace. Network, local-network, UI, clipboard, and input access are denied by default. Add `allowedHosts` only when a sandboxed tool genuinely needs outbound access.

## Evolve every role with GEPA

Each role can provide independent examples and a metric. GEPA co-evolves all configured system prompts in one multi-component optimization, then the same callbacks continue with the selected prompts. This uses the official Python GEPA engine through `gepa-rpc`; install [uv](https://docs.astral.sh/uv/getting-started/installation/) on the host so its `uvx` command is available.

```ts
const judgeEvolution = {
  examples: [
    { input: { candidate: passingCandidate }, expected: "pass" },
    { input: { candidate: brokenCandidate }, expected: "fail" },
  ],
  evaluate: ({ expected }, output) => ({
    score: output === expected ? 1 : 0,
    feedback: output === expected ? "Correct decision" : `Expected ${expected}`,
  }),
};
```

Evolution inputs mirror their callbacks: a student example contains a `StudentTurn`; teacher examples contain `{ candidate, turn }`, or `{ operation: "revision", challenge, turn }`; judge examples may contain any value; adversary examples contain `{ candidate, turn }`. Metrics return a score and should include concise diagnostic feedback so GEPA has actionable side information. Evolution is judge-approved and written to the agent bus before it executes.

## Run the loop

There is one Flue-style callback run model. `createTrainingAgents` adapts evolved Deep Agents to those callbacks; applications can replace any callback without selecting a separate execution path.

```ts
const harness = defineTrainingHarness<Candidate, Assessment, string>({
  maxRounds: 3,
  candidateId: (candidate) => candidate.id,
});

const result = await harness.run({
  ...agents,
  task: { objective, target },
  rubric: "The candidate must pass AgentV and preserve its public contract.",
});
```

The judge first evaluates the candidate. A `fail` carries no judge feedback; the next student turn receives only teacher feedback. A passing candidate is challenged by the adversary. The candidate is accepted only when that challenge fails. If the challenge passes, the teacher must revise the rubric before the next round.

## Write-ahead enforcement

Every student, teacher, and adversary invocation and every sandbox execute/upload/download operation follows this order:

1. append `proposed` to the JSONL bus;
2. obtain an exact `pass` or `fail` judge decision;
3. append `approved` or `denied`;
4. execute only after approval;
5. append `completed` or `failed`.

Judge actions are also written ahead, but use a private non-recursive control-plane path because a judge cannot approve its own invocation. The public API cannot invoke that bootstrap path. Recent bus entries are added to student, teacher, and judge context to correct trajectories. The adversary receives only adversary entries.

Configure `bus.redact` when action payloads or results may contain sensitive application data. Do not place secrets in sandbox commands, files, or prompts.

> [!WARNING]
> MXC is an early preview. Its upstream documentation warns that current profiles should not yet be treated as production security boundaries. Evaluate the selected MXC backend for your deployment.

## License

[MIT](LICENSE)
