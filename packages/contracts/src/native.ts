import type { Assertion, Json, Verdict } from './index.js';
import type { BusEvent, CoverageAssessment, EvidenceScope } from '../../evidence-bus/src/types.js';

/** Native runs deliberately have no synthetic ledger or cent-denominated mandate. */
export type NativeScenario = {
  caseId: string;
  scenarioId: string;
  title: string;
  sourceScenario: string;
  family: string;
  evaluation: 'regression' | 'characterization';
  configuration: {
    id: string;
    target: 'clawrouter' | 'x402';
    mode: 'proxy' | 'sdk' | 'preauth';
    scenario: string;
    count: number;
    cap?: number;
    concurrent?: boolean;
    walletCap?: boolean;
    fault?: string;
    faultAt?: number;
    substitute?: string;
    replay?: boolean;
    sameObligation?: boolean;
    sdkPolicy?: string;
  };
};
export type NativePolicy = {
  schemaVersion: 'embertail.native-policy/1';
  scope: 'financial-component';
  scenarioId: string;
  caseId: string;
  evaluation: NativeScenario['evaluation'];
  rule:
    | 'native-cap'
    | 'quote-authority'
    | 'authorization-replay'
    | 'no-implicit-retry'
    | 'normal-payment'
    | 'application-retry';
  capUnits: string | null;
  decimals: 6;
  assetLabel: 'Local USD fixture token';
  enforcement: 'strict-run-cap' | 'wallet-session-cap' | 'sdk-spend-controls' | 'native-runtime';
};
export type NativeFacts = {
  settledUnits: string;
  /** Financial findings in the settlement evidence (wrong payee or amount, reused
   * authorization, third-party movement). Absent when there are none. */
  violations?: string[];
  transactions: {
    hash: string;
    obligationId: string;
    amountUnits: string;
    retryOf: string | null;
  }[];
  attemptedCalls: number;
  obligationCalls: Record<string, number>;
  normalPaymentQualified: boolean;
  faultRequested: string;
  faultDelivered: boolean;
  authoritativeOutcomeKnown: boolean;
  taskStates: {
    taskRef: string;
    status: 'completed' | 'pending' | 'failed' | 'unknown';
    sourceId: string;
    revision: string | null;
    observedAt: string;
    responseDigest: string | null;
  }[];
  responses: { status: number | null; error: string | null }[];
  guardDenialObserved: boolean;
  replayDenied: boolean | null;
  rejectedQuoteBeforeSigning: boolean | null;
  missing: string[];
};
export type NativeCaseResult = {
  caseId: string;
  scenarioId: string;
  title: string;
  family: string;
  scenario: NativeScenario;
  policy: NativePolicy;
  facts: NativeFacts;
  verdict: Verdict | null;
  evaluation: NativeScenario['evaluation'];
  assertions: Assertion[];
  coverage: CoverageAssessment;
  targetSafetyProperty: 'EXERCISED' | 'NOT_EXERCISED' | 'UNKNOWN' | 'NOT_APPLICABLE';
  observedFinancialHarm: 'NONE_OBSERVED' | 'POLICY_OVERRUN' | 'NOT_ESTABLISHED';
  excessUnits: string | null;
  taskCorrectness: 'COMPLETED' | 'INCOMPLETE' | 'UNKNOWN';
  responseOutcome: 'COMPLETE' | 'INCOMPLETE';
  explanation: string;
  evidenceScope: EvidenceScope;
  evidence: BusEvent[];
  evidenceHash: string;
  canonicalResultHash: string;
};
export type NativePacket = { evidence: Json; artifact: Json; sourceManifest: Json };
export type NativeRun = {
  schemaVersion: 'embertail.native-run/1';
  runtime: 'native-component';
  id: string;
  status: 'running' | 'complete' | 'error' | 'cancelled';
  createdAt: string;
  completedAt?: string;
  error?: string;
  pack: string;
  targetRuntime: 'head' | 'release';
  provenance: 'live-execution' | 'retained-evidence-regrade';
  verdict: Verdict;
  agentVerdict: null;
  manifest: {
    financialTruth: 'LOCAL EVM' | 'PUBLIC TESTNET';
    network: string;
    chainId: '8453' | '84532';
    scope: 'financial-component';
    agentDecisionLoop: false;
    catalogHash: string;
    policyHash: string;
    packetHash: string | null;
    runtimeHash: string;
    graderHash: string;
    verifierHash: string;
    contractsHash: string;
    targetVersions: Record<string, string>;
    limitations: string[];
    sourcePacket: string;
    sourceFiles: number;
    sourceManifestHash: string | null;
  };
  manifestHash: string;
  cases: NativeCaseResult[];
  packet: NativePacket | null;
};
