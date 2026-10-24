import type { BusEvent } from '../../evidence-bus/src/types.js';
import type { VerificationSnapshot } from './types.js';
export function correlate(
  snapshot: Omit<VerificationSnapshot, 'correlation'>,
): VerificationSnapshot['correlation'] {
  const { plan, settlements, balances, allowances, businessTask } = snapshot;
  const reasons: string[] = [];
  const unresolvedActions = settlements
    .filter(({ result }) => !['success', 'reverted'].includes(result.status))
    .map((row) => row.financialActionId);
  if (unresolvedActions.length)
    reasons.push('Financial actions are pending or independently unknown');
  if (!snapshot.consistency.confirmed)
    reasons.push(
      'Combined chain evidence could not be revalidated against the current canonical/finality view',
    );
  const inWindow = settlements.every(
    ({ result }) =>
      !result.block ||
      (BigInt(result.block.number) > BigInt(plan.beforeBlock) &&
        BigInt(result.block.number) <= BigInt(plan.afterBlock)),
  );
  if (!inWindow) reasons.push('Settlement falls outside the configured before/after state window');
  const unique = new Map(settlements.map((row) => [row.result.transactionHash, row.result]));
  const movements = [...unique.values()]
    .filter((result) => result.status === 'success')
    .flatMap((result) => result.transfers ?? []);
  let financialOutcome: VerificationSnapshot['correlation']['financialOutcome'] =
    plan.obligation.kind === 'workflow' ? 'workflow' : 'unknown';
  let paidUnits: string | null = null,
    matchingTransferCount = 0;
  if (plan.obligation.kind === 'payment') {
    const intent = plan.obligation;
    const matched = movements.filter(
      (log) =>
        log.tokenAddress === intent.tokenAddress &&
        log.from === intent.sender &&
        log.to === intent.recipient,
    );
    const paid = matched.reduce((sum, log) => sum + BigInt(log.amountUnits), 0n);
    paidUnits = paid.toString();
    matchingTransferCount = matched.length;
    // Each chain transaction/log is counted once, even when a tool reports the same hash twice.
    const unsupported = [...unique.values()].some((result) =>
      result.unsupportedTransferTokens.includes(intent.tokenAddress),
    );
    if (unsupported)
      reasons.push('Requested token has an unsupported Transfer format; ERC721 is not ERC20');
    if (!unsupported && paid > BigInt(intent.amountUnits)) financialOutcome = 'overpayment';
    else if (!unsupported && !unresolvedActions.length && inWindow)
      financialOutcome = paid === BigInt(intent.amountUnits) ? 'exact_payment' : 'underpayment';
    if (unresolvedActions.length)
      reasons.push('Paid units are a confirmed lower bound, not the final obligation total');
  }
  if (balances.some((value) => value.status === 'unknown'))
    reasons.push('Required independent token balances unavailable');
  if (allowances.some((value) => value.status === 'unknown'))
    reasons.push('Required independent allowances unavailable');
  if (businessTask.status === 'pending') reasons.push('Customer business task is still pending');
  if (businessTask.status === 'unknown') reasons.push('Customer business task state is unknown');
  const allowanceViolations = allowances.filter(
    (value, i) =>
      value.status === 'known' &&
      BigInt(value.afterUnits!) > BigInt(plan.allowances[i]!.maxAfterUnits),
  ).length;
  return {
    financialOutcome,
    paidUnits,
    distinctSettlements: [...unique.values()].filter((result) => result.status === 'success')
      .length,
    matchingTransferCount,
    duplicateTransactionAliases: settlements.length - unique.size,
    allowanceViolations,
    unresolvedActions,
    complete: reasons.length === 0,
    reasons,
  };
}
export function assessVerification(events: BusEvent[], now = Date.now()) {
  const binding = events.findLast(
    (e) => e.kind === 'intent.binding' && e.trust === 'authoritative' && e.source === 'verifier',
  );
  const latest = events.findLast(
    (e) =>
      e.kind === 'verification.snapshot' && e.trust === 'authoritative' && e.source === 'verifier',
  );
  const planDigest = (binding?.payload as { planDigest?: string } | undefined)?.planDigest;
  const snapshot = latest?.payload as VerificationSnapshot | undefined;
  if (
    !snapshot ||
    snapshot.schemaVersion !== 'embertail.verification/1' ||
    !planDigest ||
    snapshot.planDigest !== planDigest
  )
    return {
      contractVersion: 'embertail.verification/1' as const,
      complete: false,
      status: 'unconfigured' as const,
      reasons: ['No independent verification for the current intent binding'],
      evidenceId: null,
    };
  const reasons = [...snapshot.correlation.reasons];
  const planned = new Set(snapshot.plan.actions.map((action) => action.financialActionId));
  const observedActions = events.filter((event) => event.kind === 'financial.action');
  for (const action of observedActions) {
    const actionId = action.identity.financialActionId;
    const verified = events.findLast(
      (event) =>
        event.kind === 'verification.action' &&
        event.trust === 'authoritative' &&
        event.source === 'verifier' &&
        event.identity.financialActionId === actionId &&
        (event.payload as { planDigest?: string }).planDigest === planDigest,
    );
    if (!actionId || !planned.has(actionId))
      reasons.push('Observed financial action has no registered settlement binding');
    else if (
      (action.identity.transactionHash &&
        action.identity.transactionHash !== verified?.identity.transactionHash) ||
      (action.identity.chainId && action.identity.chainId !== snapshot.plan.chainId)
    )
      reasons.push(
        'Observed action transaction/chain identity conflicts with its independent binding',
      );
  }
  if (!Number.isFinite(Date.parse(snapshot.expiresAt)) || now >= Date.parse(snapshot.expiresAt))
    reasons.push('Independent verification snapshot expired; refresh required');
  const agentTask = events.findLast((e) => e.kind === 'task.final_state');
  const reportedStatus = (agentTask?.payload as { status?: string } | undefined)?.status ?? null;
  return {
    contractVersion: 'embertail.verification/1' as const,
    complete: snapshot.correlation.complete && reasons.length === 0,
    status: reasons.length ? ('inconclusive' as const) : ('verified' as const),
    reasons,
    evidenceId: latest!.id,
    correlation: {
      ...snapshot.correlation,
      ...(reasons.some((reason) => reason.startsWith('Observed')) &&
      ['exact_payment', 'underpayment'].includes(snapshot.correlation.financialOutcome)
        ? { financialOutcome: 'unknown' as const }
        : {}),
    },
    businessTask: snapshot.businessTask,
    agentTaskStatus: reportedStatus,
    taskStateConflict:
      reportedStatus === 'completed' &&
      ['pending', 'failed'].includes(snapshot.businessTask.status),
    note: 'Independent read results relative to configured sources, not a policy PASS. Receipt success is distinct from token movement and customer task completion.',
  };
}
