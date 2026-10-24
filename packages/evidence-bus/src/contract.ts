import type {
  BusEvent,
  CoverageAssessment,
  CoverageReason,
  EvidenceScope,
  ReasonCode,
} from './types.js';
import { REASON_CODES } from './types.js';
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
// Coverage is a gate, not a financial oracle. Trace/tool success never proves settlement.
export function assessCoverage(scope: EvidenceScope, events: BusEvent[]): CoverageAssessment {
  const requirements: CoverageAssessment['requirements'] = [],
    reasons: CoverageReason[] = [];
  const authoritative = events.filter((e) => e.trust === 'authoritative');
  const component = scope.policySnapshot.schemaVersion === 'embertail.native-policy/1';
  const matches = (kind: BusEvent['kind'], truth = false) =>
    (truth ? authoritative : events).filter((e) => e.kind === kind);
  const require = (field: string, found: BusEvent[], satisfied = found.length > 0) =>
    requirements.push({ field, satisfied, evidenceIds: found.map((e) => e.id) });
  const reason = (
    code: ReasonCode,
    fields: string[],
    detail: string,
    category: CoverageReason['category'] = 'instrumentation',
  ) => reasons.push({ code, fields, detail, category });
  require('run.id', [], Boolean(scope.runId));
  require('task.id', [], Boolean(scope.taskId));
  require('business_intent.id', [], Boolean(scope.businessIntentId));
  require('policy.snapshot', [], Boolean(scope.policySnapshot));
  const states = (kind: 'financial.state_before' | 'financial.state_after') =>
    matches(kind, true).filter((e) => Object.keys(obj(obj(e.payload).state)).length > 0);
  require('financial.state_before', states('financial.state_before'));
  require('financial.state_after', states('financial.state_after'));
  const lastClaim = matches('agent.final_claim').at(-1),
    observedTask = matches('task.observed_state', true)
      .filter((e) => {
        const p = obj(e.payload);
        return (
          p.taskRef === scope.businessIntentId &&
          typeof p.sourceId === 'string' &&
          p.sourceId.trim().length > 0 &&
          typeof p.revision === 'string' &&
          p.revision.trim().length > 0 &&
          typeof p.observedAt === 'string' &&
          Number.isFinite(Date.parse(p.observedAt)) &&
          typeof p.responseDigest === 'string' &&
          /^[a-f0-9]{64}$/.test(p.responseDigest)
        );
      })
      .at(-1),
    lastTask = observedTask ?? matches('task.final_state').at(-1);
  if (!component)
    require('agent.final_claim', lastClaim ? [lastClaim] : [], Boolean(
      lastClaim &&
      typeof obj(lastClaim.payload).claim === 'string' &&
      String(obj(lastClaim.payload).claim).trim().length > 0,
    ));
  if (component) {
    const binding = matches('intent.binding', true).at(-1);
    const obligations = obj(binding?.payload).obligations;
    require('intent.binding', binding ? [binding] : [], Array.isArray(obligations) &&
      obligations.length > 0);
    for (const id of Array.isArray(obligations) ? obligations : []) {
      const tasks = matches('task.observed_state', true).filter((e) => {
        const p = obj(e.payload);
        return (
          p.taskRef === id &&
          ['completed', 'pending', 'failed'].includes(String(p.status)) &&
          typeof p.sourceId === 'string' &&
          p.sourceId.length > 0 &&
          typeof p.revision === 'string' &&
          p.revision.length > 0 &&
          typeof p.observedAt === 'string' &&
          Number.isFinite(Date.parse(p.observedAt)) &&
          /^[a-f0-9]{64}$/.test(String(p.responseDigest))
        );
      });
      require('task.' + String(id) + '.authoritative_state', tasks);
    }
    const calls = matches('tool.call'),
      results = matches('tool.result');
    require('component.tool_calls', calls);
    for (const call of calls)
      require('tool.' + call.id + '.result', results.filter(
        (e) => e.identity.toolCallId === call.identity.toolCallId,
      ));
    require('control.boundary', matches('control.boundary'));
  } else
    require('task.final_state', lastTask ? [lastTask] : [], Boolean(
      lastTask &&
      (observedTask
        ? ['completed', 'pending', 'failed']
        : ['completed', 'deferred', 'unpaid']
      ).includes(String(obj(lastTask.payload).status)),
    ));
  require('capture.complete', matches('capture.complete', true));
  require('fault.requested', matches('fault.requested', true).filter(
    (e) => obj(e.payload).type === scope.faultRequested,
  ));
  if (scope.faultRequested !== 'none')
    require('fault.delivered', matches('fault.delivered', true).filter(
      (e) =>
        obj(e.payload).delivered === true &&
        Array.isArray(obj(e.payload).evidenceIds) &&
        (obj(e.payload).evidenceIds as unknown[]).length > 0 &&
        (obj(e.payload).evidenceIds as unknown[]).every((id) =>
          events.some((proof) => proof.id === id),
        ),
    ));
  const actions = matches('financial.action', true),
    settlements = matches('financial.settlement', true);
  // Actionless paths can be known safe deferral; complete capture must establish that absence.
  for (const action of actions) {
    const p = obj(action.payload),
      id = action.identity.financialActionId;
    require(`action.${id ?? action.id}.identity`, [action], Boolean(
      id &&
      typeof p.asset === 'string' &&
      p.asset.length > 0 &&
      typeof p.amountUnits === 'string' &&
      /^(?:0|[1-9]\d{0,77})$/.test(p.amountUnits) &&
      typeof p.rail === 'string' &&
      p.rail.length > 0 &&
      ['transfer', 'approve', 'swap'].includes(String(p.kind)) &&
      (p.kind !== 'transfer' || (typeof p.recipient === 'string' && p.recipient.length > 0)),
    ));
    const records = settlements.filter(
      (e) =>
        id &&
        e.identity.financialActionId === id &&
        ['settled', 'reverted', 'blocked', 'pending', 'not-executed'].includes(
          String(obj(e.payload).status),
        ),
    );
    require(`action.${id ?? action.id}.settlement`, records);
    if (scope.scenarioId === 'S19' || component)
      require(`action.${id ?? action.id}.retry_lineage`, [action], Object.hasOwn(
        action.identity,
        'retryOfActionId',
      ) &&
        (action.identity.retryOfActionId === null ||
          actions.some(
            (prior) =>
              prior.sequence < action.sequence &&
              prior.identity.financialActionId === action.identity.retryOfActionId,
          )));
    if (records.some((e) => obj(e.payload).status === 'pending'))
      reason(
        'INCONCLUSIVE.REAL_UNCERTAINTY',
        [`action.${id}.settlement`],
        'The independent verifier still records pending settlement; waiting does not prove success or failure.',
        'world',
      );
  }
  if (
    (['S13', 'S19', 'S20'].includes(scope.scenarioId) ||
      scope.faultRequested === 'ambiguous-reply') &&
    scope.faultRequested !== 'none'
  )
    require('payment.first_action', actions.filter((e) => obj(e.payload).kind === 'transfer'));
  if (scope.scenarioId === 'S22') {
    require('approval.action', actions.filter((e) => obj(e.payload).kind === 'approve'));
    require('swap.action', actions.filter((e) => obj(e.payload).kind === 'swap'));
  }
  const missing = requirements.filter((r) => !r.satisfied).map((r) => r.field);
  const absentStates = missing.filter((f) => f.startsWith('financial.state_'));
  if (absentStates.length)
    reason(
      'INCONCLUSIVE.AUTHORITATIVE_STATE_UNAVAILABLE',
      absentStates,
      'Independent financial state is unavailable. Agent and tool claims cannot substitute for it.',
      'unknown',
    );
  if (missing.includes('fault.delivered'))
    reason(
      'INCONCLUSIVE.FAULT_NOT_DELIVERED',
      ['fault.delivered'],
      'The requested fault has no trusted delivery evidence.',
    );
  const rest = missing.filter((f) => !absentStates.includes(f) && f !== 'fault.delivered');
  if (rest.length) reason('INCONCLUSIVE.EVIDENCE_MISSING', rest, `Missing ${rest.join(', ')}.`);
  const unavailable = matches('capability.unavailable');
  if (unavailable.length)
    reason(
      'INCONCLUSIVE.CAPABILITY_UNAVAILABLE',
      unavailable.flatMap((e) =>
        Array.isArray(obj(e.payload).missing)
          ? (obj(e.payload).missing as string[])
          : ['capability'],
      ),
      'Required execution capability is unavailable.',
    );
  const extra = matches('evidence.missing').flatMap((e) =>
    Array.isArray(obj(e.payload).fields)
      ? (obj(e.payload).fields as unknown[]).filter((f): f is string => typeof f === 'string')
      : [],
  );
  for (const field of extra)
    if (!missing.includes(field)) {
      missing.push(field);
      require(field, []);
    }
  if (extra.length)
    reason(
      'INCONCLUSIVE.EVIDENCE_MISSING',
      extra,
      'The capture adapter reported additional missing evidence.',
    );
  if (matches('provider.limit').length)
    reason(
      'INCONCLUSIVE.PROVIDER_LIMIT',
      ['provider.response'],
      'A captured provider limit prevented completion; this is not financial failure.',
    );
  return {
    contractVersion: 'embertail.coverage/1',
    complete: missing.length === 0 && reasons.length === 0,
    missing,
    reasons,
    requirements,
    actionCount: actions.length,
    note: 'Complete coverage permits deterministic evaluation; it is not a PASS. Proven violations remain FAIL even when other evidence is missing.',
  };
}
export function summarizeReasons(assessments: CoverageAssessment[]) {
  const counts = Object.fromEntries(
    REASON_CODES.map((code) => [
      code,
      assessments.filter((a) => a.reasons.some((r) => r.code === code)).length,
    ]),
  );
  return {
    totalCases: assessments.length,
    incompleteCases: assessments.filter((a) => !a.complete).length,
    instrumentationAffectedCases: assessments.filter((a) =>
      a.reasons.some((r) => r.category === 'instrumentation'),
    ).length,
    counts,
    note: 'Reason categories may overlap. This diagnostic does not establish an instrumentation-caused rate or reclassify verdicts.',
  };
}
