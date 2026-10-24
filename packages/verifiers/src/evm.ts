import { hash } from '../../contracts/src/index.js';
import { boundedJson, validateEndpoint, type Endpoint } from './http.js';
import type {
  AllowanceDelta,
  BalanceDelta,
  Block,
  Proof,
  Provenance,
  Settlement,
  SettlementPolicy,
  Transfer,
  Window,
} from './types.js';
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export function address(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[\da-fA-F]{40}$/.test(value))
    throw Error('Invalid EVM address');
  return value.toLowerCase();
}
export function txHash(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[\da-fA-F]{64}$/.test(value))
    throw Error('Invalid EVM hash');
  return value.toLowerCase();
}
export function decimal(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,77})$/.test(value) ||
    BigInt(value) > (1n << 256n) - 1n
  )
    throw Error('Invalid uint256 decimal string');
  return value;
}
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][\da-fA-F]{0,63})$/.test(value))
    throw Error('Invalid RPC quantity');
  return BigInt(value);
}
const hex = (value: string) => '0x' + BigInt(decimal(value)).toString(16);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid RPC object');
  return value as Record<string, unknown>;
};
function block(value: unknown): Block {
  const v = object(value);
  return {
    number: quantity(v.number).toString(),
    hash: txHash(v.hash),
    parentHash: txHash(v.parentHash),
  };
}
export class EvmVerifier {
  constructor(
    readonly endpoint: Endpoint & {
      chainId: string;
      stateReference?: 'block-hash' | 'block-number';
    },
    readonly fetcher = globalThis.fetch,
  ) {
    validateEndpoint(endpoint);
    decimal(endpoint.chainId);
    if (endpoint.chainId === '0') throw Error('Invalid configured chain ID');
    if (
      endpoint.stateReference &&
      !['block-hash', 'block-number'].includes(endpoint.stateReference)
    )
      throw Error('Invalid state reference mode');
  }
  private async rpc(method: string, params: unknown[], proofs: Proof[], signal?: AbortSignal) {
    if (
      ![
        'eth_chainId',
        'eth_syncing',
        'eth_getTransactionReceipt',
        'eth_getTransactionByHash',
        'eth_getBlockByNumber',
        'eth_getCode',
        'eth_call',
      ].includes(method)
    )
      throw Error('RPC method is outside read-only verifier surface');
    const request = { jsonrpc: '2.0', id: proofs.length + 1, method, params };
    const value = await boundedJson(
      validateEndpoint(this.endpoint),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.endpoint.bearer ? { authorization: 'Bearer ' + this.endpoint.bearer } : {}),
        },
        body: JSON.stringify(request),
        signal,
      },
      this.fetcher,
    );
    const response = object(value);
    proofs.push({
      method,
      requestDigest: hash({ method, params }),
      responseDigest: hash(response),
    });
    if (
      response.jsonrpc !== '2.0' ||
      response.id !== request.id ||
      Object.hasOwn(response, 'error') ||
      !Object.hasOwn(response, 'result')
    )
      throw Error('Invalid or unavailable RPC result');
    return response.result;
  }
  private async ready(proofs: Proof[], signal?: AbortSignal) {
    if (
      quantity(await this.rpc('eth_chainId', [], proofs, signal)).toString() !==
      this.endpoint.chainId
    )
      throw Error('RPC chain ID mismatch');
    if ((await this.rpc('eth_syncing', [], proofs, signal)) !== false)
      throw Error('RPC node is syncing');
  }
  private provenance(proofs: Proof[]): Provenance {
    return {
      sourceId: this.endpoint.sourceId,
      chainId: this.endpoint.chainId,
      observedAt: new Date().toISOString(),
      proofs,
    };
  }
  async settlement(
    transactionHash: string,
    policy: SettlementPolicy = { minConfirmations: 1, finality: 'latest' },
    signal?: AbortSignal,
  ): Promise<Settlement> {
    transactionHash = txHash(transactionHash);
    if (
      !Number.isSafeInteger(policy.minConfirmations) ||
      policy.minConfirmations < 1 ||
      policy.minConfirmations > 1000000 ||
      !['latest', 'safe', 'finalized'].includes(policy.finality)
    )
      throw Error('Invalid settlement policy');
    const proofs: Proof[] = [];
    const result: Settlement = {
      transactionHash,
      status: 'unknown',
      executionStatus: null,
      reason: 'RPC unavailable or inconsistent',
      block: null,
      confirmations: null,
      from: null,
      to: null,
      transfers: null,
      unsupportedTransferTokens: [],
      provenance: this.provenance(proofs),
    };
    try {
      await this.ready(proofs, signal);
      const raw = await this.rpc('eth_getTransactionReceipt', [transactionHash], proofs, signal);
      if (raw === null) {
        const pending = await this.rpc(
          'eth_getTransactionByHash',
          [transactionHash],
          proofs,
          signal,
        );
        if (
          pending !== null &&
          txHash(object(pending).hash) === transactionHash &&
          object(pending).blockNumber === null
        ) {
          result.status = 'pending';
          result.reason = 'Known transaction has not been mined';
        } else
          result.reason =
            'Transaction not found or receipt unavailable; absence does not prove failure';
        return result;
      }
      const receipt = object(raw),
        mined = block({
          number: receipt.blockNumber,
          hash: receipt.blockHash,
          parentHash: '0x' + '0'.repeat(64),
        });
      if (txHash(receipt.transactionHash) !== transactionHash)
        throw Error('Receipt transaction mismatch');
      const canonical = block(
        await this.rpc('eth_getBlockByNumber', [hex(mined.number), false], proofs, signal),
      );
      if (canonical.hash !== mined.hash || canonical.number !== mined.number) {
        result.reason = 'Receipt block is no longer canonical';
        return result;
      }
      const head = block(await this.rpc('eth_getBlockByNumber', ['latest', false], proofs, signal));
      if (BigInt(head.number) < BigInt(canonical.number)) throw Error('Head precedes receipt');
      const status = quantity(receipt.status);
      if (status !== 0n && status !== 1n) throw Error('Invalid execution status');
      result.block = canonical;
      result.executionStatus = status === 1n ? 'success' : 'reverted';
      result.confirmations = (BigInt(head.number) - BigInt(canonical.number) + 1n).toString();
      result.from = address(receipt.from);
      result.to = receipt.to === null ? null : address(receipt.to);
      if (BigInt(result.confirmations) < BigInt(policy.minConfirmations)) {
        result.status = 'pending';
        result.reason = 'Waiting for required confirmations';
        return result;
      }
      if (policy.finality !== 'latest') {
        const final = block(
          await this.rpc('eth_getBlockByNumber', [policy.finality, false], proofs, signal),
        );
        if (BigInt(final.number) > BigInt(head.number)) throw Error('Finality head exceeds latest');
        if (BigInt(final.number) < BigInt(canonical.number)) {
          result.status = 'pending';
          result.reason = 'Waiting for ' + policy.finality + ' head';
          return result;
        }
      }
      if (!Array.isArray(receipt.logs) || receipt.logs.length > 200)
        throw Error('Invalid receipt logs');
      const transfers: Transfer[] = [];
      const indexes = new Set<string>();
      for (const item of receipt.logs) {
        const log = object(item);
        if (
          (log.removed !== undefined && typeof log.removed !== 'boolean') ||
          log.removed === true ||
          txHash(log.transactionHash) !== transactionHash ||
          txHash(log.blockHash) !== canonical.hash ||
          quantity(log.blockNumber).toString() !== canonical.number
        )
          throw Error('Receipt log identity mismatch');
        if (!Array.isArray(log.topics) || log.topics.length > 4) throw Error('Invalid log topics');
        const topics = log.topics.map(txHash);
        const index = quantity(log.logIndex).toString();
        if (indexes.has(index)) throw Error('Duplicate receipt log index');
        indexes.add(index);
        if (topics[0] !== TRANSFER_TOPIC) continue;
        // ERC721 uses the same signature but a fourth indexed topic. Do not call it ERC20.
        if (topics.length === 4) {
          result.unsupportedTransferTokens.push(address(log.address));
          continue;
        }
        if (
          topics.length !== 3 ||
          typeof log.data !== 'string' ||
          !/^0x[\da-fA-F]{64}$/.test(log.data)
        )
          throw Error('Malformed ERC20 Transfer log');
        const account = (value: unknown) => {
          if (typeof value !== 'string' || !/^0x0{24}[\da-fA-F]{40}$/.test(value))
            throw Error('Malformed Transfer address');
          return address('0x' + value.slice(-40));
        };
        transfers.push({
          tokenAddress: address(log.address),
          from: account(log.topics[1]),
          to: account(log.topics[2]),
          amountUnits: BigInt(log.data).toString(),
          logIndex: index,
          transactionHash,
          blockHash: canonical.hash,
        });
      }
      if (transfers.length > 20 || (status === 0n && receipt.logs.length !== 0))
        throw Error('Receipt log set unsupported');
      // Check again after all reads. A changed block invalidates this entire receipt view.
      if (
        block(
          await this.rpc('eth_getBlockByNumber', [hex(canonical.number), false], proofs, signal),
        ).hash !== canonical.hash
      ) {
        result.reason = 'Canonical block changed during verification';
        return result;
      }
      result.status = result.executionStatus;
      result.transfers = transfers;
      result.reason = 'Canonical receipt meets configured settlement policy';
    } catch {
      result.status = 'unknown';
      result.transfers = null;
    } finally {
      result.provenance = this.provenance(proofs);
    }
    return result;
  }
  private async window(
    beforeBlock: string,
    afterBlock: string,
    proofs: Proof[],
    signal?: AbortSignal,
  ): Promise<Window> {
    if (BigInt(decimal(beforeBlock)) >= BigInt(decimal(afterBlock)))
      throw Error('Before block must precede after block');
    const result = {
      before: block(
        await this.rpc('eth_getBlockByNumber', [hex(beforeBlock), false], proofs, signal),
      ),
      after: block(
        await this.rpc('eth_getBlockByNumber', [hex(afterBlock), false], proofs, signal),
      ),
    };
    if (result.before.number !== beforeBlock || result.after.number !== afterBlock)
      throw Error('State block number mismatch');
    return result;
  }
  async confirmBlocks(blocks: Block[], policy: SettlementPolicy, signal?: AbortSignal) {
    const proofs: Proof[] = [];
    try {
      await this.ready(proofs, signal);
      const head = block(await this.rpc('eth_getBlockByNumber', ['latest', false], proofs, signal));
      let final = head;
      if (policy.finality !== 'latest')
        final = block(
          await this.rpc('eth_getBlockByNumber', [policy.finality, false], proofs, signal),
        );
      if (BigInt(final.number) > BigInt(head.number)) throw Error('Inconsistent finality head');
      for (const at of new Map(blocks.map((at) => [at.number, at])).values()) {
        if (
          block(await this.rpc('eth_getBlockByNumber', [hex(at.number), false], proofs, signal))
            .hash !== at.hash ||
          BigInt(head.number) - BigInt(at.number) + 1n < BigInt(policy.minConfirmations) ||
          BigInt(final.number) < BigInt(at.number)
        )
          throw Error('Block changed or has not met finality policy');
      }
      return { confirmed: true, provenance: this.provenance(proofs) };
    } catch {
      return { confirmed: false, provenance: this.provenance(proofs) };
    }
  }
  private async word(
    tokenAddress: string,
    data: string,
    at: Block,
    proofs: Proof[],
    signal?: AbortSignal,
  ) {
    // Explicit local-node compatibility; canonical hashes are checked before
    // and after the numeric reads. Never fall back to latest or guessed state.
    const ref =
      this.endpoint.stateReference === 'block-number'
        ? hex(at.number)
        : { blockHash: at.hash, requireCanonical: true };
    const code = await this.rpc('eth_getCode', [tokenAddress, ref], proofs, signal);
    if (typeof code !== 'string' || !/^0x(?:[\da-fA-F]{2})+$/.test(code))
      throw Error('Token has no contract code at requested block');
    const raw = await this.rpc('eth_call', [{ to: tokenAddress, data }, ref], proofs, signal);
    if (typeof raw !== 'string' || !/^0x[\da-fA-F]{64}$/.test(raw))
      throw Error('Nonstandard ERC20 return value');
    return BigInt(raw);
  }
  private async unchanged(window: Window, proofs: Proof[], signal?: AbortSignal) {
    for (const at of [window.before, window.after])
      if (
        block(await this.rpc('eth_getBlockByNumber', [hex(at.number), false], proofs, signal))
          .hash !== at.hash
      )
        throw Error('State window reorged');
  }
  async balance(
    tokenAddress: string,
    account: string,
    beforeBlock: string,
    afterBlock: string,
    signal?: AbortSignal,
  ): Promise<BalanceDelta> {
    tokenAddress = address(tokenAddress);
    account = address(account);
    decimal(beforeBlock);
    decimal(afterBlock);
    const proofs: Proof[] = [],
      base = { tokenAddress, account, provenance: this.provenance(proofs) };
    try {
      await this.ready(proofs, signal);
      const window = await this.window(beforeBlock, afterBlock, proofs, signal);
      const data = '0x70a08231' + account.slice(2).padStart(64, '0');
      const before = await this.word(tokenAddress, data, window.before, proofs, signal),
        after = await this.word(tokenAddress, data, window.after, proofs, signal);
      await this.unchanged(window, proofs, signal);
      return {
        ...base,
        status: 'known',
        beforeUnits: before.toString(),
        afterUnits: after.toString(),
        deltaUnits: (after - before).toString(),
        window,
        reason: 'Block-boundary balances; not transaction-isolated deltas',
        provenance: this.provenance(proofs),
      };
    } catch {
      return {
        ...base,
        status: 'unknown',
        beforeUnits: null,
        afterUnits: null,
        deltaUnits: null,
        window: null,
        reason: 'Pinned historical balance state unavailable or inconsistent',
        provenance: this.provenance(proofs),
      };
    }
  }
  async allowance(
    tokenAddress: string,
    owner: string,
    spender: string,
    beforeBlock: string,
    afterBlock: string,
    signal?: AbortSignal,
  ): Promise<AllowanceDelta> {
    tokenAddress = address(tokenAddress);
    owner = address(owner);
    spender = address(spender);
    decimal(beforeBlock);
    decimal(afterBlock);
    const proofs: Proof[] = [],
      base = { tokenAddress, owner, spender, provenance: this.provenance(proofs) };
    try {
      await this.ready(proofs, signal);
      const window = await this.window(beforeBlock, afterBlock, proofs, signal);
      const data =
        '0xdd62ed3e' + owner.slice(2).padStart(64, '0') + spender.slice(2).padStart(64, '0');
      const before = await this.word(tokenAddress, data, window.before, proofs, signal),
        after = await this.word(tokenAddress, data, window.after, proofs, signal);
      await this.unchanged(window, proofs, signal);
      return {
        ...base,
        status: 'known',
        beforeUnits: before.toString(),
        afterUnits: after.toString(),
        deltaUnits: (after - before).toString(),
        window,
        reason: 'Direct allowance reads; Approval logs and failed swaps are not substitutes',
        provenance: this.provenance(proofs),
      };
    } catch {
      return {
        ...base,
        status: 'unknown',
        beforeUnits: null,
        afterUnits: null,
        deltaUnits: null,
        window: null,
        reason: 'Pinned historical allowance state unavailable or inconsistent',
        provenance: this.provenance(proofs),
      };
    }
  }
}
