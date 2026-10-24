# EmberTail Money Check

**Test whether your AI agent keeps money correct, before it touches real money.**

Money Check runs your agent against payment scenarios on a deterministic, simulated ledger and
reports, rule by rule, whether it kept money correct: did it pay the right recipient the quoted
amount exactly once, stay inside its limits, and report "paid" only when the ledger shows the
money settled?

No real funds, no blockchain and no network access. Everything runs on your machine, and every
result can be replayed and verified offline.

```bash
npm ci
npm run embertail -- check --adapter examples/careful-payer/adapter.json --trusted-agent --pack core
```

Expected: `"verdict": "PASS"` and exit code 0. Then try the careless agent, which fails:

```bash
npm run embertail -- check --adapter examples/baselines/blind-payer.json --trusted-agent --pack core
```

Requires Node.js 24 or later.

## What it checks

Each scenario is graded against fixed money rules. A rule passes only when every scenario behind
it passes; anything that could not be established is reported as such and never counted as a
pass.

| Pack        | Scenarios                         | What it covers                                                                                                                                                                                                                     |
| ----------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`      | 9 (7 scored for an outside agent) | Exact payment, look-alike recipients, untrusted content, false success replies, duplicate payment after a timeout, a timeout before anything was paid                                                                              |
| `incidents` | core + 4                          | Failure patterns seen in real 2025-26 incidents: many small payments that each pass a per-payment cap but together break the budget, splitting one invoice to slip under a cap, and a crash and restart in the middle of a payment |

The full rule list, scenario map, output formats and limits are in
[docs/money-check.md](docs/money-check.md).

## Connect your agent

Your agent runs as a local process and talks to Money Check over JSON lines. Helpers:

- **TypeScript / JavaScript:** [`packages/adapter-sdk`](packages/adapter-sdk) (Apache-2.0).
- **Python:** [`packages/adapter-sdk/python/embertail_adapter.py`](packages/adapter-sdk/python/embertail_adapter.py),
  one file, standard library only (Apache-2.0).

Start from [`examples/careful-payer`](examples/careful-payer), which passes both packs in
TypeScript and in Python. On Windows, give a Python agent's `command` as the full path to
`python.exe`: the `python3` shortcut can start the Windows Python installer on first use, which
disturbs the first run. `--trusted-agent` is required because your agent runs without a
sandbox: run only code you trust.

## Run it on every pull request

```yaml
- uses: actions/checkout@v4
- uses: 0xLittleDream/money-check/action@v0.1.0
  with:
    adapter: path/to/your-agent.json
    pack: incidents
```

Outputs: a readable summary, JUnit XML, SARIF (for GitHub code scanning), a badge and JSON.
Exit codes: `0` pass, `1` a money rule failed, `2` inconclusive (with `fail-on: inconclusive`),
`3` error.

## Track record

EmberTail tests the money controls in AI agents, gateways and payment libraries. Fixes made after
our reports are listed in [FINDINGS.md](FINDINGS.md), and our own mistakes in
[ERRATA.md](ERRATA.md).

## Limits

Money Check tests your agent's decisions against a simulated ledger. It is not a smart-contract
audit, a penetration test, or a certification on behalf of any payment network or insurer. It
covers 7 of EmberTail's 14 money rules in its public packs; deeper testing of gateways, SDKs and
complete agent stacks is available from EmberTail directly.

## Licence

- The adapter SDK (`packages/adapter-sdk`) is licensed under **Apache-2.0**.
- Everything else is licensed under the **Functional Source License 1.1 (FSL-1.1-ALv2)**: you may
  use, copy and modify it for any purpose, including testing your own agents in production
  pipelines, except offering it as a competing commercial service. Each release converts to
  Apache-2.0 two years after it is published. See [LICENSE.md](LICENSE.md).

Security issues in Money Check itself: see [SECURITY.md](SECURITY.md).
