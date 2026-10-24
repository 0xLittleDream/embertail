# Case study: Franklin and the payment that may already have gone through

**Project:** [Franklin](https://github.com/BlockRunAI/Franklin) (BlockRun), an autonomous agent
that pays for services on its own.
**Fixed in:** [release 3.49.7](https://github.com/BlockRunAI/Franklin/releases/tag/v3.49.7);
EmberTail named in the [3.49.9 release notes](https://github.com/BlockRunAI/Franklin/releases/tag/v3.49.9).
**Money rules:** EMI-09 (at most once), EMI-11 (status equals settlement), EMI-12 (reconcile first).

## What we tested

The hardest moment for a paying agent is an unclear reply: the payment service times out or
returns an error, and the agent cannot tell whether the money moved. Our scenarios recreate
exactly that moment (S19, S37 and their relatives), on a simulated ledger and on a local chain,
and grade what the agent does next against an independent record of what actually settled.

## What we found (release 3.49.6)

Across 37 sessions:

- **3 double payments**: after an unclear reply, the agent sent the same obligation again under
  a new request, and both payments settled.
- **4 false "unpaid" records**: the agent recorded payments as failed while their outcome was
  still unknown, which invites a later second payment.

## After the fix (release 3.49.7)

BlockRun moved the protection from a prompt instruction into code: a payment whose outcome is
unknown is held, and is not repeated. We re-ran the study against the published 3.49.7 release:

| Measure                                        | 3.49.6 | 3.49.7 |
| ---------------------------------------------- | ------ | ------ |
| Double payments                                | 3      | **0**  |
| Payments recorded "unpaid" while still unknown | 4      | **0**  |

## Our own mistake, and how it was caught

Our first 3.49.7 report also listed one double payment (scenario S40). BlockRun investigated and
showed that it came from a bug in our own transcript extractor, not from Franklin. We fixed the
extractor and corrected the record; it is noted in the
[3.49.10 release notes](https://github.com/BlockRunAI/Franklin/releases/tag/v3.49.10) and in our
[errata](../../ERRATA.md). A referee is only as good as its error rate, so we publish these.

## Timeline

| Date (2026)   | Event                                                             |
| ------------- | ----------------------------------------------------------------- |
| Early October | Study of releases 3.49.5 and 3.49.6 shared with BlockRun          |
| October       | 3.49.7 released with the guard in code                            |
| October       | Re-run on 3.49.7: no double payments, no false "unpaid"           |
| October       | 3.49.9 release notes name EmberTail; 3.49.10 notes our correction |
