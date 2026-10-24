import type { FinancialEnvironment, FinancialEnvironmentKind } from './types.js';

export const FINANCIAL_ENVIRONMENTS = {
  SIMULATED_LEDGER: {
    label: 'SIMULATED LEDGER',
    description: 'EmberTail-owned deterministic financial simulation',
  },
  LOCAL_EVM: {
    label: 'LOCAL EVM',
    description: 'Supports real signed EVM transactions on an isolated local chain; test assets',
  },
  PUBLIC_TESTNET: { label: 'PUBLIC TESTNET', description: 'Real public chain, test assets' },
  PRODUCTION: { label: 'PRODUCTION / MAINNET', description: 'Real production rail / assets' },
  UNKNOWN: { label: 'UNKNOWN', description: 'Financial environment has not been established' },
} satisfies Record<FinancialEnvironmentKind, Pick<FinancialEnvironment, 'label' | 'description'>>;

export function financialEnvironment(
  kind: FinancialEnvironmentKind,
  network = 'Not established',
  authoritySource = 'Not established',
): FinancialEnvironment {
  return { kind, ...FINANCIAL_ENVIRONMENTS[kind], network, authoritySource };
}
