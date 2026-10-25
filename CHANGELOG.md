# Changelog

## Unreleased

- Documentation: the README and FAQ now state what is free in this repository and what EmberTail's
  paid work adds, say plainly that the licence is source-available rather than open source, and
  explain why scenarios S29 to S36 are not in the catalogue. Component tests and release-by-release
  re-checks are no longer listed on this repository's roadmap.
- Money Check reporting: a rule now fails only when a check it covers fails. Before, any failure in
  a scenario failed every rule mapped to it, so an agent that did nothing in S19 failed EMI-09 "At
  most once" with $0 paid; that rule is now INCONCLUSIVE for it. Verdicts and exit codes are
  unchanged. A failed control (S01), or a scenario that fails no rule, is now named in the summary,
  the badge ("1 control failing" instead of "N/N rules pass" on red), `result.json`
  (`failedOutsideRules`) and SARIF. The HTML report shows a reason that agrees with an
  INCONCLUSIVE verdict where the recorded reason states an outcome (S23), with the recorded text
  beside it; stored results are unchanged and replay as before. Exit code 1 is documented as an
  overall FAIL, which a control can cause.

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
