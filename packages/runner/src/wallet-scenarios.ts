import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  hash,
  clone,
  combineVerdicts,
  DEFAULT_MANDATE,
  type Verdict,
} from '../../contracts/src/index.js';
import { EvidenceBus } from '../../evidence-bus/src/bus.js';
import { verifyWalletCapture } from '../../verifiers/src/wallet-scenarios.js';
import { gradeWalletScenario } from '../../grading/src/wallet-scenarios.js';
import { atomicJson, Store } from './store.js';

import type { WalletScenario } from '../../contracts/src/wallet-scenarios.js';
export type { WalletScenario } from '../../contracts/src/wallet-scenarios.js';
export type WalletScenarioOptions = {
  runtime: 'wallet-component';
  targetRuntime: 'head' | 'release' | 'beta';
  pack?: string;
  adapter?: {
    execute(context: { scenarios: WalletScenario[]; signal?: AbortSignal }): Promise<string>;
  };
  packetDirectory?: string;
  signal?: AbortSignal;
};
export type WalletScenarioRun = {
  schemaVersion: 'embertail.wallet-scenario-run/1';
  runtime: 'wallet-component';
  id: string;
  status: 'running' | 'complete' | 'error';
  verdict: Verdict;
  agentVerdict: null;
  targetRuntime: 'head' | 'release' | 'beta';
  financialTruth: 'LOCAL EVM' | 'PUBLIC TESTNET';
  scope: 'financial-component';
  taskCorrectness: 'UNKNOWN';
  createdAt: string;
  completedAt?: string;
  error?: string;
  manifest: Record<string, unknown>;
  manifestHash: string;
  packet: any;
  cases: {
    caseId: string;
    scenarioId: string;
    verdict: Verdict;
    checks: Record<string, boolean>;
    violations: string[];
    missing: string[];
    principalUnits: string;
    feesUnits: string;
    journal: any;
    canonicalHash: string;
  }[];
};
export async function walletScenarios(root: string, pack = 'wallet') {
  const networkPack =
    pack === 'wallet-network' || pack === 'S32' || pack.startsWith('wallet-network-');
  const catalog = JSON.parse(
    await readFile(
      path.join(
        root,
        `fixtures/wallet-scenarios-v${pack === 'wallet-testnet' ? 3 : networkPack ? 2 : 1}/scenarios.json`,
      ),
      'utf8',
    ),
  ) as WalletScenario[];
  assert(new Set(catalog.map((x) => x.caseId)).size === catalog.length);
  for (const s of catalog) {
    assert(/^wallet-[a-z0-9-]+$/.test(s.caseId));
    assert(['S01', 'S13', 'S16', 'S19', 'S32'].includes(s.scenarioId));
    assert(/^[1-9]\d*$/.test(s.priceUnits) && /^[1-9]\d*$/.test(s.capUnits));
    assert(Number.isSafeInteger(s.count) && s.count > 0);
  }
  const selected = catalog.filter(
    (s) =>
      pack === 'wallet' ||
      pack === 'wallet-network' ||
      pack === 'wallet-testnet' ||
      s.caseId === pack ||
      s.scenarioId === pack,
  );
  assert(selected.length, 'Unknown wallet scenario pack');
  return catalog.filter((s) => s.rule === 'normal' || selected.includes(s));
}

export async function executeWalletScenarioRun(
  options: WalletScenarioOptions,
  store: Store,
  root: string,
): Promise<WalletScenarioRun> {
  const catalog = await walletScenarios(root, options.pack);
  assert(
    Boolean(options.adapter) !== Boolean(options.packetDirectory),
    'Provide a reviewed adapter or retained packet',
  );
  const run: WalletScenarioRun = {
    schemaVersion: 'embertail.wallet-scenario-run/1',
    runtime: 'wallet-component',
    id: randomUUID(),
    status: 'running',
    verdict: 'INCONCLUSIVE',
    agentVerdict: null,
    targetRuntime: options.targetRuntime,
    financialTruth: 'LOCAL EVM',
    scope: 'financial-component',
    taskCorrectness: 'UNKNOWN',
    createdAt: new Date().toISOString(),
    manifest: {
      catalog,
      catalogHash: hash(catalog),
      policy:
        'principal spending cap and native completed-payment claim; fee movements retained separately',
      graderVersion: catalog.some((s) => s.walletChainId)
        ? 'wallet-component/2'
        : 'wallet-component/3',
      packetHash: null,
    },
    manifestHash: '',
    packet: null,
    cases: [],
  };
  const folder = path.join(store.root, 'wallet-runs', run.id);
  const save = async () => {
    run.manifestHash = hash(run.manifest);
    await atomicJson(path.join(folder, 'run.json'), run);
  };
  await save();
  try {
    assert(!options.signal?.aborted, 'Wallet run cancelled');
    const directory =
      options.packetDirectory ??
      (await options.adapter!.execute({ scenarios: catalog, signal: options.signal }));
    const packet = JSON.parse(await readFile(path.join(directory, 'capture.json'), 'utf8'));
    const publicTestnet = options.pack === 'wallet-testnet';
    assert.equal(
      packet.schemaVersion,
      publicTestnet ? 'embertail.wallet-scenario-capture/2' : 'embertail.wallet-scenario-capture/1',
    );
    assert.equal(packet.complete, true);
    assert.equal(packet.runtime, options.targetRuntime);
    assert.equal(packet.modelCalls, 0);
    assert.equal(packet.financialTruth, publicTestnet ? 'PUBLIC TESTNET' : 'LOCAL EVM');
    run.financialTruth = packet.financialTruth;
    if (publicTestnet)
      assert(
        packet.cases.every(
          (c: any) => c.financialTruth === 'PUBLIC TESTNET' && c.chainId === '84532',
        ),
      );
    assert.equal(packet.cases.length, catalog.length);
    assert.equal(new Set(packet.cases.map((c: any) => c.definition.caseId)).size, catalog.length);
    run.packet = packet;
    run.manifest.packetHash = hash(packet);
    run.manifest.sourcePacket = directory;
    run.manifest.nativeVersion = packet.nativeVersion;
    const bus = new EvidenceBus(path.join(folder, 'evidence-bus'), {});
    let normalQualified = false;
    for (const definition of catalog) {
      const c = packet.cases.find((x: any) => x.definition.caseId === definition.caseId);
      assert(c);
      const { scope } = await bus.create({
        runId: run.id,
        taskId: definition.caseId,
        businessIntentId: definition.caseId,
        scenarioId: definition.scenarioId,
        faultRequested: definition.fault,
        policySnapshot: DEFAULT_MANDATE,
        requiredCapabilities: [],
      });
      await bus.append(
        scope.id,
        c.events.map((e: any) => ({
          ...e,
          identity: {
            ...e.identity,
            runId: run.id,
            taskId: definition.caseId,
            businessIntentId: definition.caseId,
          },
        })),
        'native',
      );
      const result = gradeWalletScenario(
        definition,
        await verifyWalletCapture(c, definition),
        String(run.manifest.graderVersion),
      );
      if (definition.rule === 'normal') normalQualified = result.verdict === 'PASS';
      else assert(normalQualified, 'Recorded normal payment did not qualify the fault cases');
      const identity = {
        runId: run.id,
        taskId: definition.caseId,
        businessIntentId: definition.caseId,
        chainId: c.chainId ?? '84532',
      };
      const observedAt = packet.finishedAt;
      const trusted = c.settlements.map((s: any, i: number) => ({
        id: 'independent-receipt-' + i,
        kind: 'financial.settlement' as const,
        identity: { ...identity, transactionHash: s.transactionHash },
        occurredAt: observedAt,
        payload: { status: s.status === 'success' ? 'settled' : s.status, verification: s },
      }));
      trusted.push({
        id: 'independent-before',
        kind: 'financial.state_before' as any,
        identity: identity as any,
        occurredAt: observedAt,
        payload: {
          state: Object.fromEntries(c.balances.map((b: any) => [b.account, b.beforeUnits])),
          window: c.balances[0].window,
        } as any,
      });
      trusted.push({
        id: 'independent-after',
        kind: 'financial.state_after' as any,
        identity: identity as any,
        occurredAt: observedAt,
        payload: {
          state: Object.fromEntries(c.balances.map((b: any) => [b.account, b.afterUnits])),
          window: c.balances[0].window,
        } as any,
      });
      await bus.append(scope.id, trusted, 'verifier', true);
      if (c.counterpart) {
        await bus.append(
          scope.id,
          [
            {
              id: 'independent-counterpart',
              kind: 'verification.snapshot',
              identity: { ...identity, chainId: c.counterpart.chainId },
              occurredAt: observedAt,
              payload: { scope: 'quoted-chain-observation-window', verification: c.counterpart },
            },
          ],
          'verifier',
          true,
        );
      }
      await bus.append(
        scope.id,
        [
          {
            id: 'independent-summary',
            kind: 'verification.snapshot',
            identity: {
              runId: run.id,
              taskId: definition.caseId,
              businessIntentId: definition.caseId,
            },
            occurredAt: packet.finishedAt,
            payload: { scope: 'financial-component', policy: definition, result },
          },
        ],
        'verifier',
        true,
      );
      const journal = await bus.read(scope.id);
      const row = {
        caseId: definition.caseId,
        scenarioId: definition.scenarioId,
        ...result,
        journal,
        canonicalHash: '',
      };
      row.canonicalHash = hash({ ...row, canonicalHash: undefined });
      run.cases.push(row);
      run.verdict = combineVerdicts(run.cases.map((c) => c.verdict));
      await save();
    }
    run.status = 'complete';
  } catch (error) {
    run.status = 'error';
    run.error = error instanceof Error ? error.message : String(error);
    if (run.verdict !== 'FAIL') run.verdict = 'INCONCLUSIVE';
  }
  run.completedAt = new Date().toISOString();
  await save();
  return run;
}
export async function replayWalletScenarioRun(run: WalletScenarioRun) {
  assert.equal(run.status, 'complete');
  assert.equal(
    run.financialTruth,
    run.packet.financialTruth,
    'Run rail differs from retained capture',
  );
  if (run.financialTruth === 'PUBLIC TESTNET') {
    assert.equal(run.packet.schemaVersion, 'embertail.wallet-scenario-capture/2');
    assert(
      run.packet.cases.every(
        (c: any) => c.financialTruth === 'PUBLIC TESTNET' && c.chainId === '84532',
      ),
    );
  } else assert.equal(run.financialTruth, 'LOCAL EVM');
  assert(
    ['wallet-component/1', 'wallet-component/2', 'wallet-component/3'].includes(
      String(run.manifest.graderVersion),
    ),
    'Unsupported wallet grader',
  );
  assert.equal(hash(run.manifest), run.manifestHash);
  assert.equal(hash(run.packet), run.manifest.packetHash);
  const catalog = run.manifest.catalog as WalletScenario[];
  assert.equal(hash(catalog), run.manifest.catalogHash);
  assert.equal(run.cases.length, catalog.length);
  let normalQualified = false;
  for (const row of run.cases) {
    assert.equal(hash({ ...row, canonicalHash: undefined }), row.canonicalHash);
    const definition = catalog.find((s) => s.caseId === row.caseId);
    assert(definition);
    const source = run.packet.cases.find((c: any) => c.definition.caseId === row.caseId);
    assert(source);
    const result = gradeWalletScenario(
      definition,
      await verifyWalletCapture(source, definition),
      String(run.manifest.graderVersion),
    );
    if (definition.rule === 'normal') normalQualified = result.verdict === 'PASS';
    else assert(normalQualified, 'Replay normal qualification failed');
    for (const [key, value] of Object.entries(result)) assert.deepEqual((row as any)[key], value);
    let previous: null | string = null;
    for (const [i, event] of row.journal.events.entries()) {
      const { hash: digest, ...base } = event;
      assert.equal(hash(base), digest);
      assert.equal(event.previousHash, previous);
      assert.equal(event.sequence, i + 1);
      previous = digest;
    }
  }
  assert.equal(run.verdict, combineVerdicts(run.cases.map((c) => c.verdict)));
  return {
    verified: true,
    cases: run.cases.length,
    caseHashes: Object.fromEntries(run.cases.map((c) => [c.caseId, c.canonicalHash])),
    limitations: [
      'Financial component checks only; no autonomous agent/task verdict.',
      'Offline retained-RPC replay, not a fresh public-chain verification.',
    ],
  };
}
