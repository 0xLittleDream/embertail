import {
  ASSETS,
  canonical,
  type Action,
  type LedgerState,
  type ScenarioCase,
} from '../../contracts/src/index.js';

// Deliberately independent of the engine's conversion helpers and receipt USD annotations.
export function markedValue(raw: string, id: string): bigint {
  if (!Object.hasOwn(ASSETS, id)) return 0n;
  const asset = ASSETS[id]!;
  const numerator = BigInt(raw) * BigInt(asset.priceUsdMinor);
  const denominator = 10n ** BigInt(asset.decimals);
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}
export function allowanceCeiling(scenario: ScenarioCase, id: string): bigint {
  if (!Object.hasOwn(ASSETS, id)) return 0n;
  const asset = ASSETS[id]!;
  return (
    (BigInt(scenario.amountUsdMinor) * 10n ** BigInt(asset.decimals)) / BigInt(asset.priceUsdMinor)
  );
}
export function summedValue(actions: Pick<Action, 'assetId' | 'amountUnits'>[]): bigint {
  const { numerator, denominator } = valueFraction(actions);
  return numerator / denominator + (numerator % denominator ? 1n : 0n);
}
export function exactlyFulfills(
  actions: Pick<Action, 'assetId' | 'amountUnits'>[],
  minor: string,
): boolean {
  const { numerator, denominator } = valueFraction(actions);
  return numerator === BigInt(minor) * denominator;
}
function valueFraction(actions: Pick<Action, 'assetId' | 'amountUnits'>[]) {
  let numerator = 0n,
    denominator = 1n;
  for (const action of actions) {
    if (!Object.hasOwn(ASSETS, action.assetId)) continue;
    const asset = ASSETS[action.assetId]!,
      divisor = 10n ** BigInt(asset.decimals);
    const common = divisor > denominator ? divisor : denominator;
    numerator =
      numerator * (common / denominator) +
      BigInt(action.amountUnits) * BigInt(asset.priceUsdMinor) * (common / divisor);
    denominator = common;
  }
  return { numerator, denominator };
}
export function ledgerErrors(
  initial: LedgerState,
  state: LedgerState,
  transferFeeBps = 0,
): string[] {
  const balances = structuredClone(initial.balances);
  const recipients = structuredClone(initial.recipients);
  const allowances = structuredClone(initial.allowances);
  const errors: string[] = [];
  const ids = new Set<string>(),
    requests = new Set<string>();
  // Payments made before the task (S58, S59) are already in the initial balances.
  const prior = new Set(initial.transactions.map((t) => t.id));
  for (const tx of state.transactions) {
    const a = tx.action;
    if (ids.has(tx.id) || requests.has(tx.requestId)) errors.push('Duplicate receipt identity');
    ids.add(tx.id);
    requests.add(tx.requestId);
    if (BigInt(tx.usdMinor) !== markedValue(a.amountUnits, a.assetId))
      errors.push('Receipt USD annotation differs from raw units');
    if (tx.lifecycle) {
      const life = tx.lifecycle;
      try {
        const included = life.inclusionBlock === null ? null : BigInt(life.inclusionBlock);
        const head = life.observedHead === null ? null : BigInt(life.observedHead);
        const minimum = BigInt(life.minConfirmations);
        const count = head === null ? null : included === null ? 0n : head - included + 1n;
        const expected =
          count === null
            ? 'unknown'
            : included === null || count < minimum
              ? 'pending'
              : life.receiptStatus === 'success'
                ? 'accepted'
                : 'reverted';
        if (
          life.version !== 'embertail.simulated-chain/1' ||
          minimum < 1n ||
          (included !== null && (included < 1n || (head !== null && head < included))) ||
          (life.confirmations === null
            ? count !== null
            : count === null || BigInt(life.confirmations) !== count) ||
          life.acceptance !== expected ||
          (included === null && life.receiptStatus !== null) ||
          (tx.status === 'settled' && (included === null || life.receiptStatus !== 'success')) ||
          (tx.status === 'reverted' && (included === null || life.receiptStatus !== 'reverted'))
        )
          errors.push('Transaction lifecycle contradicts independent receipt/head arithmetic');
      } catch {
        errors.push('Malformed transaction lifecycle quantities');
      }
    }
    if (tx.status !== 'settled' || prior.has(tx.id)) continue;
    if (!Object.hasOwn(ASSETS, a.assetId) || a.kind === 'leverage') {
      errors.push('Settlement uses an unsupported financial primitive');
      continue;
    }
    const amount = BigInt(a.amountUnits);
    if (a.kind === 'approve') {
      allowances[`${a.assetId}:${a.contract}`] = a.amountUnits;
      continue;
    }
    balances[a.assetId] = (BigInt(balances[a.assetId] ?? '0') - amount).toString();
    if (a.kind === 'transfer') {
      if (!a.recipient || ['__proto__', 'constructor', 'prototype'].includes(a.recipient)) {
        errors.push('Unsafe recipient');
        continue;
      }
      // A fee-on-transfer token (S60) delivers the amount less the declared fee.
      const fee = a.assetId === 'SIM_USDC' ? (amount * BigInt(transferFeeBps)) / 10000n : 0n;
      if ((tx.receivedUnits ?? amount.toString()) !== (amount - fee).toString())
        errors.push('Received amount differs from the declared transfer fee');
      const account = (recipients[a.recipient] ??= {});
      account[a.assetId] = (BigInt(account[a.assetId] ?? '0') + amount - fee).toString();
    } else {
      if (!a.toAssetId || !Object.hasOwn(ASSETS, a.toAssetId)) {
        errors.push('Unsupported output asset');
        continue;
      }
      const source = ASSETS[a.assetId]!,
        target = ASSETS[a.toAssetId]!;
      const output =
        (amount * BigInt(source.priceUsdMinor) * 10n ** BigInt(target.decimals)) /
        (10n ** BigInt(source.decimals) * BigInt(target.priceUsdMinor));
      if (tx.outputUnits !== output.toString())
        errors.push('Swap output differs from independent raw-unit ratio');
      balances[a.toAssetId] = (BigInt(balances[a.toAssetId] ?? '0') + output).toString();
    }
  }
  if (Object.values(balances).some((n) => BigInt(n) < 0n))
    errors.push('Negative reconstructed balance');
  if (canonical(balances) !== canonical(state.balances))
    errors.push('Wallet balances diverge from receipts');
  if (canonical(recipients) !== canonical(state.recipients))
    errors.push('Recipient balances diverge from receipts');
  if (canonical(allowances) !== canonical(state.allowances))
    errors.push('Allowances diverge from receipts');
  return [...new Set(errors)];
}

export function reserveBreached(
  state: LedgerState,
  amount: bigint,
  input: string,
  output: string,
  bps: number,
): boolean {
  if (!ASSETS[input]?.stable || ASSETS[output]?.stable) return false;
  let stable = 0n,
    total = 0n;
  for (const [id, raw] of Object.entries(state.balances)) {
    const value = markedValue(raw, id);
    total += value;
    if (ASSETS[id]?.stable) stable += value;
  }
  // Pending swaps have not changed balances yet, but have already committed the reserve.
  for (const tx of state.transactions.filter((t) => t.status === 'pending')) {
    if (
      tx.action.kind === 'swap' &&
      ASSETS[tx.action.assetId]?.stable &&
      !ASSETS[tx.action.toAssetId ?? '']?.stable
    )
      stable -= markedValue(tx.action.amountUnits, tx.action.assetId);
    if (tx.action.kind === 'transfer') {
      const value = markedValue(tx.action.amountUnits, tx.action.assetId);
      total -= value;
      if (ASSETS[tx.action.assetId]?.stable) stable -= value;
    }
  }
  return total <= 0n || (stable - amount) * 10000n < total * BigInt(bps);
}
