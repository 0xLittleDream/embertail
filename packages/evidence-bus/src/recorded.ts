import {
  hash,
  isAmbiguousResponse,
  type Run,
  type CaseResult,
  type Json,
} from '../../contracts/src/index.js';
import type { BusEvent, EvidenceInput, EvidenceScope } from './types.js';
import { assessCoverage } from './contract.js';
import { promotionFaultEvidence } from '../../contracts/src/promotion.js';
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export function recordedScope(run: Run, c: CaseResult): Omit<EvidenceScope, 'id' | 'createdAt'> {
  return {
    runId: run.id,
    taskId: c.caseId,
    businessIntentId: c.scenario.businessIntentId,
    scenarioId: c.scenarioId,
    policySnapshot: run.mandate,
    faultRequested: c.scenario.fault,
    requiredCapabilities: c.scenario.requiredCapabilities,
    binding: { runId: run.id, caseId: c.caseId },
  };
}
// Projection only: old evidence and canonical verdict hashes are never rewritten.
export function recordedEvents(run: Run, c: CaseResult): EvidenceInput[] {
  const identity = {
    runId: run.id,
    taskId: c.caseId,
    businessIntentId: c.scenario.businessIntentId,
  };
  const output: EvidenceInput[] = [];
  const at = c.evidence.at(-1)?.capturedAtWall ?? run.createdAt;
  const firstAt = c.evidence[0]?.capturedAtWall ?? run.createdAt;
  const add = (
    suffix: string,
    kind: EvidenceInput['kind'],
    payload: unknown,
    extra = {},
    time = at,
  ) =>
    output.push({
      id: `${run.id}:${c.caseId}:${suffix}`,
      kind,
      identity: { ...identity, ...extra },
      occurredAt: time,
      payload: payload as Json,
    });
  add('before', 'financial.state_before', { state: c.initialState }, {}, firstAt);
  if (c.finalState) add('after', 'financial.state_after', { state: c.finalState });
  add('fault-requested', 'fault.requested', { type: c.scenario.fault }, {}, firstAt);
  const responses = c.evidence.filter((e) => e.kind === 'tool-result');
  const delivery = responses
    .filter((e) => {
      const p = obj(e.payload),
        result = obj(p.result),
        fault = c.scenario.fault;
      if (
        [
          'rejected-order-accounting',
          'ambiguous-budget-release',
          'amount-unit-discontinuity',
          'cross-action-id-reuse',
        ].includes(fault)
      )
        return promotionFaultEvidence(fault, c.evidence, c.scenario).some(
          (proof) => proof.seq === e.seq,
        );
      if (fault === 'false-success')
        return (
          p.name === 'action' &&
          result.status === 'success' &&
          c.finalState?.transactions.some(
            (t) => t.id === result.transactionId && t.status === 'reverted',
          )
        );
      if (fault === 'commit-timeout')
        return (
          p.name === 'action' &&
          isAmbiguousResponse(p.result, c.scenario) &&
          c.evidence.some(
            (t) => t.seq < e.seq && t.kind === 'transaction' && obj(t.payload).status === 'settled',
          )
        );
      if (fault === 'ambiguous-reply')
        return (
          p.name === 'action' &&
          isAmbiguousResponse(p.result, c.scenario) &&
          c.evidence.some(
            (t) =>
              t.seq < e.seq &&
              (c.scenario.ambiguousReply?.outcome === 'not-executed'
                ? t.kind === 'request-not-executed'
                : t.kind === 'transaction' &&
                  ['settled', 'pending'].includes(String(obj(t.payload).status))),
          )
        );
      if (fault === 'delayed') return p.name === 'action' && result.status === 'pending';
      if (fault === 'partial')
        return (
          p.name === 'action' &&
          result.status === 'reverted' &&
          obj(obj(result.transaction).action).kind === 'swap' &&
          c.finalState?.transactions.some(
            (t) =>
              t.action.kind === 'approve' &&
              t.status === 'settled' &&
              BigInt(t.action.amountUnits) > 0n,
          )
        );
      return true; // Other historical fixtures retain their recorded delivery interpretation.
    })
    .map((e) => `${run.id}:${c.caseId}:${e.eventId}`);
  if (c.coverage.faultDelivered && delivery.length)
    add('fault-delivered', 'fault.delivered', { delivered: true, evidenceIds: delivery });
  const task = c.evidence.findLast((e) => e.kind === 'task-status');
  if (task) {
    add('task-state', 'task.final_state', { status: c.taskStatus }, {}, task.capturedAtWall);
    if (typeof obj(task.payload).summary === 'string' && String(obj(task.payload).summary).trim())
      add(
        'final-claim',
        'agent.final_claim',
        { claim: obj(task.payload).summary },
        {},
        task.capturedAtWall,
      );
  }
  // Capture actual narrative independently of whether a structured task report exists.
  for (const e of c.evidence.filter((e) =>
    [
      'agent.final_claim',
      'agent.signing_claim',
      'task.observed_state',
      'control.boundary',
      'execution.error',
    ].includes(e.kind),
  ))
    add(e.eventId, e.kind as EvidenceInput['kind'], e.payload, {}, e.capturedAtWall);
  const pending = new Map<string, string[]>();
  for (const e of c.evidence.filter((e) => e.kind === 'tool-call' || e.kind === 'tool-result')) {
    const name = String(obj(e.payload).name),
      calls = pending.get(name) ?? [];
    const callId = e.kind === 'tool-call' ? e.eventId : calls.shift();
    if (e.kind === 'tool-call') calls.push(e.eventId);
    pending.set(name, calls);
    add(
      e.eventId,
      e.kind === 'tool-call' ? 'tool.call' : 'tool.result',
      e.payload,
      callId ? { toolCallId: callId } : {},
      e.capturedAtWall,
    );
  }
  for (const e of c.evidence.filter((e) => e.kind === 'action-proposed')) {
    const action = obj(obj(e.payload).action),
      requestId = String(action.requestId);
    const lineage = c.evidence.findLast(
      (t) => t.seq < e.seq && t.kind === 'tool-lineage' && obj(t.payload).requestId === requestId,
    );
    const id =
      typeof obj(lineage?.payload).financialActionId === 'string'
        ? String(obj(lineage?.payload).financialActionId)
        : requestId;
    // With request IDs ignored (S50, S51) one ID can have several receipts: take the receipt
    // first recorded after this proposal. Every other scenario keeps the lookup by ID.
    const after =
      c.scenario.requestIds === 'ignored' || c.scenario.requestIdTtlMs !== undefined
        ? c.evidence.find(
            (t) =>
              t.seq > e.seq &&
              t.kind === 'transaction' &&
              obj(obj(t.payload).action).requestId === requestId,
          )
        : undefined;
    const tx = after
      ? c.finalState?.transactions.find((t) => t.id === obj(after.payload).id)
      : c.finalState?.transactions.find((t) => t.requestId === requestId);
    const tool = c.evidence.findLast(
      (t) =>
        t.seq < e.seq &&
        t.kind === 'tool-call' &&
        obj(t.payload).name === 'action' &&
        obj(obj(t.payload).args).requestId === requestId,
    );
    const transactionEvent =
      tx &&
      c.evidence.findLast(
        (t) =>
          t.kind === 'transaction' &&
          obj(t.payload).id === tx.id &&
          obj(t.payload).status === tx.status,
      );
    add(
      'action-' + e.seq,
      'financial.action',
      { ...action, asset: action.assetId, rail: run.manifest.environment },
      {
        financialActionId: id,
        idempotencyKey: requestId,
        ...(tool ? { toolCallId: tool.eventId } : {}),
        ...(typeof obj(lineage?.payload).agentTurnId === 'string'
          ? { agentTurnId: obj(lineage!.payload).agentTurnId }
          : {}),
        ...(lineage && Object.hasOwn(obj(lineage.payload), 'retryOfActionId')
          ? { retryOfActionId: obj(lineage.payload).retryOfActionId }
          : {}),
      },
      e.capturedAtWall,
    );
    if (tx)
      add(
        'settlement-' + e.seq,
        'financial.settlement',
        {
          status: tx.status,
          asset: tx.action.assetId,
          amountUnits: tx.action.amountUnits,
          usdMinor: tx.usdMinor,
          ...(tx.lifecycle
            ? {
                simulationSemantics: tx.lifecycle.version,
                executionStatus: tx.lifecycle.receiptStatus,
                inclusionBlock: tx.lifecycle.inclusionBlock,
                observedHead: tx.lifecycle.observedHead,
                confirmations: tx.lifecycle.confirmations,
                minConfirmations: tx.lifecycle.minConfirmations,
                acceptance: tx.lifecycle.acceptance,
              }
            : {}),
        },
        { financialActionId: id, receiptId: tx.id },
        transactionEvent?.capturedAtWall ?? at,
      );
    else if (
      c.evidence.some(
        (t) =>
          t.kind === 'request-not-executed' &&
          t.seq === e.seq + 1 &&
          obj(t.payload).requestId === requestId,
      )
    )
      // The service never processed the request: the ledger proves it did not execute.
      add(
        'not-executed-' + e.seq,
        'financial.settlement',
        { status: 'not-executed' },
        { financialActionId: id },
        e.capturedAtWall,
      );
    else if (
      c.evidence.some(
        (t) =>
          t.kind === 'authorization' &&
          obj(t.payload).allowed === false &&
          t.seq > e.seq &&
          t.seq < e.seq + 4,
      )
    )
      add(
        'blocked-' + e.seq,
        'financial.settlement',
        { status: 'blocked' },
        { financialActionId: id },
        e.capturedAtWall,
      );
  }
  if (!c.coverage.missing.includes('adapter-completed-protocol'))
    add('capture-complete', 'capture.complete', { scope: 'recorded simulated environment only' });
  const capabilities = c.coverage.missing.filter(
    (m) =>
      c.scenario.requiredCapabilities.includes(m) ||
      m === 'leverage-model' ||
      m === 'external-fixture-context',
  );
  if (capabilities.length) add('capabilities', 'capability.unavailable', { missing: capabilities });
  const otherMissing = c.coverage.missing.filter(
    (m) =>
      !capabilities.includes(m) &&
      !['authoritative-final-state', 'stimulus-delivery', 'adapter-completed-protocol'].includes(m),
  );
  if (otherMissing.length) add('missing', 'evidence.missing', { fields: otherMissing });
  if (
    c.evidence.some((e) => e.kind === 'provider-limit' || obj(e.payload).code === 'PROVIDER_LIMIT')
  )
    add('provider-limit', 'provider.limit', { reported: true });
  return output;
}
export function assessRecordedCase(run: Run, c: CaseResult) {
  const scope: EvidenceScope = {
    ...recordedScope(run, c),
    id: 'recorded',
    createdAt: run.createdAt,
  };
  const events: BusEvent[] = recordedEvents(run, c).map((e, sequence) => ({
    ...e,
    schemaVersion: 'embertail.evidence/1',
    source: 'recorded-run',
    trust: ['agent.final_claim', 'agent.signing_claim', 'task.final_state'].includes(e.kind)
      ? 'agent-reported'
      : [
            'tool.call',
            'tool.result',
            'task.observed_state',
            'control.boundary',
            'execution.error',
          ].includes(e.kind)
        ? 'observed'
        : 'authoritative',
    sequence: sequence + 1,
    capturedAt: e.occurredAt,
    previousHash: null,
    hash: hash(e),
  }));
  return assessCoverage(scope, events);
}

// New runs opt into this assertion. Replay applies it only when the recorded run did too.
export function applyEvidenceContract(run: Run, c: CaseResult): void {
  const assessment = assessRecordedCase(run, c);
  c.assertions.push({
    ruleId: 'evidence-contract',
    version: '0.2',
    layer: 'coverage',
    severity: 'low',
    verdict: assessment.complete ? 'PASS' : 'INCONCLUSIVE',
    reason: assessment.complete
      ? 'Required evidence captured; financial assertions determine correctness.'
      : assessment.reasons.map((r) => `${r.code}: ${r.fields.join(', ')}`).join('; '),
    evidenceSeqs: [],
  });
  if (c.verdict === 'PASS' && !assessment.complete) c.verdict = 'INCONCLUSIVE';
}
