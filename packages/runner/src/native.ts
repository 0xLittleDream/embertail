import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hash, clone, type Json } from '../../contracts/src/index.js';
import type {
  NativeCaseResult,
  NativeFacts,
  NativePacket,
  NativeRun,
  NativeScenario,
} from '../../contracts/src/native.js';
import { EvidenceBus } from '../../evidence-bus/src/bus.js';
import { assessCoverage } from '../../evidence-bus/src/contract.js';
import type { EvidenceInput, EvidenceScope } from '../../evidence-bus/src/types.js';
import {
  gradeNativeCase,
  nativePolicy,
  nativeRunVerdict,
  canonicalNativeCaseHash,
} from '../../grading/src/native.js';
import { verifyNativePacket, nativeRail } from '../../verifiers/src/native.js';
import { Store } from './store.js';

export type NativeRunOptions = {
  runtime: 'native-component';
  pack?: string;
  targetRuntime?: 'head' | 'release';
  financialNetwork?: 'local' | 'base-sepolia';
  /** A reviewed native adapter writes an immutable capture; callers cannot supply tool claims as truth. */
  adapter?: { execute(context: { caseIds: string[]; signal?: AbortSignal }): Promise<string> };
  packetDirectory?: string;
  signal?: AbortSignal;
  onProgress?: (run: NativeRun) => Promise<void>;
};
export async function nativeScenarios(root: string): Promise<NativeScenario[]> {
  const rows = JSON.parse(
    await readFile(path.join(root, 'fixtures/native-finance-v1/scenarios.json'), 'utf8'),
  ) as NativeScenario[];
  assert(
    Array.isArray(rows) &&
      rows.length > 0 &&
      new Set(rows.map((s) => s.caseId)).size === rows.length,
  );
  for (const s of rows) {
    assert(/^[a-z0-9-]+$/.test(s.caseId) && /^S\d{2}$/.test(s.scenarioId));
    assert.equal(s.configuration.id, s.caseId);
    assert(Number.isSafeInteger(s.configuration.count) && s.configuration.count > 0);
    if (s.configuration.cap !== undefined)
      assert(Number.isSafeInteger(s.configuration.cap) && s.configuration.cap >= 0);
  }
  return rows;
}
export function selectNativeScenarios(catalog: NativeScenario[], pack: string): NativeScenario[] {
  const regression = [
    'claw-normal',
    'claw-strict-serial',
    'claw-strict-concurrent',
    'claw-strict-lost-502',
    'claw-wallet-concurrent',
    'claw-strict-lost-502-wallet-cap',
  ];
  const selected =
    pack === 'native' || pack === 'all'
      ? catalog
      : catalog.filter((s) =>
          pack === 'clawrouter-regression'
            ? regression.includes(s.caseId)
            : s.scenarioId === pack || s.caseId === pack || s.configuration.target === pack,
        );
  if (!selected.length) throw Error('Unknown native scenario pack');
  // Qualification is a real payment executed before each target's fault cases.
  const targets = new Set(selected.map((s) => s.configuration.target));
  return catalog.filter(
    (s) =>
      selected.includes(s) ||
      (s.configuration.scenario === 'control' && targets.has(s.configuration.target)),
  );
}
export async function readNativePacket(directory: string): Promise<NativePacket> {
  const read = async (name: string) =>
    JSON.parse(await readFile(path.join(directory, name), 'utf8')) as Json;
  const packet = {
    evidence: await read('evidence.json'),
    artifact: await read('token-artifact.json'),
    sourceManifest: await read('source-manifest.json'),
  };
  const manifest = packet.sourceManifest as { files?: Record<string, string> };
  assert(
    manifest.files && Object.keys(manifest.files).length > 0,
    'Retained source manifest missing',
  );
  for (const [name, expected] of Object.entries(manifest.files)) {
    const target = path.resolve(directory, 'sources', name);
    assert(
      target.startsWith(path.resolve(directory, 'sources') + path.sep),
      'Invalid retained source path',
    );
    assert(/^[a-f0-9]{64}$/.test(expected));
    assert.equal(
      createHash('sha256')
        .update(await readFile(target))
        .digest('hex'),
      expected,
      'Retained source bytes changed: ' + name,
    );
  }
  return packet;
}
function inputs(
  scope: EvidenceScope,
  s: NativeScenario,
  f: NativeFacts,
  packet: NativePacket,
): { observed: EvidenceInput[]; authoritative: EvidenceInput[] } {
  const raw: any = packet.evidence;
  const c = raw.cases.find((c: any) => c.id === s.caseId);
  const identity = {
    runId: scope.runId,
    taskId: scope.taskId,
    businessIntentId: scope.businessIntentId,
  };
  const event = (
    id: string,
    kind: EvidenceInput['kind'],
    payload: unknown,
    extra = {},
  ): EvidenceInput => ({
    id,
    kind,
    payload: payload as Json,
    identity: { ...identity, ...extra },
    occurredAt: raw.finishedAt,
  });
  const observed: EvidenceInput[] = c.attempts.flatMap((a: any, i: number) => [
    event(
      'caller-' + i,
      'tool.call',
      {
        name: c.mode === 'proxy' ? 'ClawRouter POST chat/completions' : 'native payment fetch',
        obligation: a.obligation,
        caller: 'explicit business caller',
      },
      { toolCallId: 'frontend-' + i },
    ),
    event(
      'response-' + i,
      'tool.result',
      { status: a.status ?? null, error: a.error ?? null, body: a.response ?? null },
      { toolCallId: 'frontend-' + i },
    ),
  ]);
  observed.push(
    event('boundary', 'control.boundary', {
      paymentPath: c.mode,
      enforcement: 'code-enforced',
      detail:
        'Native component invocation; no autonomous agent decision loop or model-generated claim.',
      policy: nativePolicy(s),
    }),
  );
  const authoritative = [
    event('before', 'financial.state_before', {
      state: c.before,
      block: c.blockWindow.before,
      authority:
        raw.financialTruth === 'PUBLIC TESTNET'
          ? 'independent historical public-testnet balance reads'
          : 'independent historical local-chain balance reads',
    }),
    event('after', 'financial.state_after', {
      state: c.after,
      block: c.blockWindow.after,
      authority:
        raw.financialTruth === 'PUBLIC TESTNET'
          ? 'independent historical public-testnet balance reads'
          : 'independent historical local-chain balance reads',
    }),
    event('binding', 'intent.binding', {
      componentCase: s.caseId,
      obligations: [...new Set(c.attempts.map((a: any) => a.obligation))],
      policy: nativePolicy(s),
    }),
    event('requested', 'fault.requested', { type: f.faultRequested }),
  ];
  for (const [i, tx] of f.transactions.entries()) {
    const extra = {
      financialActionId: tx.hash,
      transactionHash: tx.hash,
      chainId: nativeRail(raw).chainId,
      retryOfActionId: tx.retryOf,
    };
    authoritative.push(
      event(
        'action-' + i,
        'financial.action',
        {
          kind: 'transfer',
          asset: c.token,
          amountUnits: tx.amountUnits,
          recipient: raw.addresses.seller,
          rail:
            raw.financialTruth === 'PUBLIC TESTNET' ? 'public-testnet-evm' : 'isolated-local-evm',
          obligationId: tx.obligationId,
        },
        extra,
      ),
    );
    authoritative.push(
      event(
        'settled-' + i,
        'financial.settlement',
        { status: 'settled', transactionHash: tx.hash, verification: c.settlements[i].verified },
        extra,
      ),
    );
  }
  for (const [i, fault] of c.faults.entries())
    authoritative.push(
      event('fault-' + i, 'fault.delivered', {
        type: fault.type,
        delivered: true,
        transactionHash: fault.transactionHash,
        evidenceIds: [
          'settled-' + f.transactions.findIndex((t) => t.hash === fault.transactionHash),
        ],
      }),
    );
  for (const [i, task] of f.taskStates.entries())
    authoritative.push(event('task-' + i, 'task.observed_state', task));
  for (const missing of f.missing)
    authoritative.push(event('missing-' + missing, 'evidence.missing', { fields: [missing] }));
  authoritative.push(
    event('complete', 'capture.complete', {
      nativeRequestsCaptured: c.requests.length,
      signedActionsCaptured: f.transactions.length,
      absenceScope: 'isolated network and signer; registered native component workflow',
      fullAgentCapture: false,
    }),
  );
  return { observed, authoritative };
}
export async function executeNativeRun(
  options: NativeRunOptions,
  store: Store,
  root: string,
  sourceHashes: Record<'runtimeHash' | 'graderHash' | 'verifierHash' | 'contractsHash', string>,
): Promise<NativeRun> {
  const catalog = await nativeScenarios(root),
    selected = selectNativeScenarios(catalog, options.pack ?? 'native');
  if (Boolean(options.adapter) === Boolean(options.packetDirectory))
    throw Error('Provide one native adapter or retained packet directory');
  const run: NativeRun = {
    schemaVersion: 'embertail.native-run/1',
    runtime: 'native-component',
    id: randomUUID(),
    status: 'running',
    createdAt: new Date().toISOString(),
    pack: options.pack ?? 'native',
    targetRuntime: options.targetRuntime ?? 'head',
    provenance: options.adapter ? 'live-execution' : 'retained-evidence-regrade',
    verdict: 'INCONCLUSIVE',
    agentVerdict: null,
    manifest: {
      financialTruth: options.financialNetwork === 'base-sepolia' ? 'PUBLIC TESTNET' : 'LOCAL EVM',
      network:
        options.financialNetwork === 'base-sepolia'
          ? 'Base Sepolia; public testnet with fixture test tokens'
          : 'Isolated Ganache; compatibility chain ID, not public Base',
      chainId: options.financialNetwork === 'base-sepolia' ? '84532' : '8453',
      scope: 'financial-component',
      agentDecisionLoop: false,
      catalogHash: hash(catalog),
      policyHash: hash(selected.map(nativePolicy)),
      packetHash: null,
      ...sourceHashes,
      targetVersions: {},
      sourcePacket: options.packetDirectory ?? 'live adapter',
      sourceFiles: 0,
      sourceManifestHash: null,
      limitations: [
        'Controlled merchant, facilitator and deployed test token; no production gateway or assets.',
        'Explicit business caller; no autonomous LLM decision loop or agent verdict.',
        'Release-suite proxy cases use the unmodified npm bundle; preauthorization cases use the pinned source helper. Standalone x402 cases use the published SDK packages.',
        'Native budget and retry behavior retained. Documented skipBalanceCheck testing option bypasses production balance endpoint; independent local balances are read.',
        'Task state comes from an explicit controlled merchant adapter, not a customer production system.',
        'Offline replay checks retained RPC observations and signatures; it does not authenticate the original evidence producer or query the chain again.',
      ],
    },
    manifestHash: '',
    cases: [],
    packet: null,
  };
  const checkpoint = async () => {
    run.manifestHash = hash(run.manifest);
    await store.saveNativeRun(run);
    await options.onProgress?.(clone(run));
  };
  await checkpoint();
  try {
    if (options.signal?.aborted) throw Error('Native run cancelled before execution');
    const directory =
      options.packetDirectory ??
      (await options.adapter!.execute({
        caseIds: selected.map((s) => s.caseId),
        signal: options.signal,
      }));
    run.manifest.sourcePacket = directory;
    const packet = await readNativePacket(directory);
    const facts = await verifyNativePacket(packet, catalog);
    const raw: any = packet.evidence;
    const rail = nativeRail(raw);
    if (options.adapter)
      assert.equal(
        rail.chainId,
        run.manifest.chainId,
        'Adapter executed on an unexpected financial rail',
      );
    run.manifest.financialTruth = rail.financialTruth;
    run.manifest.chainId = rail.chainId;
    run.manifest.network = raw.network;
    if (rail.financialTruth === 'PUBLIC TESTNET')
      run.manifest.limitations = run.manifest.limitations.map((l) =>
        l.replace(
          'independent local balances are read',
          'independent public-chain balances are read through a separate RPC endpoint',
        ),
      );
    const wanted = new Set(selected.map((s) => s.caseId));
    assert(
      raw.cases.every((c: any) => wanted.has(c.id)),
      'Packet contains cases outside the selected pack',
    );
    assert.equal(raw.cases.length, selected.length, 'Selected native cases missing');
    run.packet = packet;
    run.manifest.packetHash = hash(packet);
    run.manifest.sourceManifestHash = hash(packet.sourceManifest);
    run.manifest.sourceFiles = Object.keys((packet.sourceManifest as any).files).length;
    run.targetRuntime = Object.keys((packet.sourceManifest as any).files).some((name) =>
      name.endsWith('clawrouter-release/dist/index.js'),
    )
      ? 'release'
      : 'head';
    run.manifest.targetVersions = Object.fromEntries(
      raw.cases.map((c: any) => [c.target, c.nativeVersion]),
    );
    const bus = new EvidenceBus(path.join(store.nativeRunDir(run.id), 'evidence-bus'), {});
    for (const s of selected) {
      const f = facts.get(s.caseId)!;
      const { scope } = await bus.create({
        runId: run.id,
        taskId: s.caseId,
        businessIntentId: s.caseId,
        scenarioId: s.scenarioId,
        faultRequested: f.faultRequested,
        policySnapshot: nativePolicy(s),
        requiredCapabilities: ['native-financial-component', 'independent-evm'],
        binding: { runId: run.id, caseId: s.caseId },
      });
      const events = inputs(scope, s, f, packet);
      await bus.append(scope.id, events.observed, 'native');
      await bus.append(scope.id, events.authoritative, 'verifier', true);
      const journal = await bus.read(scope.id);
      const graded = gradeNativeCase(s, f, journal.assessment, rail.financialTruth);
      const c: NativeCaseResult = {
        caseId: s.caseId,
        scenarioId: s.scenarioId,
        title: s.title,
        family: s.family,
        scenario: s,
        evaluation: s.evaluation,
        facts: f,
        ...graded,
        coverage: journal.assessment,
        evidenceScope: scope,
        evidence: journal.events,
        evidenceHash: hash(journal.events),
        canonicalResultHash: '',
      };
      c.assertions.forEach(
        (a) =>
          (a.evidenceSeqs = journal.events
            .filter((e) =>
              [
                'financial.settlement',
                'fault.delivered',
                'task.observed_state',
                'tool.result',
              ].includes(e.kind),
            )
            .map((e) => e.sequence)),
      );
      c.canonicalResultHash = canonicalNativeCaseHash(c);
      run.cases.push(c);
      run.verdict = nativeRunVerdict(run.cases);
      await checkpoint();
    }
    run.status = 'complete';
  } catch (e) {
    run.status = options.signal?.aborted ? 'cancelled' : 'error';
    run.error = e instanceof Error ? e.message : String(e);
    if (run.verdict !== 'FAIL') run.verdict = 'INCONCLUSIVE';
  }
  run.completedAt = new Date().toISOString();
  await checkpoint();
  return run;
}
export async function replayNativeRun(run: NativeRun) {
  assert.equal(run.status, 'complete', 'Incomplete native runs cannot reproduce a complete result');
  assert.equal(hash(run.manifest), run.manifestHash, 'Native manifest integrity mismatch');
  assert(run.packet);
  const rail = nativeRail(run.packet.evidence);
  assert.equal(
    run.manifest.chainId,
    rail.chainId,
    'Manifest rail differs from retained chain evidence',
  );
  assert.equal(run.manifest.financialTruth, rail.financialTruth);
  assert.equal(hash(run.packet), run.manifest.packetHash, 'Native packet integrity mismatch');
  assert.equal(hash(run.packet.sourceManifest), run.manifest.sourceManifestHash);
  assert.equal(hash(run.cases.map((c) => nativePolicy(c.scenario))), run.manifest.policyHash);
  const facts = await verifyNativePacket(
    run.packet,
    run.cases.map((c) => c.scenario),
  );
  const caseHashes: Record<string, string> = {};
  for (const c of run.cases) {
    assert.equal(
      canonicalNativeCaseHash(c),
      c.canonicalResultHash,
      'Stored native grading integrity mismatch',
    );
    assert.equal(hash(c.evidence), c.evidenceHash);
    let previous: string | null = null;
    for (const [i, e] of c.evidence.entries()) {
      const { hash: digest, ...base } = e;
      assert.equal(e.sequence, i + 1);
      assert.equal(e.previousHash, previous);
      assert.equal(hash(base), digest);
      assert.equal(e.identity.runId, run.id);
      assert.equal(e.identity.taskId, c.caseId);
      assert.equal(e.identity.businessIntentId, c.caseId);
      previous = digest;
    }
    const coverage = assessCoverage(c.evidenceScope, c.evidence),
      f = facts.get(c.caseId)!;
    const raw: any = (run.packet.evidence as any).cases.find((x: any) => x.id === c.caseId);
    assert.equal(
      hash(c.evidenceScope.policySnapshot),
      hash(nativePolicy(c.scenario)),
      'Journal policy differs from canonical policy',
    );
    assert.equal(c.evidenceScope.runId, run.id);
    assert.equal(c.evidenceScope.taskId, c.caseId);
    assert.equal(c.evidenceScope.businessIntentId, c.caseId);
    assert.equal(c.evidenceScope.scenarioId, c.scenarioId);
    assert.equal(c.evidenceScope.faultRequested, f.faultRequested);
    const actions = c.evidence.filter((e) => e.kind === 'financial.action');
    const settlements = c.evidence.filter((e) => e.kind === 'financial.settlement');
    assert.equal(actions.length, f.transactions.length);
    assert.equal(settlements.length, f.transactions.length);
    const actionIds = new Map<string, string>();
    for (const [i, t] of f.transactions.entries()) {
      const action = actions[i]!,
        payload: any = action.payload;
      assert.equal(action.trust, 'authoritative');
      assert.equal(payload.kind, 'transfer');
      assert.equal(payload.asset, raw.token);
      assert.equal(payload.amountUnits, t.amountUnits);
      assert.equal(payload.obligationId, t.obligationId);
      assert.equal(payload.recipient, (run.packet.evidence as any).addresses.seller);
      assert.equal(action.identity.chainId, rail.chainId);
      assert(action.identity.financialActionId);
      assert.equal(
        action.identity.retryOfActionId,
        t.retryOf === null ? null : actionIds.get(t.retryOf),
        'Journal retry lineage differs from independently bound actions',
      );
      actionIds.set(t.hash, action.identity.financialActionId);
      const settled = settlements.find(
        (e) => e.identity.financialActionId === action.identity.financialActionId,
      );
      assert(settled);
      assert.equal(settled.trust, 'authoritative');
      const receipt: any = settled.payload;
      assert.equal(receipt.transactionHash, t.hash);
      assert.equal(receipt.status, 'settled');
      assert.equal(receipt.verification.transactionHash, t.hash);
      assert.equal(receipt.verification.status, 'success');
      assert.equal(receipt.verification.transfers[0].amountUnits, t.amountUnits);
    }
    for (const [kind, state] of [
      ['financial.state_before', raw.before],
      ['financial.state_after', raw.after],
    ]) {
      const event = c.evidence.find((e) => e.kind === kind);
      assert(event && event.trust === 'authoritative');
      assert.equal(
        hash((event.payload as any).state),
        hash(state),
        'Journal balances differ from independently read state',
      );
      assert.equal(
        String((event.payload as any).block.number),
        kind === 'financial.state_before' ? String(raw.beforeBlock) : String(raw.afterBlock),
        'Journal block boundary differs from observed window',
      );
    }
    const tasks = c.evidence.filter((e) => e.kind === 'task.observed_state');
    assert.equal(tasks.length, f.taskStates.length);
    for (const [i, task] of f.taskStates.entries())
      assert.equal(
        hash(tasks[i]!.payload),
        hash(task),
        'Journal task state differs from adapter observation',
      );
    const delivered = c.evidence.filter((e) => e.kind === 'fault.delivered');
    assert.equal(delivered.length, raw.faults.length);
    for (const [i, fault] of raw.faults.entries()) {
      const p: any = delivered[i]!.payload;
      assert.equal(delivered[i]!.trust, 'authoritative');
      assert.equal(p.type, fault.type);
      assert.equal(p.delivered, true);
      const index = f.transactions.findIndex((t) => t.hash === fault.transactionHash);
      assert.deepEqual(
        p.evidenceIds,
        ['settled-' + index],
        'Journal fault reference differs from verified settlement',
      );
    }
    assert.equal(hash(f), hash(c.facts), 'Native independently reconstructed facts changed');
    assert.equal(hash(coverage), hash(c.coverage));
    const graded = gradeNativeCase(c.scenario, f, coverage, rail.financialTruth);
    graded.assertions.forEach(
      (a) =>
        (a.evidenceSeqs = c.evidence
          .filter((e) =>
            [
              'financial.settlement',
              'fault.delivered',
              'task.observed_state',
              'tool.result',
            ].includes(e.kind),
          )
          .map((e) => e.sequence)),
    );
    const regenerated = { ...c, ...graded };
    assert.equal(
      canonicalNativeCaseHash(regenerated),
      c.canonicalResultHash,
      'Native grading replay differs',
    );
    caseHashes[c.caseId] = c.canonicalResultHash;
  }
  assert.equal(nativeRunVerdict(run.cases), run.verdict);
  return {
    verified: true,
    mode: 'OFFLINE',
    cases: run.cases.length,
    signedTransactions: run.cases.reduce((n, c) => n + c.facts.transactions.length, 0),
    caseHashes,
    agentVerdict: null,
    limitations: run.manifest.limitations,
  };
}
