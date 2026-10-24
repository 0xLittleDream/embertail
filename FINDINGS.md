# Findings and fixes

EmberTail reports money-correctness problems privately to the projects concerned, and lists them
here only once they are fixed or already public. Each entry links to the project's own record.

Last updated: 24 October 2026.

## Fixed after our reports

| Project                   | What we reported                                                                                                     | Fix                                                                                            | Credit                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **ClawRouter** (BlockRun) | The per-run spending cap could be exceeded when requests ran concurrently, and failed paid requests were not counted | [Pull request #440](https://github.com/BlockRunAI/ClawRouter/pull/440), merged 11 October 2026 | Credited in the pull request                                                                     |
| **Franklin** (BlockRun)   | Double payments, and payments recorded as unpaid while their outcome was still unknown                               | [Release 3.49.7](https://github.com/BlockRunAI/Franklin/releases/tag/v3.49.7)                  | Named in the [3.49.9 release notes](https://github.com/BlockRunAI/Franklin/releases/tag/v3.49.9) |
| **NOFX**                  | One x402 request could produce several independently redeemable payment authorizations                               | [Pull request #1549](https://github.com/NoFxAiOS/nofx/pull/1549), merged 14 October 2026       | (none)                                                                                           |

## Public, fix proposed

| Project                            | What we reported                                                                                                                                                                                                         | Status                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Coinbase AgentKit** (TypeScript) | An ERC-20 transfer is reported as "Transferred" when the transaction reverts                                                                                                                                             | Our [issue #1558](https://github.com/coinbase/agentkit/issues/1558); outside fix [pull request #1556](https://github.com/coinbase/agentkit/pull/1556) open |
| **Coinbase AgentKit** (Python)     | The swap's Permit2 approval is always reported as failed (an integer receipt status compared with a string), after an unlimited allowance was already granted; the ERC-20 transfer has the same receipt problem as above | Our [issue #1592](https://github.com/coinbase/agentkit/issues/1592); our fix [pull request #1597](https://github.com/coinbase/agentkit/pull/1597) open     |

## Under coordinated disclosure

Eight further reports to other projects are in coordinated disclosure. Each will be listed here,
with a link to the vendor's own fix or advisory, once it is fixed or published.

## How we report

- Privately first, through the project's security channel.
- Every finding is reproduced against the project's own published code, with a control run that
  behaves correctly, so a failure cannot be an artefact of our tooling.
- Before calling anything a defect, we check whether the project's own tests assert the
  behaviour, and treat it as a design decision if they do.
- We publish nothing before a fix is available or 90 days have passed.
