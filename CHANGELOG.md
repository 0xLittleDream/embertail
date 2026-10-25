# Changelog

## 0.1.1 (2026-10-25)

A reporting fix. **No verdict changed.** The grader (`packages/grading`) is byte-identical to
0.1.0, so the grader hash recorded in each run is the same, every scenario verdict and every exit
code is the same, and runs recorded with 0.1.0 still pass `replay --verify`. What changed is how a
failure is attributed to the money rules and how the outputs describe it. The same errors in
0.1.0 are listed in [ERRATA.md](ERRATA.md).

- **A rule now fails only on a check it covers.** In 0.1.0 any failed check in a scenario failed
  every rule mapped to that scenario. An agent that did nothing in S19 failed only the
  task-completion check, yet EMI-09 "At most once" showed FAIL with $0 paid. Each rule now lists the
  grader checks that can fail it. Task completion and evidence checks fail no rule. A rule still
  passes only when every scenario behind it passes; otherwise it is INCONCLUSIVE. Some rule
  statuses therefore move from FAIL to INCONCLUSIVE, and only for agents like the `do-nothing` and
  `claims-done` baselines. No status moves to PASS. The careful payer, the blind payer and both
  built-in profiles show the same rule statuses as in 0.1.0: the blind payer still fails five of
  the seven rules in the incidents pack.
- **A failed control is now named.** A failed control (S01), or any scenario that fails no rule,
  still fails the run, but in 0.1.0 the badge could read "5/5 rules pass" in red. It now reads "1
  control failing" or "1 scenario failing". The summary names the scenario, `result.json` lists it
  in a new `failedOutsideRules` field (also printed by `check`), and SARIF files it under
  `EMBERTAIL-SCENARIO`. Each case in `result.json` also has a new `ruleVerdicts` field.
- **Reasons in the HTML report agree with the verdict.** Some checks record a reason that states an
  outcome even when their verdict is INCONCLUSIVE (S23, where the final ledger is withheld, reads
  "Task completed or …"). The report now shows a reason built from the record, with the recorded
  text beside it. Stored results are not changed: the recorded text is part of each run's hash.
- **The rule map is checked against the public catalogue.** A test now checks that every scenario
  a rule names exists in `fixtures/local-finance-v1/scenarios.json`, apart from the component
  scenarios S29 to S36, which are listed explicitly.
- **Exit code 1 is described correctly.** It means the overall verdict is FAIL, which a failed
  control or an unfinished task can cause, not only a failed money rule.
- Documentation: the README and FAQ now state what is free in this repository and what EmberTail's
  paid work adds, say plainly that the licence is source-available rather than open source, and
  explain why scenarios S29 to S36 are not in the catalogue. Component tests and release-by-release
  re-checks are no longer listed on this repository's roadmap.

## 0.1.0 (2026-10-24)

First public release of EmberTail Money Check.

- `embertail check`: run an agent against payment scenarios on a deterministic simulated ledger and
  grade it against 14 money rules.
- 57 agent scenarios in 12 families; packs `core` (9), `incidents` (core + 4) and `full`.
- Outputs: summary, JUnit, SARIF 2.1.0, badge and JSON; offline replay and verification.
- GitHub Action for pull requests.
- Adapter helpers for TypeScript and Python (Apache-2.0); example agents, including three
  deliberately failing baselines.
- Case studies, findings record and errata.
