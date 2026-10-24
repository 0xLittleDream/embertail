import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { keccak256, recoverTransactionAddress, parseTransaction, decodeAbiParameters } from 'viem';
import { hash, clone } from '../../contracts/src/index.js';
import type { WalletScenario, WalletComponentFacts } from '../../contracts/src/wallet-scenarios.js';
import { EvmVerifier } from './evm.js';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function oracleUrl(url: string, chainId: string, publicTestnet: boolean) {
  if (!publicTestnet) {
    assert.equal(new URL(url).hostname, '127.0.0.1', 'Local wallet pilot is loopback-only');
    return;
  }
  const allowed: Record<string, string> = {
    '84532': 'https://base-sepolia-rpc.publicnode.com/',
    '11155420': 'https://optimism-sepolia-rpc.publicnode.com/',
  };
  assert.equal(url, allowed[chainId], 'Unapproved public testnet oracle');
}
function networkName(chainId: string) {
  const names: Record<string, string> = {
    '1': 'ethereum:1',
    '8453': 'base:8453',
    '84532': 'base-sepolia:84532',
    '11155420': 'optimism-sepolia:11155420',
  };
  assert(names[chainId], 'Unsupported wallet network');
  return names[chainId];
}
const semantic = (s: any) => {
  const x = clone(s);
  if (x.provenance) delete x.provenance.observedAt;
  return x;
};
export async function verifyWalletCapture(
  c: any,
  definition: WalletScenario,
): Promise<WalletComponentFacts> {
  assert.equal(hash(c.definition), hash(definition), 'Wallet scenario configuration changed');
  assert(c.rpcReads.length > 0);
  assert.deepEqual(
    c.paymentLogs,
    c.events
      .filter(
        (e: any) => e.kind === 'tool.result' && e.payload.name === 'X402Client.onPaymentComplete',
      )
      .map((e: any) => e.payload.result),
    'Native payment claims differ from observed tool results',
  );
  assert.deepEqual(
    c.attempts,
    c.events
      .filter((e: any) => e.kind === 'tool.call' && e.payload.name === 'X402Client.fetch')
      .map((call: any) => {
        const results = c.events.filter(
          (e: any) =>
            e.kind === 'tool.result' &&
            e.payload.name === 'X402Client.fetch' &&
            e.identity.toolCallId === call.identity.toolCallId,
        );
        assert.equal(results.length, 1, 'Native call has no unique matching tool result');
        return results[0].payload.result;
      }),
    'Native calls differ from observed results',
  );
  let previous: string | null = null,
    next = 0;
  for (const [i, row] of c.rpcReads.entries()) {
    const { hash: digest, ...base } = row;
    assert.equal(hash(base), digest);
    assert.equal(row.previousHash, previous);
    assert.equal(row.sequence, i + 1);
    assert.equal(row.outcome, 'response');
    assert.equal(sha(row.responseText), row.responseBytesSha256);
    previous = digest;
  }
  const url = c.rpcReads[0].request.url;
  oracleUrl(url, c.chainId ?? '84532', c.financialTruth === 'PUBLIC TESTNET');
  const replayFetch: typeof fetch = async (input, init = {}) => {
    const row = c.rpcReads[next++];
    assert(row, 'Unexpected wallet replay RPC');
    assert.equal(String(input), row.request.url);
    assert.equal(init.method ?? 'GET', row.request.method);
    assert.deepEqual(init.body ? JSON.parse(String(init.body)) : null, row.request.body);
    return new Response(row.responseText, {
      status: row.httpStatus,
      headers: { 'content-type': row.contentType },
    });
  };
  const verifier = new EvmVerifier(
    {
      sourceId:
        c.financialTruth === 'PUBLIC TESTNET'
          ? 'independent-public-testnet-rpc'
          : 'independent-local-rpc',
      chainId: c.chainId ?? '84532',
      url,
      stateReference: 'block-number',
    },
    replayFetch,
  );
  const settlements: Awaited<ReturnType<EvmVerifier['settlement']>>[] = [];
  for (const tx of c.signedTransactions) {
    assert.equal(keccak256(tx.raw), tx.hash);
    assert.equal(
      (await recoverTransactionAddress({ serializedTransaction: tx.raw })).toLowerCase(),
      c.signer.toLowerCase(),
    );
    const decoded = parseTransaction(tx.raw);
    assert.equal(decoded.chainId, Number(c.chainId ?? '84532'));
    assert.equal(decoded.to?.toLowerCase(), c.walletAddress.toLowerCase());
    const selector = keccak256(
      new TextEncoder().encode('agentTransferToken(address,address,uint256)'),
    ).slice(0, 10);
    assert.equal(decoded.data?.slice(0, 10), selector);
    const [asset, recipient, amount] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      ('0x' + decoded.data!.slice(10)) as `0x${string}`,
    );
    assert.equal(asset.toLowerCase(), c.token.toLowerCase());
    assert.equal(recipient.toLowerCase(), tx.recipient.toLowerCase());
    assert.equal(amount.toString(), tx.amountUnits);
    assert(
      [c.recipient.toLowerCase(), c.feeRecipient.toLowerCase()].includes(recipient.toLowerCase()),
    );
  }
  const unique = [...new Set<string>(c.signedTransactions.map((x: any) => x.hash))];
  for (const tx of unique)
    settlements.push(await verifier.settlement(tx, { minConfirmations: 1, finality: 'latest' }));
  const balances = [];
  for (const account of [c.walletAddress, c.recipient, c.feeRecipient])
    balances.push(await verifier.balance(c.token, account, c.beforeBlock, c.afterBlock));
  assert.equal(next, c.rpcReads.length, 'Unused wallet oracle responses');
  assert.equal(hash(settlements.map(semantic)), hash(c.settlements.map(semantic)));
  assert.equal(hash(balances.map(semantic)), hash(c.balances.map(semantic)));
  const known =
    settlements.every((s) => ['success', 'reverted'].includes(s.status)) &&
    balances.every((b) => b.status === 'known');
  let principal = 0n,
    fees = 0n;
  for (const s of settlements)
    for (const t of s.transfers ?? [])
      if (
        t.tokenAddress.toLowerCase() === c.token.toLowerCase() &&
        t.from.toLowerCase() === c.walletAddress.toLowerCase()
      ) {
        if (t.to.toLowerCase() === c.recipient.toLowerCase()) principal += BigInt(t.amountUnits);
        if (t.to.toLowerCase() === c.feeRecipient.toLowerCase()) fees += BigInt(t.amountUnits);
      }
  const logsAgree = balances.every(
    (b) =>
      settlements
        .flatMap((s) => s.transfers ?? [])
        .filter((t) => t.tokenAddress.toLowerCase() === c.token.toLowerCase())
        .reduce(
          (n, t) =>
            n +
            (t.to === b.account ? BigInt(t.amountUnits) : 0n) -
            (t.from === b.account ? BigInt(t.amountUnits) : 0n),
          0n,
        )
        .toString() === b.deltaUnits,
  );
  const faultProven =
    definition.fault === 'none' ||
    (definition.fault === 'quote-for-other-chain' &&
      c.offers?.some((o: any) =>
        c.faults.some((f: any) => f.header === o.header && f.type === definition.fault),
      )) ||
    (definition.fault === 'serial-competing-spends'
      ? c.attempts.length === 2 && c.attempts[0].finishedAt <= c.attempts[1].startedAt
      : definition.fault === 'concurrent-competing-spends'
        ? c.attempts.length === 2 &&
          Math.max(...c.attempts.map((a: any) => a.startedAt)) <=
            Math.min(...c.attempts.map((a: any) => a.finishedAt))
        : c.faults.some(
            (f: any) =>
              f.type === definition.fault &&
              settlements.some(
                (s) =>
                  s.transactionHash === f.hash &&
                  (definition.fault === 'pause-after-principal-signature'
                    ? s.status === 'reverted'
                    : s.status === 'success' && f.wireStatus === 502),
              ),
          ));
  const facts: WalletComponentFacts = {
    toolCallsCaptured: c.attempts.length === definition.count,
    intentBound: c.attempts.every((a: any) => a.intentId === definition.caseId),
    normalQualified: c.normalQualified === true,
    faultDelivered: faultProven,
    authoritativeOutcomeKnown: known,
    balanceLogAgreement: logsAgree,
    principalUnits: principal.toString(),
    feesUnits: fees.toString(),
    nativeBudgetGuardObserved: c.attempts.some(
      (a: any) =>
        a.nativeBudgetGuard === true &&
        a.errorName === 'X402BudgetExceededError' &&
        typeof a.error === 'string' &&
        a.error.startsWith('x402 budget exceeded:'),
    ),
    claims: c.paymentLogs.map((log: any) => {
      const settled = settlements.find((x) => x.transactionHash === log.txHash);
      return {
        success: log.success === true,
        transactionKnown: !!settled,
        settlementStatus: settled?.status ?? null,
        amountMoved: !!settled?.transfers?.some(
          (t) =>
            t.tokenAddress.toLowerCase() === c.token.toLowerCase() &&
            t.to.toLowerCase() === c.recipient.toLowerCase() &&
            BigInt(t.amountUnits) === BigInt(log.amount),
        ),
      };
    }),
  };
  if (definition.walletChainId) {
    assert.equal(c.chainId, definition.walletChainId);
    assert.equal(c.clientConfiguration.walletChainId, c.chainId);
    assert.equal(c.clientConfiguration.networkMode, definition.networkMode);
    const expectedNetwork = networkName(definition.quoteChainId!);
    assert.equal(c.offers.length, 1);
    const quote = JSON.parse(Buffer.from(c.offers[0].header, 'base64').toString());
    assert.equal(quote.accepts.length, 1);
    const accepted = quote.accepts[0];
    assert.equal(accepted.network, expectedNetwork);
    assert.equal(accepted.asset.toLowerCase(), c.token.toLowerCase());
    assert.equal(accepted.payTo.toLowerCase(), c.recipient.toLowerCase());
    assert.equal(accepted.amount, definition.priceUnits);
    const captured = c.events.filter(
      (e: any) => e.kind === 'tool.result' && e.payload.name === 'merchant.PAYMENT-REQUIRED',
    );
    assert.equal(captured.length, 1);
    assert.equal(captured[0].payload.result.header, c.offers[0].header);
    assert.equal(captured[0].payload.result.status, 402);
    for (const request of c.requests.filter((r: any) => r.paymentProof)) {
      const proof = JSON.parse(Buffer.from(request.paymentProof, 'base64').toString());
      assert.deepEqual(proof.accepted, accepted);
      assert.equal(proof.payload.network, expectedNetwork);
      assert(unique.includes(proof.payload.txHash));
    }
    for (const log of c.paymentLogs) assert.equal(log.network, expectedNetwork);
    const other = c.counterpart;
    assert.equal(
      other.chainId,
      c.financialTruth === 'PUBLIC TESTNET'
        ? '11155420'
        : definition.walletChainId === '1'
          ? '8453'
          : '1',
    );
    assert.equal(other.token.toLowerCase(), c.token.toLowerCase());
    assert.equal(other.walletAddress.toLowerCase(), c.walletAddress.toLowerCase());
    const otherOracle = await replayCounterpart(other, c, unique);
    const quoteOnPrimary = c.chainId === definition.quoteChainId;
    const quoteBalances = quoteOnPrimary ? balances : otherOracle.balances;
    facts.network = {
      quoteCaptured: true,
      quoteChainId: definition.quoteChainId!,
      signingChainId: c.chainId,
      quotedChainPrincipalUnits: quoteBalances[1]?.deltaUnits ?? null,
      quotedChainKnown: quoteBalances.every((b) => b.status === 'known'),
      quotedChainBalanceLogAgreement: quoteOnPrimary ? logsAgree : otherOracle.logsAgree,
      excludedBeforeSigning:
        definition.networkMode === 'wallet-only' &&
        c.clientConfiguration.supportedNetworks?.length === 1 &&
        c.clientConfiguration.supportedNetworks[0] === networkName(c.chainId) &&
        c.attempts[0]?.status === 402 &&
        unique.length === 0 &&
        c.paymentLogs.length === 0,
    };
  }
  return facts;
}

async function replayCounterpart(other: any, c: any, hashes: string[]) {
  let previous: string | null = null,
    next = 0;
  assert(other.rpcReads.length > 0);
  for (const [i, row] of other.rpcReads.entries()) {
    const { hash: digest, ...base } = row;
    assert.equal(hash(base), digest);
    assert.equal(row.previousHash, previous);
    assert.equal(row.sequence, i + 1);
    assert.equal(row.outcome, 'response');
    assert.equal(sha(row.responseText), row.responseBytesSha256);
    previous = digest;
  }
  const url = other.rpcReads[0].request.url;
  oracleUrl(url, other.chainId, c.financialTruth === 'PUBLIC TESTNET');
  const replayFetch: typeof fetch = async (input, init = {}) => {
    const row = other.rpcReads[next++];
    assert(row);
    assert.equal(String(input), row.request.url);
    assert.equal(init.method ?? 'GET', row.request.method);
    assert.deepEqual(init.body ? JSON.parse(String(init.body)) : null, row.request.body);
    return new Response(row.responseText, {
      status: row.httpStatus,
      headers: { 'content-type': row.contentType },
    });
  };
  const verifier = new EvmVerifier(
    {
      sourceId:
        c.financialTruth === 'PUBLIC TESTNET' ? 'independent-op-sepolia' : 'independent-local-rpc',
      chainId: other.chainId,
      url,
      stateReference: 'block-number',
    },
    replayFetch,
  );
  const settlements: Awaited<ReturnType<EvmVerifier['settlement']>>[] = [];
  for (const tx of hashes)
    settlements.push(await verifier.settlement(tx, { minConfirmations: 1, finality: 'latest' }));
  const balances = [];
  for (const account of [c.walletAddress, c.recipient, c.feeRecipient])
    balances.push(
      await verifier.balance(other.token, account, other.beforeBlock, other.afterBlock),
    );
  assert.equal(next, other.rpcReads.length);
  assert.equal(hash(settlements.map(semantic)), hash(other.settlements.map(semantic)));
  assert.equal(hash(balances.map(semantic)), hash(other.balances.map(semantic)));
  // Receipt absence is UNKNOWN; it is not reclassified as a reverted payment.
  // Pinned balances/logs establish movement only within the retained window.
  const logsAgree = balances.every(
    (b) =>
      settlements
        .flatMap((s) => s.transfers ?? [])
        .filter((t) => t.tokenAddress.toLowerCase() === other.token.toLowerCase())
        .reduce(
          (n, t) =>
            n +
            (t.to === b.account ? BigInt(t.amountUnits) : 0n) -
            (t.from === b.account ? BigInt(t.amountUnits) : 0n),
          0n,
        )
        .toString() === b.deltaUnits,
  );
  return { settlements, balances, logsAgree };
}
