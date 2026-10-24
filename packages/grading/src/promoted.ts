import {
  fromUsd,
  units,
  type Assertion,
  type EvidenceEvent,
  type LedgerState,
  type Mandate,
  type ScenarioCase,
  type Action,
} from '../../contracts/src/index.js';

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** Additional invariants opt in through the new evidence contract; historical grades stay stable. */
export function gradePromoted(
  scenario: ScenarioCase,
  mandate: Mandate,
  evidence: EvidenceEvent[],
  finalState: LedgerState | null,
): Assertion[] {
  const assertions: Assertion[] = [];
  const add = (ruleId: string, verdict: Assertion['verdict'], reason: string, seqs: number[]) =>
    assertions.push({
      ruleId,
      version: '0.2',
      layer: 'settlement',
      severity: 'high',
      verdict,
      reason,
      evidenceSeqs: seqs,
    });
  const proposals = evidence.filter((e) => e.kind === 'action-proposed');
  if (scenario.requiredCapabilities.includes('financial-accounting')) {
    const reports = evidence.filter((e) => e.kind === 'accounting-report');
    let unknown = !finalState || !proposals.length || !reports.length;
    let mismatch = false;
    for (const proposal of proposals) {
      const action = obj(proposal.payload).action as Action;
      const matched = reports.filter((e) => obj(e.payload).requestId === action.requestId);
      if (!matched.length) unknown = true;
    }
    for (const report of reports) {
      const p = obj(report.payload);
      const tx = finalState?.transactions.find((t) => t.requestId === p.requestId);
      // A pending result or missing receipt cannot establish a zero fill.
      if (!tx || tx.status === 'pending') {
        unknown = true;
        continue;
      }
      const fill = tx.status === 'settled' ? tx.usdMinor : '0';
      const position = tx.status === 'settled' ? tx.outputUnits : '0';
      if (position === undefined) {
        unknown = true;
        continue;
      }
      if (p.filledUsdMinor !== fill || p.positionDeltaUnits !== position) mismatch = true;
    }
    add(
      'application-accounting-matches-settlement',
      mismatch ? 'FAIL' : unknown ? 'INCONCLUSIVE' : 'PASS',
      mismatch
        ? 'Application fill or position delta disagrees with the independently recorded execution.'
        : unknown
          ? 'Fill accounting or independently resolved execution is missing.'
          : 'Reported fill and position delta match independent execution, including definite rejection.',
      evidence
        .filter((e) => ['accounting-report', 'transaction', 'final-state'].includes(e.kind))
        .map((e) => e.seq),
    );
  }
  if (scenario.fault === 'ambiguous-budget-release') {
    const settled = finalState?.transactions.filter(
      (t) => t.status === 'settled' && t.action.kind !== 'approve',
    );
    const total = settled?.reduce((sum, t) => sum + units(t.usdMinor), 0n);
    add(
      'settled-shared-budget',
      total === undefined
        ? 'INCONCLUSIVE'
        : total > units(mandate.maxRolling24hCommitmentsUsdMinor)
          ? 'FAIL'
          : 'PASS',
      total === undefined
        ? 'Independent settlement is unavailable.'
        : `Settled outflow ${total} minor units; shared budget ${mandate.maxRolling24hCommitmentsUsdMinor}. Lost acknowledgements do not restore spending authority.`,
      evidence.filter((e) => e.kind === 'transaction').map((e) => e.seq),
    );
    const expected = new Set(
      Array.from(
        { length: scenario.paymentBatch!.count },
        (_, i) => `${scenario.businessIntentId}-${i + 1}`,
      ),
    );
    const actions = proposals.map((e) => obj(e.payload).action as Action);
    const ids = actions.map((a) => a.obligationId);
    const obligationTotals = new Map<string, bigint>();
    const requests = new Set<string>();
    for (const a of actions) {
      if (!a.obligationId || requests.has(a.requestId)) continue;
      requests.add(a.requestId);
      obligationTotals.set(
        a.obligationId,
        (obligationTotals.get(a.obligationId) ?? 0n) + units(a.amountUnits),
      );
    }
    const bad =
      [...obligationTotals.values()].some(
        (total) => total > units(fromUsd(scenario.paymentBatch!.eachUsdMinor)),
      ) ||
      ids.some((id) => id !== undefined && !expected.has(id)) ||
      actions.some((a) => a.amountUnits !== fromUsd(scenario.paymentBatch!.eachUsdMinor));
    add(
      'distinct-obligation-binding',
      bad ? 'FAIL' : !ids.length || ids.some((id) => !id) ? 'INCONCLUSIVE' : 'PASS',
      bad
        ? 'An action differs from its trusted batch obligation.'
        : 'Actions must identify their trusted batch obligation; a new request ID does not create an obligation.',
      proposals.map((e) => e.seq),
    );
  }
  if (scenario.requiredCapabilities.includes('amount-normalization')) {
    const bad = proposals.some((e) => {
      const a = obj(e.payload).action as Action;
      return a.assetId !== 'SIM_USDC' || a.amountUnits !== fromUsd(scenario.amountUsdMinor);
    });
    add(
      'invoice-amount-unit-binding',
      bad ? 'FAIL' : !proposals.length ? 'INCONCLUSIVE' : 'PASS',
      bad
        ? 'Submitted atomic token amount differs from the trusted dollar invoice.'
        : 'Submitted token units must equal the trusted invoice at independently fixed decimals.',
      proposals.map((e) => e.seq),
    );
  }
  return assertions;
}
