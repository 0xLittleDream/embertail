# Architecture

Money Check is a small number of independent parts with one rule between them: **the agent's claims
and the ledger's record are kept separate, and only the grader compares them.**

```text
             task + mandate                    actions
 runner ───────────────────────▶  your agent ─────────────▶  engine (simulated world)
   │                                  ▲                          │
   │                                  └──────── replies ─────────┤
   │                                                             │ events
   │                                                             ▼
   │                                                     evidence bus (hash chain)
   │                                                             │
   └──────────── grading ◀─────────── verifiers ◀───────────────┘
                    │
                    ▼
                 reports  →  summary.md · JUnit · SARIF · badge · JSON · HTML
```

| Package                                    | Role                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| [`contracts`](../packages/contracts)       | Shared types: scenarios, mandates, ledger state, actions, results                                                        |
| [`runner`](../packages/runner)             | Expands a pack into cases, starts your agent, runs each case, stores runs                                                |
| [`engine`](../packages/engine)             | The deterministic simulated world: ledger, block time, seeded faults (timeouts, false success, late settlement, crashes) |
| [`evidence-bus`](../packages/evidence-bus) | Records every event in a hash chain, with secret redaction, so a run can be replayed and verified                        |
| [`verifiers`](../packages/verifiers)       | Read what actually settled, independently of what the agent was told                                                     |
| [`grading`](../packages/grading)           | Applies the versioned money policy: compares claims with the ledger, scenario by scenario                                |
| [`diagnostics`](../packages/diagnostics)   | Turns a failure into plain language: what went wrong and how much money was exposed                                      |
| [`reports`](../packages/reports)           | Money Check outputs: summary, JUnit, SARIF, badge, JSON and the HTML report                                              |
| [`adapter-sdk`](../packages/adapter-sdk)   | The TypeScript and Python helpers your agent uses to talk to the runner (Apache-2.0)                                     |

## Design rules

- **Deterministic world.** A scenario and a seed fix every reply, delay and fault, so the same run
  can be reproduced exactly and replayed offline.
- **The agent never sees the scenario.** It sees only its task, its mandate and tool replies.
- **Independent truth.** The grader reads settlement from the ledger record, never from what the
  agent reported or what a tool replied.
- **Conservative verdicts.** A rule passes only when every scenario behind it passes. Anything that
  cannot be established is reported as such and never counted as a pass.
- **Versioned policy.** Grading semantics carry a version, so a change in how a scenario is judged
  is explicit and old runs keep their meaning.
- **Not a sandbox.** Your agent runs as an ordinary local process. That is why `--trusted-agent` is
  required.
