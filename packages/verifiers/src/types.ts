export type Block = { number: string; hash: string; parentHash: string };
export type Proof = { method: string; requestDigest: string; responseDigest: string };
export type Provenance = { sourceId: string; chainId: string; observedAt: string; proofs: Proof[] };
export type SettlementPolicy = {
  minConfirmations: number;
  finality: 'latest' | 'safe' | 'finalized';
};
export type Settlement = {
  transactionHash: string;
  status: 'pending' | 'success' | 'reverted' | 'unknown';
  executionStatus: 'success' | 'reverted' | null;
  reason: string;
  block: Block | null;
  confirmations: string | null;
  from: string | null;
  to: string | null;
  transfers: Transfer[] | null;
  unsupportedTransferTokens: string[];
  provenance: Provenance;
};
export type Transfer = {
  tokenAddress: string;
  from: string;
  to: string;
  amountUnits: string;
  logIndex: string;
  transactionHash: string;
  blockHash: string;
};
export type Window = { before: Block; after: Block };
export type BalanceDelta = {
  status: 'known' | 'unknown';
  tokenAddress: string;
  account: string;
  beforeUnits: string | null;
  afterUnits: string | null;
  deltaUnits: string | null;
  window: Window | null;
  reason: string;
  provenance: Provenance;
};
export type AllowanceDelta = {
  status: 'known' | 'unknown';
  tokenAddress: string;
  owner: string;
  spender: string;
  beforeUnits: string | null;
  afterUnits: string | null;
  deltaUnits: string | null;
  window: Window | null;
  reason: string;
  provenance: Provenance;
};
export type BusinessTask = {
  sourceId: string | null;
  taskRef: string;
  status: 'pending' | 'completed' | 'failed' | 'unknown';
  revision: string | null;
  observedAt: string;
  reason: string;
  responseDigest: string | null;
};
export type Attempt = {
  financialActionId: string;
  transactionHash: string;
  kind: 'transfer' | 'approve' | 'swap';
  retryOfActionId: string | null;
};
export type VerificationPlan = {
  schemaVersion: 'embertail.verification-plan/1';
  rpcSourceId: string;
  chainId: string;
  taskSourceId: string;
  taskRef: string;
  policy: SettlementPolicy;
  maxAgeSeconds: number;
  beforeBlock: string;
  afterBlock: string;
  obligation:
    | {
        kind: 'payment';
        tokenAddress: string;
        sender: string;
        recipient: string;
        amountUnits: string;
      }
    | { kind: 'workflow' };
  actions: Attempt[];
  balances: { tokenAddress: string; account: string }[];
  allowances: { tokenAddress: string; owner: string; spender: string; maxAfterUnits: string }[];
};
export type VerificationSnapshot = {
  schemaVersion: 'embertail.verification/1';
  verifiedAt: string;
  expiresAt: string;
  planDigest: string;
  plan: VerificationPlan;
  settlements: { financialActionId: string; result: Settlement }[];
  balances: BalanceDelta[];
  allowances: AllowanceDelta[];
  businessTask: BusinessTask;
  consistency: { confirmed: boolean; provenance: Provenance | null };
  correlation: {
    financialOutcome: 'exact_payment' | 'overpayment' | 'underpayment' | 'unknown' | 'workflow';
    paidUnits: string | null;
    distinctSettlements: number;
    matchingTransferCount: number;
    duplicateTransactionAliases: number;
    allowanceViolations: number;
    unresolvedActions: string[];
    complete: boolean;
    reasons: string[];
  };
};
