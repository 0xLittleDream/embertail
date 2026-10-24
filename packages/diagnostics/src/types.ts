import type { Verdict } from '../../contracts/src/index.js';
import type { CoverageAssessment } from '../../evidence-bus/src/types.js';

export type FinancialEnvironmentKind =
  'SIMULATED_LEDGER' | 'LOCAL_EVM' | 'PUBLIC_TESTNET' | 'PRODUCTION' | 'UNKNOWN';
export type FinancialEnvironment = {
  kind: FinancialEnvironmentKind;
  label: string;
  description: string;
  network: string;
  authoritySource: string;
};

export type PathState = 'YES' | 'NO' | 'UNKNOWN' | 'NOT_APPLICABLE';
export type PathStep = {
  id: string;
  label: string;
  state: PathState;
  detail: string;
  evidenceSeqs: number[];
};
/** Structured connector observations, never inferred from the task's requested payment count. */
export type RuntimePathEvidence = {
  source: string;
  environment?: FinancialEnvironment;
  executionBlock: 'SCRIPT_API_ERROR' | 'SIGNING_UNAVAILABLE' | 'PROVIDER_LIMIT' | null;
  bashDisabled: boolean;
  attemptedPaymentCalls: number;
  attemptedUsdMinor: string | null;
  settledUsdMinor: string;
  acceptedActions: number;
  faultDelivered: boolean;
  captureComplete: boolean;
  captureAssessment?: CoverageAssessment;
  reconciliationObserved?: boolean;
  businessTask?: {
    status: 'pending' | 'completed' | 'failed' | 'unknown';
    sourceId: string;
    revision: string | null;
    responseDigest: string | null;
  };
  references: string[];
};
export type PathAssessment = {
  version: 'embertail.test-path/1';
  verdict: Verdict;
  /** One plain sentence describing what the agent did. Derived from the grade; never changes it. */
  headline: string;
  /** A control presents no fault and checks the normal path; a challenge presents one. */
  role: 'control' | 'challenge';
  reasons: string[];
  financialOutcome: {
    known: boolean;
    settledUsdMinor: string | null;
    authorityUsdMinor: string;
    summary: string;
    source: string;
  };
  financialSafety: 'PASS' | 'FAIL' | 'NOT_EXERCISED' | 'UNKNOWN';
  targetSafetyProperty: 'PASS' | 'FAIL' | 'NOT_EXERCISED' | 'UNKNOWN';
  targetSafetyExplanation: string;
  observedFinancialHarm: 'NONE' | 'OBSERVED' | 'UNKNOWN';
  financialEnvironment: FinancialEnvironment;
  transactionsSettled: number | null;
  taskCorrectness: 'COMPLETE' | 'INCOMPLETE' | 'FAIL' | 'UNKNOWN';
  taskDetail: string;
  agentIntent: string;
  guardrail: {
    state: PathState;
    summary: string;
    owner: 'agent' | 'harness' | 'unknown';
    evidenceSeqs: number[];
  };
  controlEnforcement: {
    paymentPath: string | null;
    enforcement: 'code-enforced' | 'prompt-dependent' | 'outside-payment-guards' | 'unknown';
    detail: string;
    evidenceSeqs: number[];
  };
  coverage: 'EXERCISED' | 'NOT_REACHED' | 'UNKNOWN';
  expectedPath: string[];
  observedPath: string[];
  steps: PathStep[];
  whyNotPass: string | null;
  whyNotFail: string | null;
  limitations: string[];
  runtimeReferences: string[];
};
