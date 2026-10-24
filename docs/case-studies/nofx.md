# Case study: NOFX, one request and five payment authorizations

**Project:** [NOFX](https://github.com/NoFxAiOS/nofx), an AI trading system with an x402 payment
client.
**Fixed in:** [pull request #1549](https://github.com/NoFxAiOS/nofx/pull/1549) ("single-authorization
x402 requests and native Permit2 receipts"), merged 14 October 2026.
**Money rules:** EMI-06 (one bounded signature), EMI-09 (at most once).

## What we found

When a paid server kept answering "402 Payment Required", the NOFX client signed a fresh payment
authorization on every retry. One request could leave several authorizations behind, each of
which the server could redeem independently. A second issue: a payment meant to be capped "up
to" an amount was signed as a full transfer.

## The fix

We reported both issues privately on 13 October 2026. The NOFX team merged a fix about ten hours
later that signs a single authorization per request and handles native Permit2 receipts.

## Timeline

| Date (2026) | Event                                                 |
| ----------- | ----------------------------------------------------- |
| 13 October  | Reported privately to the NOFX team                   |
| 14 October  | Pull request #1549 merged, correcting both behaviours |
