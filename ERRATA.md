# Errata

A test tool is only as useful as its error rate. When EmberTail gets something wrong, it is
corrected here and with the project concerned.

| Date         | What we got wrong                                                                                                                                                      | Correction                                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| October 2026 | We reported a double payment by Franklin (our scenario S40). It came from a bug in our own transcript extractor, not from Franklin. BlockRun found it.                 | Corrected with BlockRun; noted in the [Franklin 3.49.10 release notes](https://github.com/BlockRunAI/Franklin/releases/tag/v3.49.10). Our extractor was fixed. |
| October 2026 | Money Check 0.1.0 could mark a money rule FAIL for a failure that rule does not cover, and its badge could read "N/N rules pass" on a failed run. Verdicts were right. | Fixed in 0.1.1, with no verdict changed. Details below.                                                                                                        |

So far no error in our own tooling has hidden a real failure. The Franklin error produced a false
one. The Money Check 0.1.0 errors put failures under the wrong money rule or described them
wrongly, while the verdict and exit code stayed right. We treat a reported failure as unproven
until a control run and the project's own code confirm it.

## Money Check 0.1.0 reporting errors (fixed in 0.1.1)

What 0.1.0 reported wrongly:

1. **A rule could show FAIL because of a check it does not cover.** A rule's status came from
   whole scenarios, so any failed check in a scenario failed every rule mapped to it. The
   task-completion check (did the agent do the work?) and the evidence checks fail no rule in 0.1.1.
   In 0.1.0 they could fail every rule of their scenario. Example: an agent that did nothing in S19
   failed only the task check, yet EMI-09 "At most once" showed FAIL with $0 paid. In a scenario
   that tests several rules, a check belonging to one rule also failed the others. SARIF filed each
   failure under the scenario's first rule.
2. **A failed control could leave the badge reading "N/N rules pass".** When a control (S01) or
   another scenario failed without failing any money rule, the run correctly failed (verdict FAIL,
   exit code 1, a red badge), but the badge text still said every rule passed.
3. **The docs described exit code 1 as "a money rule failed".** It means the overall verdict is
   FAIL, which a failed control or an unfinished task can also cause.

Who it affected: anyone who read rule statuses, the badge text or SARIF rule IDs from 0.1.0
(released 24 October 2026). Item 1 affects agents whose failures were unfinished tasks or false
completion claims, such as our `do-nothing` and `claims-done` baselines: their rules now show
INCONCLUSIVE where 0.1.0 showed FAIL. Agents that paid correctly or paid wrongly were not
affected: the careful payer, the blind payer and both built-in profiles show the same rule
statuses in 0.1.0 and 0.1.1. No scenario verdict, overall verdict or exit code was wrong.

How to tell whether a 0.1.0 result was affected:

- In `summary.md`, a FAIL rule was misattributed when every failed scenario behind it is
  described as "Incomplete: the agent did not do the work it was allowed to do" or "Harness
  problem". The same holds when the HTML report shows that the scenario's failed checks are all
  ones the rule does not cover (see the table in [docs/money-check.md](docs/money-check.md)).
- A red badge that reads "N/N rules pass" means a control or another scenario failed outside the
  rules; "What failed" in `summary.md` names it.
- Running `check` again with 0.1.1 gives the corrected rule table. Runs recorded with 0.1.0 still
  pass `replay --verify` with 0.1.1.
