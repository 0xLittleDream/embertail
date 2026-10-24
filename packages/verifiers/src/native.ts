import assert from 'node:assert/strict';
import {
  serializeTransaction,
  keccak256,
  recoverTransactionAddress,
  decodeFunctionData,
  decodeEventLog,
  verifyTypedData,
} from 'viem';
import { hash } from '../../contracts/src/index.js';
import type { NativeFacts, NativePacket, NativeScenario } from '../../contracts/src/native.js';
const types = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

export function nativeRail(evidence: any): {
  financialTruth: 'LOCAL EVM' | 'PUBLIC TESTNET';
  chainId: '8453' | '84532';
  sourceId: string;
} {
  if (evidence.financialTruth === 'LOCAL EVM') {
    assert(!evidence.chainId || evidence.chainId === '8453');
    return { financialTruth: 'LOCAL EVM', chainId: '8453', sourceId: 'independent-local-evm' };
  }
  assert.equal(evidence.financialTruth, 'PUBLIC TESTNET', 'Unsupported native financial rail');
  assert.equal(evidence.chainId, '84532', 'Only Base Sepolia is allowed for this pilot');
  assert.equal(evidence.rpc?.workflow, 'https://sepolia.base.org');
  assert.equal(evidence.rpc?.independentVerification, 'https://base-sepolia-rpc.publicnode.com');
  assert.equal(evidence.gas?.budgetWei, '100000000000000');
  assert(BigInt(evidence.gas.initialBalanceWei) > BigInt(evidence.gas.budgetWei));
  let reserved = 0n;
  const txs = new Set<string>();
  for (const b of evidence.gas.broadcasts) {
    assert.equal(b.chainId, 84532);
    assert.equal(b.sender.toLowerCase(), evidence.addresses.seller.toLowerCase());
    assert(/^0x[a-f0-9]{64}$/.test(b.transactionHash) && !txs.has(b.transactionHash));
    txs.add(b.transactionHash);
    assert(BigInt(b.maximumGasCostWei) > 0n);
    reserved += BigInt(b.maximumGasCostWei);
    assert.equal(String(reserved), b.reservedMaximumGasCostWei);
    assert(reserved <= BigInt(evidence.gas.budgetWei));
  }
  assert.equal(
    String(BigInt(evidence.gas.initialBalanceWei) - BigInt(evidence.gas.finalBalanceWei)),
    evidence.gas.observedDebitWei,
  );
  assert(
    BigInt(evidence.gas.observedDebitWei) >= 0n &&
      BigInt(evidence.gas.observedDebitWei) <= reserved,
  );
  for (const c of evidence.cases) {
    assert(txs.has(c.deploymentTransactionHash));
    for (const s of c.settlements) assert(txs.has(s.settlement.transaction));
  }
  return {
    financialTruth: 'PUBLIC TESTNET',
    chainId: '84532',
    sourceId: 'independent-base-sepolia',
  };
}

// The input is retained native JSON, not a tool success assertion. Reject inconsistent proof material.
export async function verifyNativePacket(
  packet: NativePacket,
  catalog: NativeScenario[],
): Promise<Map<string, NativeFacts>> {
  const evidence: any = packet.evidence,
    artifact: any = packet.artifact;
  assert.equal(evidence.completed, true, 'Native capture did not complete');
  const rail = nativeRail(evidence);
  assert.equal(evidence.inferenceCalls, 0);
  assert.equal(evidence.realAssetSpendUsd, 0);
  assert(Array.isArray(evidence.cases) && evidence.cases.length > 0);
  const definitions = new Map(catalog.map((s) => [s.caseId, s]));
  const result = { signedTransactions: 0 };
  const facts = new Map<string, NativeFacts>();
  const qualified = new Set<string>();
  const denied = (a: any): boolean => {
    if (typeof a.error === 'string' && a.error.includes('rejected by spendControls')) return true;
    try {
      const error = JSON.parse(a.response ?? '{}').error;
      return (
        (a.status === 429 && error?.type === 'cost_cap_exceeded') ||
        (a.status === 403 && error?.type === 'spend_policy_denied')
      );
    } catch {
      return false;
    }
  };
  for (const c of evidence.cases) {
    const definition = definitions.get(c.id);
    assert(definition, 'Unknown native scenario: ' + c.id);
    assert(!facts.has(c.id), 'Duplicate native case');
    for (const key of [
      'id',
      'target',
      'mode',
      'scenario',
      'count',
      'cap',
      'concurrent',
      'walletCap',
      'fault',
      'faultAt',
      'substitute',
      'replay',
      'sameObligation',
      'sdkPolicy',
    ])
      assert.equal(
        c[key],
        (definition.configuration as any)[key],
        'Native configuration mismatch: ' + key,
      );
    if (c.scenario !== 'control')
      assert(qualified.has(c.target), 'Normal signed payment qualification missing before faults');
    let total = 0n;
    // Financial findings are recorded and graded FAIL; only evidence-integrity problems throw.
    const violations: string[] = [];
    const paidTo: Record<string, bigint> = {};
    const txs = new Set(),
      nonces = new Set();
    for (const s of c.settlements) {
      const tx: any = structuredClone(s.transaction);
      for (const key of [
        'chainId',
        'gas',
        'nonce',
        'gasPrice',
        'maxFeePerGas',
        'maxPriorityFeePerGas',
        'value',
        'v',
      ])
        if (tx[key] != null) tx[key] = BigInt(tx[key]);
      tx.data = tx.input;
      const raw = serializeTransaction(tx, { r: tx.r, s: tx.s, v: tx.v } as any);
      assert.equal(keccak256(raw), s.settlement.transaction);
      assert.equal(
        (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase(),
        evidence.addresses.seller.toLowerCase(),
      );
      assert.equal(Number(tx.chainId), Number(rail.chainId));
      assert.equal(tx.to.toLowerCase(), c.token.toLowerCase());
      assert(!txs.has(s.settlement.transaction));
      txs.add(s.settlement.transaction);
      const input = decodeFunctionData({ abi: artifact.abi, data: tx.input }) as any;
      assert.equal(input.functionName, 'transferWithAuthorization');
      assert.equal(input.args[0].toLowerCase(), evidence.addresses.buyer.toLowerCase());
      const authorization = s.payment.payload.authorization;
      // The executed call must match the signed authorization (integrity)...
      assert.equal(input.args[1].toLowerCase(), authorization.to.toLowerCase());
      assert.equal(input.args[2], BigInt(authorization.value));
      assert.equal(input.args[3], BigInt(authorization.validAfter));
      assert.equal(input.args[4], BigInt(authorization.validBefore));
      assert.equal(input.args[5], authorization.nonce);
      assert.equal(authorization.from.toLowerCase(), evidence.addresses.buyer.toLowerCase());
      // ...but paying someone else, or a different amount, is a finding (graded FAIL).
      if (
        authorization.to.toLowerCase() !== evidence.addresses.seller.toLowerCase() ||
        s.payment.accepted.payTo.toLowerCase() !== evidence.addresses.seller.toLowerCase()
      )
        violations.push('payee-substitution');
      if (authorization.value !== '8000' || s.payment.accepted.amount !== '8000')
        violations.push('amount-mismatch');
      const signature = s.payment.payload.signature.slice(2);
      assert.equal(input.args[6], Number.parseInt(signature.slice(128, 130), 16));
      assert.equal(input.args[7].toLowerCase(), '0x' + signature.slice(0, 64).toLowerCase());
      assert.equal(input.args[8].toLowerCase(), '0x' + signature.slice(64, 128).toLowerCase());
      assert.equal(s.payment.accepted.network, 'eip155:' + rail.chainId);
      assert.equal(s.payment.accepted.asset.toLowerCase(), c.token.toLowerCase());
      if (nonces.has(authorization.nonce)) violations.push('authorization-reuse');
      nonces.add(authorization.nonce);
      assert.equal(
        await verifyTypedData({
          address: evidence.addresses.buyer,
          domain: {
            name: 'EmberTail Local USD',
            version: '1',
            chainId: Number(rail.chainId),
            verifyingContract: c.token,
          },
          types: types as any,
          primaryType: 'TransferWithAuthorization',
          message: {
            ...authorization,
            value: BigInt(authorization.value),
            validAfter: BigInt(authorization.validAfter),
            validBefore: BigInt(authorization.validBefore),
          },
          signature: s.payment.payload.signature,
        }),
        true,
      );
      assert.equal(s.authorizationUsed, true);
      assert.equal(s.receipt.status, 'success');
      assert.notEqual(
        s.receipt.blockHash,
        '0x' + '0'.repeat(64),
        'Provisional receipt cannot establish canonical settlement',
      );
      assert.equal(s.receipt.transactionHash, s.settlement.transaction);
      assert.equal(s.verified.status, 'success');
      assert.equal(s.verified.provenance.chainId, rail.chainId);
      assert.equal(s.verified.provenance.sourceId, rail.sourceId);
      if (rail.financialTruth === 'PUBLIC TESTNET')
        assert(BigInt(s.verified.confirmations) >= 2n, 'Two public-chain confirmations required');
      assert.equal(s.verified.transactionHash, s.settlement.transaction);
      assert.equal(s.verified.block.hash, s.receipt.blockHash);
      assert(
        BigInt(s.receipt.blockNumber) > BigInt(c.beforeBlock) &&
          BigInt(s.receipt.blockNumber) <= BigInt(c.afterBlock),
      );
      assert(s.verified.provenance.proofs.length > 0);
      const transfers = s.receipt.logs
        .filter((l: any) => l.address.toLowerCase() === c.token.toLowerCase())
        .map(
          (l: any) => decodeEventLog({ abi: artifact.abi, data: l.data, topics: l.topics }) as any,
        )
        .filter((l: any) => l.eventName === 'Transfer');
      assert.equal(transfers.length, 1);
      assert.equal(transfers[0]!.args.from.toLowerCase(), evidence.addresses.buyer.toLowerCase());
      assert.equal(transfers[0].args.to.toLowerCase(), authorization.to.toLowerCase());
      assert.equal(transfers[0].args.value, BigInt(authorization.value));
      total += transfers[0].args.value;
      const recipient = transfers[0].args.to.toLowerCase();
      paidTo[recipient] = (paidTo[recipient] ?? 0n) + transfers[0].args.value;
      assert.equal(s.verified.transfers.length, 1);
      assert.equal(s.verified.transfers[0].amountUnits, authorization.value);
      result.signedTransactions++;
    }
    // Every role's balance change must equal the transfers the logs show (integrity).
    const received = (role: 'seller' | 'other') =>
      paidTo[String(evidence.addresses[role]).toLowerCase()] ?? 0n;
    assert.equal(received('seller'), BigInt(c.after.seller) - BigInt(c.before.seller));
    assert.equal(received('other'), BigInt(c.after.other) - BigInt(c.before.other));
    assert.equal(total, BigInt(c.before.buyer) - BigInt(c.after.buyer));
    if (received('other') > 0n) violations.push('third-party-movement');
    assert.equal(total.toString(), c.settledPrincipal);
    assert(BigInt(c.afterBlock) > BigInt(c.beforeBlock));
    for (const b of c.balanceVerification) {
      assert.equal(b.status, 'known');
      assert.equal(b.tokenAddress.toLowerCase(), c.token.toLowerCase());
      assert.equal(b.provenance.chainId, rail.chainId);
      assert.equal(b.provenance.sourceId, rail.sourceId);
      assert.equal(b.provenance.proofs.filter((p: any) => p.method === 'eth_call').length, 2);
      assert.equal(b.window.before.hash, c.blockWindow.before.hash);
      assert.equal(b.window.after.hash, c.blockWindow.after.hash);
      const role = Object.entries(evidence.addresses).find(
        ([, address]) => String(address).toLowerCase() === b.account,
      )?.[0];
      assert(role, 'Unknown balance account');
      assert.equal(b.beforeUnits, c.before[role]);
      assert.equal(b.afterUnits, c.after[role]);
      assert.equal(BigInt(b.deltaUnits), BigInt(c.after[role]) - BigInt(c.before[role]));
    }
    for (const f of c.faults) {
      assert.equal(f.afterReceiptStatus, 'success');
      assert.equal(f.type, c.fault);
      assert(c.settlements.some((s: any) => s.settlement.transaction === f.transactionHash));
    }

    const missing: string[] = [];
    const roles = ['buyer', 'seller', 'other'];
    if (
      c.balanceVerification.length !== 3 ||
      new Set(c.balanceVerification.map((b: any) => b.account)).size !== 3
    )
      missing.push('independent.balance_window');
    const obligations = [...new Set<string>(c.attempts.map((a: any) => a.obligation))];
    for (const id of obligations) {
      const task = c.independentTaskStates.find((t: any) => t.taskRef === id);
      if (
        !task ||
        !['completed', 'pending', 'failed'].includes(task.status) ||
        !task.sourceId ||
        !task.revision ||
        !/^[a-f0-9]{64}$/.test(task.responseDigest ?? '') ||
        !Number.isFinite(Date.parse(task.observedAt))
      )
        missing.push('task.' + id + '.authoritative_state');
    }
    assert.equal(
      c.attempts.length,
      c.count,
      'Captured frontend call count differs from configured scenario',
    );
    for (const s of c.settlements)
      assert(obligations.includes(s.obligation), 'Settlement bound to an unknown obligation');
    if (c.scenario === 'control') {
      assert.equal(c.settlements.length, 1, 'Normal payment must settle');
      assert.equal(c.attempts[0].status, 200, 'Normal payment must return success');
      qualified.add(c.target);
    }
    const prior = new Map<string, string>();
    facts.set(c.id, {
      settledUnits: total.toString(),
      transactions: c.settlements.map((s: any) => {
        const row = {
          hash: s.settlement.transaction,
          obligationId: s.obligation,
          amountUnits: s.payment.payload.authorization.value,
          retryOf: prior.get(s.obligation) ?? null,
        };
        prior.set(s.obligation, row.hash);
        return row;
      }),
      attemptedCalls: c.attempts.length,
      normalPaymentQualified: qualified.has(c.target),
      obligationCalls: Object.fromEntries(
        obligations.map((id) => [id, c.attempts.filter((a: any) => a.obligation === id).length]),
      ),
      faultRequested: c.fault ?? 'none',
      faultDelivered: c.faults.length > 0,
      authoritativeOutcomeKnown: !missing.includes('independent.balance_window'),
      taskStates: c.independentTaskStates,
      responses: c.attempts.map((a: any) => ({ status: a.status ?? null, error: a.error ?? null })),
      guardDenialObserved: c.attempts.some(denied),
      replayDenied: c.replay
        ? c.replayResponse?.status === 400 &&
          c.requests.filter((r: any) => r.rejection).length === 1
        : null,
      rejectedQuoteBeforeSigning:
        c.substitute || c.sdkPolicy
          ? c.requests.filter((r: any) => r.paid).length === 0 &&
            c.settlements.length === 0 &&
            c.attempts.some(denied)
          : null,
      missing,
      // Present only when there is a finding, so earlier results keep identical facts.
      ...(violations.length ? { violations: [...new Set(violations)] } : {}),
    });
  }
  return facts;
}
