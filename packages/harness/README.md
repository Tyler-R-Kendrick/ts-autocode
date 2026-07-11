# ts-autocode-harness

A bounded student/teacher training harness built on LangChain Deep Agents. Agent tools execute through Microsoft MXC with default-deny, OpenShell-aligned policy settings.

The package does not depend on `ts-autocode` or a specific model provider. The control loop and credentials stay outside the sandbox. Generated code, filesystem tools, shell commands, and candidate execution cross the MXC boundary. AgentV remains responsible for objective evaluation; the teacher consumes its evidence instead of inventing scores.

## Install

```bash
npm install ts-autocode-harness
```

## Use

Create the host-side Deep Agents and their sandbox policy once:

```ts
import { createHarnessPolicy, createTrainingAgents } from "ts-autocode-harness";

const workspace = "/absolute/path/to/training-output";
const policy = createHarnessPolicy({ workspace, timeoutMs: 60_000 });
const agents = createTrainingAgents({
  student: { id: "student", workspace, policy },
  teacher: { id: "teacher", workspace, policy },
});
```

`defineTrainingHarness(...).runAgents(...)` invokes those agents for each bounded student/teacher round. Its small prompt/output adapters keep candidate and AgentV assessment types owned by the calling library instead of duplicating them in the harness.

Network and UI access are denied by default. Add `allowedHosts` only when a sandboxed tool genuinely needs outbound access. Keep API keys in host-side model or tool configuration; do not write them into the workspace.

Coordinate bounded rounds with the existing typed loop:

```ts
import { defineTrainingHarness } from "ts-autocode-harness";

const harness = defineTrainingHarness<string, number, string>({
  maxRounds: 3,
  candidateId: (candidate) => candidate,
});

const run = await harness.run({
  student: ({ feedback }) => proposeCandidate(feedback),
  teacher: async (candidate) => {
    const score = await evaluate(candidate);
    return {
      accepted: score >= 0.9,
      assessment: score,
      feedback: score >= 0.9 ? [] : ["Improve correctness"],
    };
  },
});
```

The outcome is `accepted`, `stalled`, or `exhausted`. Every round retains the
candidate and teacher assessment; `final` references the last round.

> [!WARNING]
> MXC is an early preview. Its upstream documentation warns that current profiles should not yet be treated as production security boundaries. Evaluate the selected MXC backend for your deployment.

## License

[MIT](LICENSE)
