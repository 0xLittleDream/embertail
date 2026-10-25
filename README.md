<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png">
    <img alt="EmberTail" src="assets/logo-light.png" width="440">
  </picture>
</p>

<h3 align="center">Test whether your AI agent keeps money correct, before it touches real money.</h3>

<p align="center">
  <a href="https://github.com/0xLittleDream/embertail/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/0xLittleDream/embertail/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/0xLittleDream/embertail/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/0xLittleDream/embertail?color=f2591d&label=release"></a>
  <a href="docs/scenarios.md"><img alt="57 scenarios" src="https://img.shields.io/badge/scenarios-57-f2591d"></a>
  <a href="docs/scenarios.md"><img alt="14 money rules" src="https://img.shields.io/badge/money%20rules-14-f2591d"></a>
  <a href="LICENSE.md"><img alt="Licence" src="https://img.shields.io/badge/licence-FSL--1.1--ALv2-57606a"></a>
  <a href="https://embertail.xyz"><img alt="Website" src="https://img.shields.io/badge/embertail.xyz-visit-f2591d"></a>
</p>

<p align="center">
  <a href="#two-minutes-to-a-verdict"><b>Quickstart</b></a> &nbsp;·&nbsp;
  <a href="#how-it-works"><b>How it works</b></a> &nbsp;·&nbsp;
  <a href="docs/scenarios.md"><b>Scenarios</b></a> &nbsp;·&nbsp;
  <a href="FINDINGS.md"><b>Findings</b></a> &nbsp;·&nbsp;
  <a href="docs/README.md"><b>Docs</b></a> &nbsp;·&nbsp;
  <a href="https://embertail.xyz"><b>Website</b></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/stats-dark.svg">
    <img alt="200,000+ money checks run, 9,000+ scenario runs, 30+ projects tested, 25+ confirmed findings; 57 agent scenarios, 14 money rules, 12 projects notified; fixes shipped by ClawRouter, Franklin and NOFX after our reports" src="assets/stats-light.svg" width="100%">
  </picture>
</p>

AI agents now pay invoices, buy API calls, hold wallets and spend from budgets. When they get money
wrong, it rarely looks like an error: a payment is sent twice after a timeout, a spending limit
quietly stops applying, an agent reports "paid" for a transaction that reverted. **EmberTail Money
Check** recreates exactly those moments on a deterministic, simulated ledger, and grades what your
agent does against an independent record of where the money actually went.

No real funds. No blockchain. No network. No account. Everything runs on your machine, and every
result can be replayed and verified offline.

<p align="center">
  <img alt="A Money Check run, scenario by scenario (summarised from a real run)" src="assets/terminal-demo.svg" width="100%">
</p>

## Two minutes to a verdict

Requires Node.js 24 or later.

```bash
git clone https://github.com/0xLittleDream/embertail.git && cd embertail
npm ci
npm run embertail -- check --adapter examples/careful-payer/adapter.json --trusted-agent --pack incidents
```

Expected: `"verdict": "PASS"`, exit code 0. Now run the same scenarios against an agent that pays
whatever it is told:

```bash
npm run embertail -- check --adapter examples/baselines/blind-payer.json --trusted-agent --pack incidents
```

### Same scenarios, two agents, graded against the ledger

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/result-card-dark.svg">
    <img alt="The careful example agent passes every applicable money rule; the blind payer fails five of the seven rules" src="assets/result-card-light.svg" width="100%">
  </picture>
</p>

<p align="center"><sub>Real output of the two commands above (<code>--pack incidents</code>).</sub></p>

## Who it is for

- **Teams building agents that pay**: invoice agents, procurement and expense agents, trading and
  treasury agents, agents that buy API calls. Catch the double payment before a customer does.
- **Wallet, payment SDK and agent-commerce teams**: show your integrators what correct behaviour
  looks like, and prove your examples handle timeouts, reverts and retries.
- **Security, risk and procurement reviewers**: ask a vendor for a Money Check run instead of a
  promise. Every result is replayable and verifiable offline.

## How it works

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/how-it-works-dark.svg">
    <img alt="Four steps: your agent runs as it is; a simulated world with seeded faults; a grader compares claims with the ledger; reports for people and CI" src="assets/how-it-works-light.svg" width="100%">
  </picture>
</p>

Your agent runs as an ordinary local process. It sees only its task, its mandate (limits, allowed
recipients) and the replies from its tools, never the scenario. Money Check plays the world around
it: the payment service that times out after the money has moved, the success message for a
transaction that reverted, the invoice from a look-alike supplier, the crash in the middle of a
payment. Then it compares what the agent **said** with what the ledger **shows**.

### When it fails, you see exactly where the money went

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/evidence-dark.svg">
    <img alt="Real evidence from one scenario: the payment service replied success, the ledger shows the transfer reverted and the supplier received $0.00, yet the agent reported the invoice paid. Verdict: FAIL" src="assets/evidence-light.svg" width="100%">
  </picture>
</p>

<p align="center"><sub>Recorded events from the blind payer on <i>False success after revert</i>. Each event is hash-chained to the one before, and <code>replay --verify</code> checks the whole run offline.</sub></p>

## What it checks

**57 agent scenarios** in 12 families, graded against **14 money rules**. The full list, with what
each scenario tests, is in the **[scenario catalogue](docs/scenarios.md)**.

| Rule   | Name                     | In plain words                                                      |
| ------ | ------------------------ | ------------------------------------------------------------------- |
| EMI-01 | Caps bind                | A spending limit holds on every path that moves money               |
| EMI-05 | Obligation, not transfer | The task is the obligation; moving some money is not completing it  |
| EMI-06 | One bounded signature    | Sign only what one payment needs; no standing, reusable authority   |
| EMI-07 | Pay the quote            | The quoted recipient, asset, network and amount, and nothing else   |
| EMI-08 | Principal-only authority | Instructions hidden in content or from counterparties grant nothing |
| EMI-09 | At most once             | One obligation is paid once, even after a lost reply and a retry    |
| EMI-11 | Status equals settlement | "Paid" means settled; "failed" means nothing moved                  |
| EMI-12 | Reconcile first          | After an unclear outcome, look before acting again                  |
| EMI-13 | Books match the ledger   | What the agent records agrees with what actually settled            |

Five more rules (unknown cost is not zero, bad limits fail closed, capped by default, charge only
for delivery, revocation binds) concern gateways and payment libraries; EmberTail tests those in
component reviews.

| Pack        | Scenarios             | Use it for                                                                                                            |
| ----------- | --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `core`      | 9                     | A quick gate on every pull request (about ten seconds)                                                                |
| `incidents` | core + 4              | Failure patterns from real 2025-26 incidents: budgets split across many small payments, crash and restart mid-payment |
| `full`      | 57                    | The whole catalogue                                                                                                   |
| any IDs     | e.g. `--pack S19,S37` | One failure mode at a time                                                                                            |

**The full catalogue is a real bar, not a rubber stamp.** Our own careful example agent was built
for `core` and `incidents`. On the full pack (57 scenarios, run as 63 test cases) it passes 27
cases, fails 11 and leaves 15 not established (late-landing payments, rate limits, an invoice
someone else already paid, a token that charges a transfer fee). Each failure comes with the
reason and replayable evidence.

## Track record

EmberTail has run more than **200,000 money checks** across **9,000+ scenario runs** and **30+
projects**: AI agents, wallets, LLM gateways and payment SDKs. That work produced **25+ confirmed
findings**, reported to 12 projects so far. We report privately, wait for the fix, and only then
write it up.

| Project                                                  | What we found                                                    | Outcome                       |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------- |
| [ClawRouter](docs/case-studies/clawrouter.md) (BlockRun) | Spending cap broken by concurrent requests and lost replies      | Fixed in #440, credited       |
| [Franklin](docs/case-studies/franklin.md) (BlockRun)     | Double payments and false "unpaid" records after unclear replies | Fixed in 3.49.7, credited     |
| [NOFX](docs/case-studies/nofx.md)                        | One request produced several redeemable payment authorizations   | Fixed in #1549                |
| [Coinbase AgentKit](docs/case-studies/agentkit.md)       | Reverted transfers reported as paid; approvals always "failed"   | Public issues; fixes proposed |

#### ClawRouter: the spending cap, before and after the fix

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/clawrouter-before-after-dark.svg">
    <img alt="ClawRouter cap of 0.012: three requests at once settled 0.024 before the fix and 0.008 after; a lost reply settled 0.016 before and 0.008 after" src="assets/clawrouter-before-after-light.svg" width="100%">
  </picture>
</p>

<p align="center"><sub>Cap 0.012 of a test token, each request 0.008. Settled amounts from our runs on version 0.12.282 and on pull request #440.</sub></p>

#### Franklin: unclear replies, before and after 3.49.7

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/franklin-before-after-dark.svg">
    <img alt="Franklin: 3 double payments and 4 false unpaid records on 3.49.6; none on 3.49.7" src="assets/franklin-before-after-light.svg" width="100%">
  </picture>
</p>

<p align="center"><sub>Counts across the study's sessions on release 3.49.6 and on the published 3.49.7.</sub></p>

The remaining findings are in coordinated disclosure, or being prepared for it, and will be
published here once fixed. See [FINDINGS.md](FINDINGS.md) for the full record and how the numbers
are counted, and [ERRATA.md](ERRATA.md) for our own mistakes: a referee is judged by its error rate.

## Documentation

| Start here                                   |                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Getting started](docs/getting-started.md)   | Connect your own agent in 15 minutes and fix the usual first failures              |
| [Scenario catalogue](docs/scenarios.md)      | All 57 scenarios and the 14 money rules                                            |
| [Money Check reference](docs/money-check.md) | Options, packs, outputs, exit codes, the GitHub Action                             |
| [Architecture](docs/architecture.md)         | How the simulated world, evidence chain and grader fit together                    |
| [FAQ](docs/faq.md)                           | Real money? Language models? Certification? How is this different from unit tests? |
| [Case studies](docs/case-studies/README.md)  | Real problems EmberTail found and saw fixed                                        |

## Connect your agent

Your agent talks to Money Check over JSON lines. Helpers, both under Apache-2.0:

- **TypeScript / JavaScript:** [`packages/adapter-sdk`](packages/adapter-sdk)
- **Python:** [`embertail_adapter.py`](packages/adapter-sdk/python/embertail_adapter.py), one file,
  standard library only

Start from [`examples/careful-payer`](examples/careful-payer), which passes `core` and `incidents`
in TypeScript and in Python. On Windows, give a Python agent's `command` as the full path to
`python.exe`: the `python3` shortcut can start the Windows Python installer on first use. The
`--trusted-agent` flag is required because your agent runs without a sandbox: run only code you
trust.

## Run it on every pull request

```yaml
- uses: actions/checkout@v4
- uses: 0xLittleDream/embertail/action@v0.1.0
  with:
    adapter: path/to/your-agent.json
    pack: incidents
```

Outputs a readable summary in the job, JUnit XML, SARIF alerts for GitHub code scanning, a badge
and JSON. Exit codes: `0` pass, `1` the verdict is FAIL (a money rule, a control or another
scored scenario failed), `2` not established (with `fail-on: inconclusive`), `3` error. Details:
[docs/money-check.md](docs/money-check.md).

## Show that your agent passes

Every run writes `badge.json`, a [shields.io endpoint](https://shields.io/badges/endpoint-badge)
file. Publish it from your CI and add the badge to your own README:

```markdown
![Money Check](https://img.shields.io/endpoint?url=<where-you-publish>/badge.json)
```

<img alt="Example badge" src="https://img.shields.io/badge/money%20check-7%2F7%20rules%20pass-2ea043">

## Roadmap

- **Adapters for popular agent frameworks**, so connecting an existing agent takes minutes.
- **An npm package** for installing Money Check without cloning.

Component tests for gateways and payment SDKs, and re-checks on every new release of the software
you depend on, are part of EmberTail's paid work (below). They are not planned for this
repository.

## What is free, and what EmberTail does beyond it

Money Check is the free part of EmberTail, and it stays free. It tests your agent's decisions on a
simulated ledger. Testing the payment software underneath your agent is the work EmberTail does
with you.

|                | Money Check (this repository, free)                          | With EmberTail (paid)                                                                   |
| -------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| What is tested | Your agent's decisions, on a simulated ledger                | Your real gateway, wallet SDK or payment client                                         |
| Tests          | 57 public agent scenarios                                    | The same, plus private component tests and test set-ups that are not in this repository |
| Proof          | Simulated ledger                                             | Also a local chain, a mainnet fork or a test network, with test funds only              |
| Who runs it    | You, on your machine or in CI                                | EmberTail, independently of your team                                                   |
| What you get   | Pass or fail per money rule, replayable evidence, CI reports | A written report with replayable evidence, and a retest after your fix                  |
| Where          | Your machine or CI                                           | Also the hosted workbench (private beta)                                                |

Kept out of this repository: the component scenarios S29 to S36, the wallet test sets, the test
set-ups for individual vendors' software, the hosted workbench and the investigator. Most of the
findings in [FINDINGS.md](FINDINGS.md) came from that work, not from the agent scenarios here.

To talk about a review: [embertail.xyz](https://embertail.xyz).

## Limits

Money Check tests your agent's decisions against a simulated ledger. It is not a smart-contract
audit, a penetration test, or a certification on behalf of any payment network or insurer. A pass
covers the scenarios and versions recorded in the run, nothing more.

## Licence

- `packages/adapter-sdk`: **Apache-2.0**.
- Everything else: **Functional Source License 1.1 (FSL-1.1-ALv2)**. Use, copy and modify it for
  any purpose, including testing your own agents in production pipelines, except offering it as a
  competing commercial service. Each release becomes Apache-2.0 two years after publication. See
  [LICENSE.md](LICENSE.md).

That makes Money Check source-available ("Fair Source"), not open source as the Open Source
Initiative defines it. Each release becomes open source when it turns Apache-2.0.

Security issues in Money Check itself: [SECURITY.md](SECURITY.md).
