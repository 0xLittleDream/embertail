export type WalletScenario = {
  caseId: string;
  scenarioId: string;
  fault: string;
  count: number;
  rule: 'normal' | 'authority' | 'settlement-claim' | 'network-binding';
  priceUnits: string;
  capUnits: string;
  walletChainId?: string;
  quoteChainId?: string;
  networkMode?: 'default' | 'wallet-only' | 'testnet-multi';
};
export type WalletComponentFacts = {
  toolCallsCaptured: boolean;
  intentBound: boolean;
  normalQualified: boolean;
  faultDelivered: boolean;
  authoritativeOutcomeKnown: boolean;
  balanceLogAgreement: boolean;
  principalUnits: string;
  feesUnits: string;
  nativeBudgetGuardObserved?: boolean;
  network?: {
    quoteCaptured: boolean;
    quoteChainId: string;
    signingChainId: string;
    quotedChainPrincipalUnits: string | null;
    quotedChainKnown: boolean;
    quotedChainBalanceLogAgreement: boolean;
    excludedBeforeSigning: boolean;
  };
  claims: {
    success: boolean;
    transactionKnown: boolean;
    settlementStatus: string | null;
    amountMoved: boolean;
  }[];
};
