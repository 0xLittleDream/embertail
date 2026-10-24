# Case studies

Real money-correctness problems EmberTail found, reported privately, and saw fixed or made public.
Each links to the project's own record.

| Case study                       | Project             | What went wrong                                                     | Outcome                       |
| -------------------------------- | ------------------- | ------------------------------------------------------------------- | ----------------------------- |
| [ClawRouter](clawrouter.md)      | BlockRun ClawRouter | Spending cap broken by concurrent requests and lost replies         | Fixed in #440, credited       |
| [Franklin](franklin.md)          | BlockRun Franklin   | Double payments and false "unpaid" records after unclear replies    | Fixed in 3.49.7, credited     |
| [NOFX](nofx.md)                  | NOFX                | One request produced several redeemable payment authorizations      | Fixed in #1549                |
| [Coinbase AgentKit](agentkit.md) | Coinbase AgentKit   | Reverted transfers reported as paid; successful approvals as failed | Public issues; fixes proposed |

Eight further reports are under coordinated disclosure and will be added here once fixed. See
[FINDINGS.md](../../FINDINGS.md).
