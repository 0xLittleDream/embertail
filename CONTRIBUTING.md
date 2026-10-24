# Contributing

Thank you for helping make agent payments safer.

## Before you open a pull request

```bash
npm ci
npm run typecheck
npm test
npm run format:check
```

Both example agents must keep their results:

```bash
npm run embertail -- check --adapter examples/careful-payer/adapter.json --trusted-agent --pack incidents   # PASS, exit 0
npm run embertail -- check --adapter examples/baselines/blind-payer.json --trusted-agent --pack core        # FAIL, exit 1
```

## Changing the grader

A change to how a scenario is graded must come with a test that fails before the change and
passes after it, and with a control: a correct agent that still passes. A grader that passes
everything is as useless as one that fails everything.

## Adding a scenario

Describe the real-world failure it represents (with a public source), the money rule it maps to,
what a correct agent does, and what a failing agent does. Scenarios run on the simulated ledger
only.

## Licence of contributions

Contributions to `packages/adapter-sdk` are accepted under Apache-2.0; contributions elsewhere
under the Functional Source License in [LICENSE.md](LICENSE.md).
