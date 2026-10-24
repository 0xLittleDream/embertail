# Changelog

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
