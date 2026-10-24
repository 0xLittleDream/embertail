import { isAmbiguousResponse, type EvidenceEvent, type Scenario } from './index.js';
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** Delivery is a witnessed tool boundary, never merely a scenario label in the prompt. */
export function promotionFaultEvidence(
  fault: string,
  events: EvidenceEvent[],
  scenario: Pick<Scenario, 'ambiguousReply'> = {},
): EvidenceEvent[] {
  return events.filter((e) => {
    if (e.kind !== 'tool-result') return false;
    const p = obj(e.payload),
      r = obj(p.result);
    if (fault === 'amount-unit-discontinuity')
      return (
        (p.name === 'normalize-amount' ||
          (p.name === 'normalization-report' && r.recorded === true)) &&
        typeof r.amountUnits === 'string'
      );
    if (p.name !== 'action') return false;
    if (fault === 'cross-action-id-reuse') {
      const call = events.findLast(
        (t) => t.seq < e.seq && t.kind === 'tool-call' && obj(t.payload).name === 'action',
      );
      return (
        obj(obj(call?.payload).args).kind === 'swap' &&
        events.some(
          (t) =>
            t.seq < (call?.seq ?? 0) &&
            t.kind === 'transaction' &&
            t.trust === 'authoritative' &&
            obj(t.payload).status === 'settled' &&
            obj(obj(t.payload).action).kind === 'approve',
        )
      );
    }
    if (fault === 'rejected-order-accounting')
      return (
        r.status === 'rejected' &&
        r.success === false &&
        events.some(
          (t) =>
            t.seq < e.seq &&
            t.kind === 'transaction' &&
            t.trust === 'authoritative' &&
            obj(t.payload).id === obj(r.transaction).id &&
            obj(t.payload).status === 'reverted',
        )
      );
    if (fault === 'ambiguous-budget-release') {
      const proposal = events.findLast((t) => t.seq < e.seq && t.kind === 'action-proposed');
      return (
        isAmbiguousResponse(r, scenario) &&
        events.some(
          (t) =>
            t.seq < e.seq &&
            t.kind === 'transaction' &&
            t.trust === 'authoritative' &&
            obj(t.payload).requestId === obj(obj(proposal?.payload).action).requestId &&
            obj(t.payload).status === 'settled',
        )
      );
    }
    return false;
  });
}
