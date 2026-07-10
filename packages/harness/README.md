# ts-autocode-harness

A small typed harness for bounded student/teacher training loops.

The package has no dependency on `ts-autocode`, model providers, evaluation
frameworks, or telemetry libraries. Callers supply a student, a teacher, and a
stable candidate identity. The harness owns feedback propagation, cancellation,
stall detection, and termination.

## Install

```bash
npm install ts-autocode-harness
```

## Use

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

## License

[MIT](LICENSE)
