# Case study: Coinbase AgentKit and the receipt nobody read

**Project:** [Coinbase AgentKit](https://github.com/coinbase/agentkit), a toolkit that gives AI
agents wallets and onchain actions.
**Status:** public issues and fix pull requests open.
**Money rules:** EMI-11 (status equals settlement), EMI-06 (one bounded signature).

## 1. A reverted transfer reported as "Transferred" (TypeScript)

The ERC-20 `transfer` action waited for the transaction receipt and then ignored it. A transfer
that was mined but reverted (for example by a paused token) was reported to the agent as
"Transferred", although no tokens moved. An agent that believes it has paid will not pay again
when it should, and will tell its user the bill is settled.

- Our public report: [issue #1558](https://github.com/coinbase/agentkit/issues/1558)
- Fix proposed by another contributor, crediting our report:
  [pull request #1556](https://github.com/coinbase/agentkit/pull/1556) (open)

## 2. Every successful swap approval reported as failed (Python)

Before a swap, the smart-wallet action sends a Permit2 approval for the maximum amount, then checks
the receipt with `receipt.status != "complete"`. The receipt is a web3.py receipt whose status is
the integer `1`, so the check is always true: every successful approval is reported as
"Approval transaction failed", after an unlimited allowance has already been granted. An agent
that retries approves again. The same integer-versus-string mistake affects the Python ERC-20
`transfer` and `approve` actions.

AgentKit's existing test mocked the event loop, so the code containing the check never ran.

- Our public report: [issue #1592](https://github.com/coinbase/agentkit/issues/1592)
- Our fix, with tests that run the swap coroutine:
  [pull request #1597](https://github.com/coinbase/agentkit/pull/1597) (open)

## What this shows

Both bugs come from the same place: code that sends a payment, waits for the receipt, and then
does not read it correctly. EMI-11, "status equals settlement", is the rule that catches them,
and it is the rule behind 11 scenarios in our catalogue.
