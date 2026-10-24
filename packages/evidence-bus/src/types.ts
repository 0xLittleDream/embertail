import type { Json, Mandate } from '../../contracts/src/index.js';
import type { NativePolicy } from '../../contracts/src/native.js';
export const REASON_CODES = [
  'INCONCLUSIVE.EVIDENCE_MISSING',
  'INCONCLUSIVE.FAULT_NOT_DELIVERED',
  'INCONCLUSIVE.CAPABILITY_UNAVAILABLE',
  'INCONCLUSIVE.AUTHORITATIVE_STATE_UNAVAILABLE',
  'INCONCLUSIVE.PROVIDER_LIMIT',
  'INCONCLUSIVE.REAL_UNCERTAINTY',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export type CoverageReason = {
  code: ReasonCode;
  fields: string[];
  detail: string;
  category: 'instrumentation' | 'world' | 'unknown';
};
export type EvidenceIdentity = {
  runId: string;
  taskId: string;
  businessIntentId: string;
  agentTurnId?: string;
  toolCallId?: string;
  financialActionId?: string;
  retryOfActionId?: string | null;
  idempotencyKey?: string;
  transactionHash?: string;
  receiptId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  chainId?: string;
};
export const KINDS = [
  'agent.span',
  'agent.final_claim',
  'agent.signing_claim',
  'task.final_state',
  'task.observed_state',
  'control.boundary',
  'execution.error',
  'tool.call',
  'tool.result',
  'financial.action',
  'financial.settlement',
  'financial.state_before',
  'financial.state_after',
  'fault.requested',
  'fault.delivered',
  'capability.unavailable',
  'provider.limit',
  'capture.complete',
  'evidence.missing',
  'intent.binding',
  'verification.snapshot',
  'verification.action',
] as const;
export type EvidenceInput = {
  id: string;
  kind: (typeof KINDS)[number];
  identity: EvidenceIdentity;
  occurredAt: string;
  payload: Json;
};
export type BusEvent = EvidenceInput & {
  schemaVersion: 'embertail.evidence/1';
  source: 'otlp' | 'mcp' | 'native' | 'subprocess' | 'sandbox' | 'recorded-run' | 'verifier';
  trust: 'observed' | 'agent-reported' | 'authoritative';
  sequence: number;
  capturedAt: string;
  previousHash: string | null;
  hash: string;
};
export type EvidenceScope = {
  id: string;
  runId: string;
  taskId: string;
  businessIntentId: string;
  scenarioId: string;
  faultRequested: string;
  policySnapshot:
    | Mandate
    | NativePolicy
    | { schemaVersion: 'embertail.verification-policy/1'; purpose: 'independent-facts-only' };
  requiredCapabilities: string[];
  binding?: { runId: string; caseId: string; study?: string };
  createdAt: string;
};
export type CoverageAssessment = {
  contractVersion: 'embertail.coverage/1';
  complete: boolean;
  missing: string[];
  reasons: CoverageReason[];
  requirements: { field: string; satisfied: boolean; evidenceIds: string[] }[];
  actionCount: number;
  note: string;
};
