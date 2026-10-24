# Case study: ClawRouter's spending cap under concurrency and lost replies

**Project:** [ClawRouter](https://github.com/BlockRunAI/ClawRouter) (BlockRun), an LLM router that
pays for model calls with x402 micropayments.
**Fixed in:** [pull request #440](https://github.com/BlockRunAI/ClawRouter/pull/440), merged
11 October 2026, credited to EmberTail.
**Money rules:** EMI-01 (caps bind), EMI-09 (at most once).

## What we tested

ClawRouter lets an operator set a strict per-run spending cap. We set the cap to 0.012 of a test
token, priced each request at 0.008, and checked whether the cap held in two ordinary situations:
several requests arriving at the same time, and a payment that settles but whose reply is lost
(HTTP 502).

## What we found (version 0.12.282)

| Case (cap 0.012, each request 0.008)  | Settled   | Result               |
| ------------------------------------- | --------- | -------------------- |
| One normal request                    | 0.008     | PASS                 |
| Three requests, one after another     | 0.008     | PASS                 |
| **Three requests at the same time**   | **0.024** | **FAIL: 2x the cap** |
| **Payment settles, reply lost (502)** | **0.016** | **FAIL: paid twice** |

The cap checked what had already been spent, but reserved nothing for requests still in flight,
and counted a payment only after a successful reply. Both cases were reproduced on a local chain
and again on the public Base Sepolia test network with test tokens.

## After the fix (pull request #440)

| Case                              | Before | After                                              |
| --------------------------------- | ------ | -------------------------------------------------- |
| Three requests at the same time   | 0.024  | **0.008**: one paid, two refused with HTTP 429     |
| Payment settles, reply lost (502) | 0.016  | **0.008**: the retry is refused, no second payment |

All 13 local ClawRouter cases pass on the fix, including recipient, asset and network substitution checks.

Public Base Sepolia transactions (test tokens):

- Before, concurrent requests, three settlements:
  [1](https://sepolia.basescan.org/tx/0xff589005c3f19bb31b70069d3cf8a8b647633b4099824aed24def4d09c2369f0),
  [2](https://sepolia.basescan.org/tx/0xce783769e8a388d4bd9b3690ed51ec04b4a0884d5cf25888d4f2a29fb13fe5eb),
  [3](https://sepolia.basescan.org/tx/0x705d7446043688cbf4a4d41db5f107084d8f758490d20785698bcdb226c92155)
- After, concurrent requests, one settlement:
  [1](https://sepolia.basescan.org/tx/0x32aca9544d4ba83294b3f19217ff852fb0d094e7bc4cefa603fc47d6ddbd0efd)
- Before, lost 502, two settlements:
  [1](https://sepolia.basescan.org/tx/0x2a4634c309917b8cfa215bc7183641097478206cabd3e6d363eedc53637a320e),
  [2](https://sepolia.basescan.org/tx/0xe4e5fcc3a108e062d8ed20fcf42a5ac0c82f11219b0ff9cfb9c8f3fc69f059b6)
- After, lost 502, one settlement:
  [1](https://sepolia.basescan.org/tx/0x3b925ded030947109b4e94fa55bf936e87884a4ae5f0ef19307bf28f88c91fb7)

## Timeline

| Date (2026) | Event                                                      |
| ----------- | ---------------------------------------------------------- |
| 11 October  | Reported privately to the BlockRun team, with evidence     |
| 11 October  | Fix merged in pull request #440, credited to EmberTail     |
| 12 October  | We re-ran every case on the fix: 13 of 13 local cases pass |

Scope: test tokens, our own merchant and facilitator, never BlockRun's production gateway.
