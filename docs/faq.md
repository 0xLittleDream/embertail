# Frequently asked questions

## Does Money Check touch real money or a real blockchain?

No. Every scenario runs on a deterministic, simulated ledger on your machine. There are no funds,
no network calls and no account to create.

## My agent uses a language model. Does that work?

Yes. Money Check does not care how your agent decides; it controls only the world the agent acts
in. A model-driven agent may give different answers on different runs, so run important packs
more than once. The scenario seed fixes the world, not the model.

## How is this different from my unit tests?

|                         | Unit tests                    | Penetration test            | Money Check                               |
| ----------------------- | ----------------------------- | --------------------------- | ----------------------------------------- |
| Who writes the failures | You, for cases you thought of | A consultant, once          | A fixed catalogue of 57 failure scenarios |
| What it checks          | Your code paths               | Exploitable vulnerabilities | Whether money ends up correct             |
| Judged against          | Your assertions               | The tester's findings       | An independent ledger record              |
| Runs on every change    | Yes                           | No                          | Yes, as a GitHub Action                   |
| Replayable evidence     | Sometimes                     | Report only                 | Every run, offline                        |

Unit tests check what you expected. Money Check checks the moments you did not expect: the timeout
after the money moved, the success reply for a reverted transaction, the crash mid-payment.

## Is a PASS a certification?

No. A pass covers the scenarios and versions recorded in the run. It is evidence you can show, not
a certificate on behalf of any payment network, insurer or regulator.

## What does "not established" mean?

The scenario's outcome could not be determined, for example because the agent never reported a
result or the hazard never reached it. It is shown separately and never counted as a pass.

## Why are 9 scenarios "not applicable to outside agents"?

They need a task the adapter protocol cannot yet hand to an outside agent (for example a price feed
under the agent's control). They run against EmberTail's built-in reference agents. They are listed
in the [catalogue](scenarios.md) so you know they exist.

## Can I add my own scenarios?

Yes. See [CONTRIBUTING.md](../CONTRIBUTING.md). A scenario should describe a real failure, the money
rule it maps to, and what a correct and a failing agent each do.

## Who is behind this?

[EmberTail](https://embertail.xyz). We test the money controls in AI agents, gateways and payment
libraries, report problems privately, and publish them once fixed. See the
[case studies](case-studies/README.md).

## Can I use it at my company?

Yes, for any purpose including production pipelines, except offering it as a competing commercial
service. Each release becomes Apache-2.0 two years after it is published. The adapter SDK is
Apache-2.0 today. See [LICENSE.md](../LICENSE.md).
