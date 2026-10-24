# Security policy

## Reporting a problem in Money Check

Please report security problems in Money Check itself privately, through this repository's
**Security** tab ("Report a vulnerability"), rather than in a public issue.

We aim to acknowledge reports within five working days and to agree a disclosure date with you.

## Scope

In scope: the Money Check code in this repository (the command-line tool, grader, simulated
ledger, GitHub Action and adapter SDK).

Out of scope: the behaviour of the agent you test. Money Check runs your agent as a local process
without a sandbox, which is why `--trusted-agent` is required; run only agent code you trust.

## Reporting a money-correctness problem in someone else's project

If Money Check helps you find a problem in another project, please report it to that project
privately through its own security channel first.
