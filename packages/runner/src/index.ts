import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  CAPABILITIES,
  GRADING_SEMANTICS,
  RECORDED_GRADING_SEMANTICS,
  RUN_SCHEMA_VERSION,
  assertMandate,
  clone,
  combineVerdicts,
  fromUsd,
  hash,
  initialState,
  isAmbiguousResponse,
  units,
  type CaseResult,
  type EvidenceEvent,
  type Mandate,
  type Profile,
  type Project,
  type Run,
  type Scenario,
  type ScenarioCase,
} from '../../contracts/src/index.js';
import {
  FinancialEnvironment,
  SIMULATION_SEMANTICS,
  TOOL_DRIVEN_PROGRESSION,
} from '../../engine/src/environment.js';
import { LegacyFinancialEnvironment } from '../../engine/src/legacy-environment.js';
import { LEGACY_PACKAGE_NAME } from '../../contracts/src/legacy.js';
import { promotionFaultEvidence } from '../../contracts/src/promotion.js';
import { canonicalCaseHash, gradeCase } from '../../grading/src/index.js';
import { applyEvidenceContract } from '../../evidence-bus/src/recorded.js';
import { AdapterCleanupError, SimulatedAgentCrash, runAdapter, type Adapter } from './connector.js';
import { Store } from './store.js';
export { Store } from './store.js';
import { executeNativeRun, replayNativeRun, type NativeRunOptions } from './native.js';
import type { NativeRun } from '../../contracts/src/native.js';
export { nativeScenarios, selectNativeScenarios } from './native.js';
export type { NativeRunOptions } from './native.js';
import {
  executeWalletScenarioRun,
  replayWalletScenarioRun,
  type WalletScenarioOptions,
  type WalletScenarioRun,
} from './wallet-scenarios.js';
export { walletScenarios } from './wallet-scenarios.js';
export type { WalletScenarioOptions, WalletScenarioRun } from './wallet-scenarios.js';
/** The installable Money Check package (scripts/package-money-check.mjs) is a root too. */
export const MONEY_CHECK_PACKAGE_NAME = 'embertail-check';
/**
 * Source hashes fixed when the Money Check package is bundled, keyed like the directories
 * `directorySourceHash` reads ('dist/packages/engine', ..., 'package-lock.json'). The bundle
 * carries no source tree to hash, so the build records the hashes of the sources it was built
 * from. Undefined everywhere else, where the directories are hashed as before.
 */
declare const __EMBERTAIL_BUNDLED_SOURCE_HASHES__: Record<string, string> | undefined;
const bundledSourceHashes: Record<string, string> | undefined =
  typeof __EMBERTAIL_BUNDLED_SOURCE_HASHES__ === 'undefined'
    ? undefined
    : __EMBERTAIL_BUNDLED_SOURCE_HASHES__;
let cachedRoot: string | undefined;
export async function repoRoot(): Promise<string> {
  if (cachedRoot) return cachedRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    try {
      const p = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as {
        name?: string;
      };
      if (
        p.name === 'embertail' ||
        p.name === LEGACY_PACKAGE_NAME ||
        (bundledSourceHashes !== undefined && p.name === MONEY_CHECK_PACKAGE_NAME)
      ) {
        cachedRoot = dir;
        return dir;
      }
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('EmberTail repository root not found');
    dir = parent;
  }
}
export async function scenarios(): Promise<Scenario[]> {
  const items = JSON.parse(
    await readFile(
      path.join(await repoRoot(), 'fixtures', 'local-finance-v1', 'scenarios.json'),
      'utf8',
    ),
  ) as Scenario[];
  if (!items.length || new Set(items.map((s) => s.id)).size !== items.length)
    throw new Error('Scenario catalog must contain distinct definitions');
  for (const s of items) {
    if (
      !/^S\d{2}$/.test(s.id) ||
      !s.title ||
      !Array.isArray(s.requiredCapabilities) ||
      typeof s.humanApproval !== 'boolean'
    )
      throw new Error('Invalid trusted scenario fixture');
    units(s.amountUsdMinor);
    if (
      s.paymentBatch &&
      (!Number.isSafeInteger(s.paymentBatch.count) ||
        s.paymentBatch.count < 1 ||
        s.paymentBatch.count > 24 ||
        units(s.paymentBatch.eachUsdMinor) * BigInt(s.paymentBatch.count) !==
          units(s.amountUsdMinor))
    )
      throw new Error('Invalid trusted payment batch');
    if (
      s.swapWorkflow &&
      (s.task !== 'authorize' ||
        !s.swapWorkflow.contract ||
        !['SIM_USDC', 'SIM_ETH', 'SIM_NVDA'].includes(s.swapWorkflow.fromAssetId) ||
        !['SIM_USDC', 'SIM_ETH', 'SIM_NVDA'].includes(s.swapWorkflow.toAssetId))
    )
      throw new Error('Invalid trusted swap workflow');
    const reply = s.ambiguousReply;
    const variants = reply?.responseVariants;
    if (
      s.fault === 'ambiguous-reply' &&
      (reply === undefined || (reply.response === undefined) === (variants === undefined))
    )
      throw new Error('An ambiguous-reply scenario needs exactly one reply or reply variant list');
    if (
      reply &&
      ((variants !== undefined && (!variants.length || !reply.pairGroup)) ||
        (reply.pairGroup !== undefined && variants === undefined) ||
        (reply.onAction !== undefined &&
          (!Number.isSafeInteger(reply.onAction) ||
            reply.onAction < 1 ||
            s.fault !== 'ambiguous-reply')) ||
        (reply.refusedForMs !== undefined &&
          (reply.outcome === 'in-flight' ||
            !Number.isSafeInteger(reply.refusedForMs) ||
            reply.refusedForMs < 1)))
    )
      throw new Error('Invalid ambiguous reply variants, action or refusal window');
    if (
      (s.requestIds !== undefined && !['honoured', 'ignored'].includes(s.requestIds)) ||
      (s.lookup !== undefined && !['accurate', 'none'].includes(s.lookup)) ||
      (s.transportRedelivery !== undefined &&
        (s.fault !== 'redelivery' || s.requestIds === 'ignored'))
    )
      throw new Error('Invalid request-ID policy, look-up or redelivery setting');
    if (
      (s.agentRestart !== undefined) !== (s.fault === 'agent-restart') ||
      (s.agentRestart !== undefined &&
        !['settled', 'not-executed'].includes(s.agentRestart.outcome)) ||
      (s.priorPayments !== undefined &&
        (s.fault !== 'prior-payment' ||
          !s.priorPayments.length ||
          s.priorPayments.some(
            (p) =>
              !['same', 'other'].includes(p.invoice) ||
              !/^[1-9]\d*$/.test(p.amountUsdMinor) ||
              !p.recipient ||
              !p.requestId,
          ))) ||
      (s.transferFeeBps !== undefined &&
        (s.fault !== 'transfer-fee' ||
          !Number.isSafeInteger(s.transferFeeBps) ||
          s.transferFeeBps < 1 ||
          s.transferFeeBps > 5000)) ||
      (s.requestIdTtlMs !== undefined &&
        (!Number.isSafeInteger(s.requestIdTtlMs) ||
          s.requestIdTtlMs < 1 ||
          s.requestIds === 'ignored'))
    )
      throw new Error('Invalid restart, earlier-payment or transfer-fee setting');
    if (
      reply &&
      ((reply.response === undefined && variants === undefined) ||
        !['ambiguous-reply', 'commit-timeout', 'ambiguous-budget-release'].includes(s.fault) ||
        !['settled', 'not-executed', 'in-flight'].includes(reply.outcome) ||
        (s.fault !== 'ambiguous-reply' &&
          (reply.outcome !== 'settled' ||
            reply.statusLagMs !== undefined ||
            reply.persistent !== undefined)) ||
        (reply.persistent !== undefined && reply.outcome !== 'not-executed') ||
        (reply.outcome === 'in-flight') !== (reply.landsAfterMs !== undefined) ||
        (reply.landsAfterMs !== undefined &&
          (!Number.isSafeInteger(reply.landsAfterMs) || reply.landsAfterMs < 1)) ||
        (reply.statusLagMs !== undefined &&
          (reply.outcome === 'in-flight' ||
            !Number.isSafeInteger(reply.statusLagMs) ||
            reply.statusLagMs < 1)))
    )
      throw new Error('Invalid ambiguous reply');
    if (
      (s.role !== undefined && !['control', 'platform-check'].includes(s.role)) ||
      (s.controlParameters !== undefined &&
        s.controlParameters.some((p) => !(s.parameters ?? []).includes(p))) ||
      (s.stimulusVariants !== undefined && (s.stimulus !== undefined || !s.stimulusVariants.length))
    )
      throw new Error('Invalid scenario role, control parameters or stimulus variants');
  }
  return items;
}
/** Seeded choice of one of n alternatives for a case: stable for a seed, varies across seeds. */
export function seededIndex(seed: string, caseId: string, n: number): number {
  return Number(
    BigInt('0x' + hash({ seed, caseId, purpose: 'stimulus' }).slice(0, 12)) % BigInt(n),
  );
}
/** Scenarios added to the core pack by the `incidents` pack. */
export const INCIDENT_PACK = ['S16', 'S56', 'S57', 'S65'];

export function expandCases(
  catalog: Scenario[],
  pack: string,
  capitalUsdMinor: string,
  seed: string,
): ScenarioCase[] {
  const selected =
    pack === 'milestone'
      ? catalog.filter((s) => ['S01', 'S19', 'S23'].includes(s.id))
      : pack === 'core'
        ? catalog.filter((s) => s.core)
        : pack === 'promoted'
          ? catalog.filter((s) => ['S25', 'S26', 'S27', 'S28'].includes(s.id))
          : pack === 'incidents'
            ? // The core pack plus the scenarios that match 2025-26 incident patterns: a budget
              // across many small payments (S16), splitting under a per-payment cap (S65), and a
              // crash and restart mid-payment (S56, S57). See docs/money-check.md.
              catalog.filter((s) => s.core || INCIDENT_PACK.includes(s.id))
            : pack === 'full'
              ? catalog
              : // A comma-separated list of scenario IDs, for campaigns ("S19,S37").
                catalog.filter((s) => pack.split(',').includes(s.id));
  if (!selected.length) throw new Error('Unknown or empty scenario pack');
  return selected.flatMap((s) =>
    (s.parameters ?? [s.amountUsdMinor]).map((amount) => {
      const state = initialState(capitalUsdMinor);
      if (s.fault === 'reserve') {
        state.balances.SIM_USDC = fromUsd(((units(capitalUsdMinor) * 42n) / 100n).toString());
        state.balances.SIM_ETH = fromUsd(
          ((units(capitalUsdMinor) * 58n) / 100n).toString(),
          'SIM_ETH',
        );
      }
      if (s.fault === 'insufficient') state.balances.SIM_USDC = fromUsd('10000');
      const caseId = s.parameters ? `${s.id}-${amount}` : s.id;
      const businessIntentId = `intent-${hash({ seed, caseId }).slice(0, 24)}`;
      // Payments someone else made before the task (S58, S59): already settled, one block in.
      for (const [i, prior] of (s.priorPayments ?? []).entries()) {
        const amountUnits = fromUsd(prior.amountUsdMinor);
        state.balances.SIM_USDC = (
          units(state.balances.SIM_USDC ?? '0') - units(amountUnits)
        ).toString();
        const account = (state.recipients[prior.recipient] ??= {});
        account.SIM_USDC = (units(account.SIM_USDC ?? '0') + units(amountUnits)).toString();
        state.transactions.push({
          id: `prior-${i + 1}`,
          requestId: prior.requestId,
          businessIntentId:
            prior.invoice === 'same'
              ? businessIntentId
              : `intent-${hash({ seed, caseId, prior: i }).slice(0, 24)}`,
          action: {
            kind: 'transfer',
            requestId: prior.requestId,
            assetId: 'SIM_USDC',
            amountUnits,
            recipient: prior.recipient,
          },
          status: 'settled',
          usdMinor: prior.amountUsdMinor,
          virtualTimeMs: 0,
          lifecycle: {
            version: 'embertail.simulated-chain/1',
            inclusionBlock: '1',
            observedHead: '1',
            receiptStatus: 'success',
            confirmations: '1',
            minConfirmations: '1',
            acceptance: 'accepted',
          },
        });
      }
      const { stimulusVariants, controlParameters, ...definition } = clone(s);
      // Reply wording chosen by seed; partners share the pick, so their replies stay identical.
      if (definition.ambiguousReply?.responseVariants) {
        const { responseVariants, ...rest } = definition.ambiguousReply;
        definition.ambiguousReply = {
          ...rest,
          response:
            responseVariants[seededIndex(seed, rest.pairGroup ?? caseId, responseVariants.length)]!,
        };
      }
      const role = controlParameters?.includes(amount) ? 'control' : definition.role;
      return {
        ...definition,
        // The seed now changes what the agent reads, not only identifiers. The chosen text
        // is recorded in the case, so replay and reports show exactly what was served.
        ...(stimulusVariants
          ? { stimulus: stimulusVariants[seededIndex(seed, caseId, stimulusVariants.length)] }
          : {}),
        ...(role ? { role } : {}),
        amountUsdMinor: amount,
        caseId,
        businessIntentId,
        seed: `${seed}:${caseId}`,
        authorizedUsdMinor: s.task === 'defer' ? '0' : amount,
        initialState: state,
      };
    }),
  );
}
export async function defaultAdapter(): Promise<Adapter> {
  const root = await repoRoot();
  const compiled = import.meta.url.includes('/dist/');
  return {
    name: 'EmberTail Treasury Agent Demo',
    version: '0.1.0',
    command: process.execPath,
    args: compiled
      ? [path.join(root, 'dist/examples/treasury-demo/agent.js')]
      : ['--import', 'tsx', path.join(root, 'examples/treasury-demo/agent.ts')],
    capabilities: CAPABILITIES,
  };
}
export async function directorySourceHash(root: string, relative: string): Promise<string> {
  const bundled = bundledSourceHashes?.[relative.split(path.sep).join('/')];
  if (bundled !== undefined) return bundled;
  const dir = path.join(root, relative);
  const entries = await readdir(dir, { withFileTypes: true });
  const values: Record<string, string> = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) values[entry.name] = await directorySourceHash(root, name);
    else if (/\.(ts|js|json)$/.test(entry.name))
      values[entry.name] = hash(await readFile(path.join(root, name), 'utf8'));
  }
  return hash(values);
}
export type RunOptions = {
  /** Trusted service identity; never taken from an adapter message. */
  id?: string;
  project: Project;
  profile: Profile;
  /**
   * Platform guard in the simulated environment, independent of the agent profile.
   * 'reference' enforces only hard mandate limits; 'strict' also blocks budget, intent,
   * recipient, reserve and approval violations before they execute. Default: reference,
   * so the built-in profiles differ only in agent behaviour.
   */
  guard?: 'reference' | 'strict';
  pack: string;
  seed?: string;
  adapter?: Adapter;
  signal?: AbortSignal;
  onProgress?: (run: Run) => Promise<void>;
  executeCase?: (
    adapter: Adapter,
    environment: FinancialEnvironment,
    profile: Profile,
    signal?: AbortSignal,
  ) => Promise<string[]>;
};
export function executeRun(options: NativeRunOptions, store: Store): Promise<NativeRun>;
export function executeRun(
  options: WalletScenarioOptions,
  store: Store,
): Promise<WalletScenarioRun>;
export function executeRun(options: RunOptions, store: Store): Promise<Run>;
export async function executeRun(
  options: RunOptions | NativeRunOptions | WalletScenarioOptions,
  store: Store,
): Promise<Run | NativeRun | WalletScenarioRun> {
  if ('runtime' in options && options.runtime === 'wallet-component')
    return executeWalletScenarioRun(options, store, await repoRoot());
  if ('runtime' in options && options.runtime === 'native-component') {
    const root = await repoRoot(),
      prefix = import.meta.url.includes('/dist/') ? 'dist/' : '';
    return executeNativeRun(options, store, root, {
      runtimeHash: await directorySourceHash(root, prefix + 'packages/runner'),
      graderHash: await directorySourceHash(root, prefix + 'packages/grading'),
      verifierHash: await directorySourceHash(root, prefix + 'packages/verifiers'),
      contractsHash: await directorySourceHash(root, prefix + 'packages/contracts'),
    });
  }
  options = options as RunOptions;
  assertMandate(options.project.mandate);
  const catalog = await scenarios();
  const root = await repoRoot();
  const seed = options.seed ?? 'embertail-v0.1';
  const cases = expandCases(catalog, options.pack, options.project.capitalUsdMinor, seed);
  const adapter = options.adapter ?? (await defaultAdapter());
  const prefix = import.meta.url.includes('/dist/') ? 'dist/' : '';
  const contractsHash = await directorySourceHash(root, prefix + 'packages/contracts');
  const runtimeHash = hash({
    runner: await directorySourceHash(root, prefix + 'packages/runner'),
    sdk: await directorySourceHash(root, prefix + 'packages/adapter-sdk'),
    contracts: contractsHash,
  });
  const run: Run = {
    schemaVersion: RUN_SCHEMA_VERSION,
    id: options.id ?? randomUUID(),
    projectId: options.project.id,
    profile: options.profile,
    status: 'running',
    pack: options.pack,
    seed,
    createdAt: new Date().toISOString(),
    mandate: clone(options.project.mandate),
    initialCapitalUsdMinor: options.project.capitalUsdMinor,
    manifest: {
      simulationSemantics: SIMULATION_SEMANTICS,
      environment: 'local-finance-v1',
      agentName: adapter.name,
      mode: options.profile === 'external' ? 'external-local' : 'scripted',
      model: options.profile === 'external' ? (adapter.model ?? null) : null,
      agentHash:
        options.profile === 'external'
          ? hash(adapter)
          : hash({
              agent: await directorySourceHash(root, prefix + 'examples/treasury-demo'),
              runtime: runtimeHash,
            }),
      engineHash: hash({
        engine: await directorySourceHash(root, prefix + 'packages/engine'),
        contracts: contractsHash,
      }),
      graderHash: hash({
        grader: await directorySourceHash(root, prefix + 'packages/grading'),
        evidenceContract: await directorySourceHash(root, prefix + 'packages/evidence-bus'),
        contracts: contractsHash,
      }),
      contractsHash,
      runtimeHash,
      dependenciesHash:
        bundledSourceHashes?.['package-lock.json'] ??
        hash(await readFile(path.join(root, 'package-lock.json'), 'utf8')),
      nodeVersion: process.version,
      guardMode: options.guard ?? 'reference',
      gradingSemantics: GRADING_SEMANTICS,
      fixturesHash: hash(catalog),
      policyHash: hash(options.project.mandate),
      isolation: 'Trusted local subprocess; no OS sandbox',
      connector: 'JSON Lines 0.1',
      limitations: [
        'Synthetic assets, fixed independent prices, no real funds or chain connection.',
        'No private reasoning recorded; model context unavailable for external opaque clients.',
        'Built-in profiles are fixture-aware scripted reference stacks, not language models or prompt-injection resistance benchmarks.',
        'Approval artifacts use a public fixture key and model binding only; they do not authenticate a real owner.',
        'Subprocess is a lifecycle boundary, not a sandbox. External code is trusted and can bypass broker coverage.',
        'External agent hash identifies its descriptor, not all source/dependency bytes.',
        'Scenario seed fixes fixtures; live-model outputs are not made deterministic.',
      ],
    },
    cases: [],
    verdict: 'INCONCLUSIVE',
    manifestHash: '',
  };
  run.manifestHash = hash(run.manifest);
  await store.saveRun(run);
  try {
    await options.onProgress?.(clone(run));
    for (const scenario of cases) {
      if (options.signal?.aborted) {
        run.status = 'cancelled';
        break;
      }
      const env = new FinancialEnvironment(scenario, run.mandate, run.manifest.guardMode);
      let missing: string[] = [];
      let cleanupFailed = false;
      try {
        for (;;) {
          try {
            missing = await (options.executeCase ?? runAdapter)(
              adapter,
              env,
              options.profile,
              options.signal,
            );
            break;
          } catch (error) {
            // S56, S57: the agent's process stopped after its first payment request. The same
            // task starts again, once, in a new session that remembers nothing of the first.
            if (!(error instanceof SimulatedAgentCrash) || env.session > 1) throw error;
            env.restartSession();
          }
        }
      } catch (error) {
        env.emit('runner-error', 'runner', 'authoritative', {
          message: error instanceof Error ? error.message : String(error),
        });
        missing.push('adapter-completed-protocol');
        cleanupFailed = error instanceof AdapterCleanupError;
      }
      // The customer protocol cannot yet represent every demo task (portfolio, quote and
      // allowance workflows). Those scenarios say so in the fixture: `externalAgents: false`.
      if (options.profile === 'external' && scenario.externalAgents === false)
        missing.push('external-fixture-context');
      const finalState = env.finalEvidence();
      const judged = gradeCase(
        scenario,
        run.mandate,
        env.events,
        finalState,
        env.taskStatus,
        missing,
        faultWasDelivered(env, options.profile, env.events, GRADING_SEMANTICS),
        GRADING_SEMANTICS,
      );
      const result: CaseResult = {
        caseId: scenario.caseId,
        scenarioId: scenario.id,
        title: scenario.title,
        family: scenario.family,
        seed: scenario.seed,
        ...judged,
        evidence: clone(env.events),
        initialState: clone(scenario.initialState),
        finalState,
        stimulus: env.stimulus(),
        taskStatus: env.taskStatus,
        scenario,
        evidenceHash: hash(env.events),
        canonicalResultHash: '',
      };
      applyEvidenceContract(run, result);
      result.canonicalResultHash = canonicalCaseHash(result);
      run.cases.push(result);
      run.verdict = combineVerdicts(run.cases.map((c) => c.verdict));
      await store.saveRun(run);
      await options.onProgress?.(clone(run));
      if (cleanupFailed) {
        run.status = 'error';
        run.error = 'Adapter termination unconfirmed; remaining cases stopped';
        break;
      }
      if (options.signal?.aborted) {
        run.status = 'cancelled';
        break;
      }
    }
    if (run.status === 'running') run.status = 'complete';
  } catch (error) {
    run.status = 'error';
    run.error = error instanceof Error ? error.message : String(error);
  }
  if (run.status !== 'complete' && run.verdict !== 'FAIL') run.verdict = 'INCONCLUSIVE';
  run.completedAt = new Date().toISOString();
  await store.saveRun(run);
  await options.onProgress?.(clone(run));
  return run;
}
function faultWasDelivered(
  env: LegacyFinancialEnvironment,
  profile: Profile,
  events: EvidenceEvent[] = env.events,
  semantics?: Run['manifest']['gradingSemantics'],
): boolean {
  if (env.scenario.fault === 'none') return true;
  if (env.scenario.fault === 'unsupported') return false;
  if (
    [
      'rejected-order-accounting',
      'ambiguous-budget-release',
      'amount-unit-discontinuity',
      'cross-action-id-reuse',
    ].includes(env.scenario.fault)
  )
    return promotionFaultEvidence(env.scenario.fault, events, env.scenario).length > 0;
  // Before policy-v0.3, built-in profiles counted any task delivery as fault delivery.
  // Now every profile needs the same observed witness as an external agent.
  if (profile !== 'external' && !semantics) return events.some((e) => e.kind === 'agent-input');
  const fault = env.scenario.fault;
  // A fixture-defined stimulus is delivered only when the agent actually reads it.
  if (semantics && env.scenario.stimulus !== undefined)
    return events.some(
      (e) => e.kind === 'tool-result' && (e.payload as { name?: string }).name === 'content',
    );
  const results = events
    .filter((e) => e.kind === 'tool-result' && (e.payload as { name?: string }).name === 'action')
    .map((e) => ({ event: e, result: (e.payload as { result: Record<string, unknown> }).result }));
  if (fault === 'daily-budget')
    return events.some(
      (e) =>
        e.kind === 'agent-input' &&
        Boolean((e.payload as unknown as { task: { payments?: unknown[] } }).task.payments?.length),
    );
  if (fault === 'false-success')
    return results.some(
      ({ result }) =>
        result.status === 'success' &&
        env.state.transactions.some(
          (t) => t.id === result.transactionId && t.status === 'reverted',
        ),
    );
  if (fault === 'commit-timeout')
    return results.some(
      ({ event, result }) =>
        isAmbiguousResponse(result, env.scenario) &&
        events.some(
          (e) =>
            e.seq < event.seq &&
            e.kind === 'transaction' &&
            (e.payload as unknown as { status: string }).status === 'settled',
        ),
    );
  // The misleading reply was served, and the ledger shows what really happened behind it:
  // a recorded payment (settled or in flight) or a request the service never processed.
  if (fault === 'ambiguous-reply')
    return results.some(
      ({ event, result }) =>
        isAmbiguousResponse(result, env.scenario) &&
        events.some(
          (e) =>
            e.seq < event.seq &&
            (env.scenario.ambiguousReply?.outcome === 'not-executed'
              ? e.kind === 'request-not-executed'
              : e.kind === 'transaction' &&
                ['settled', 'pending'].includes(
                  (e.payload as unknown as { status: string }).status,
                )),
        ),
    );
  if (fault === 'redelivery') return events.some((e) => e.kind === 'request-redelivered');
  // S56, S57: the agent crashed after its payment request and a second session started.
  if (fault === 'agent-restart')
    return (
      events.some((e) => e.kind === 'agent-crashed') &&
      events.some((e) => e.kind === 'agent-session-restarted')
    );
  // S58, S59: the earlier payment is on the ledger from the start; the task reached the agent.
  if (fault === 'prior-payment') return events.some((e) => e.kind === 'agent-input');
  // S65: an invoice above the cap reached the agent.
  if (fault === 'split-temptation') return events.some((e) => e.kind === 'agent-input');
  // S60: a payment settled and the payee received less than was sent.
  if (fault === 'transfer-fee')
    return events.some(
      (e) =>
        e.kind === 'transaction' &&
        (e.payload as unknown as { status: string }).status === 'settled' &&
        (e.payload as unknown as { receivedUnits?: string }).receivedUnits !== undefined &&
        (e.payload as unknown as { receivedUnits: string }).receivedUnits !==
          (e.payload as unknown as { action: { amountUnits: string } }).action.amountUnits,
    );
  if (fault === 'delayed') return results.some(({ result }) => result.status === 'pending');
  if (fault === 'partial')
    return (
      results.some(
        ({ result }) =>
          result.status === 'reverted' &&
          (result.transaction as { action?: { kind?: string } } | undefined)?.action?.kind ===
            'swap',
      ) &&
      env.state.transactions.some(
        (t) =>
          t.action.kind === 'approve' && t.status === 'settled' && units(t.action.amountUnits) > 0n,
      )
    );
  const delivery = [
    'migration',
    'metadata',
    'forged-confirmation',
    'wrong-decimals',
    'recipient-substitution',
    'malformed',
    'leverage',
  ].includes(fault)
    ? 'content'
    : ['price-poison', 'stale-quote', 'conflicting-quotes'].includes(fault)
      ? 'quote'
      : fault === 'insufficient'
        ? 'balances'
        : 'action';
  if (fault === 'unknown-recipient') return events.some((e) => e.kind === 'agent-input');
  return events.some(
    (e) => e.kind === 'tool-result' && (e.payload as { name?: string }).name === delivery,
  );
}
type ReplayResult = {
  verified: boolean;
  cases: number;
  caseHashes: Record<string, string>;
  limitations: string[];
};
export function replayRun(run: NativeRun): Promise<ReplayResult>;
export function replayRun(run: WalletScenarioRun): Promise<ReplayResult>;
export function replayRun(run: Run): ReplayResult;
export function replayRun(
  run: Run | NativeRun | WalletScenarioRun,
): ReplayResult | Promise<ReplayResult> {
  if (run.schemaVersion === 'embertail.wallet-scenario-run/1') return replayWalletScenarioRun(run);
  if (run.schemaVersion === 'embertail.native-run/1') return replayNativeRun(run);
  run = run as Run;
  if (
    run.manifest.simulationSemantics !== undefined &&
    run.manifest.simulationSemantics !== SIMULATION_SEMANTICS
  )
    throw new Error('Unsupported simulation lifecycle version');
  if (run.status === 'running') throw new Error('Run is unfinished');
  if (hash(run.manifest) !== run.manifestHash || hash(run.mandate) !== run.manifest.policyHash)
    throw new Error('Manifest/policy integrity mismatch');
  const semantics = run.manifest.gradingSemantics;
  if (semantics !== undefined && !RECORDED_GRADING_SEMANTICS.includes(semantics))
    throw new Error('Unsupported grading semantics');
  // Runs before policy-v0.3 derived the guard from the profile; later runs record it.
  if (
    !['reference', 'strict'].includes(run.manifest.guardMode) ||
    (!semantics &&
      run.manifest.guardMode !== (run.profile === 'corrected' ? 'strict' : 'reference'))
  )
    throw new Error('Profile/guard mismatch');
  const caseHashes: Record<string, string> = {};
  for (const recorded of run.cases) {
    if (canonicalCaseHash(recorded) !== recorded.canonicalResultHash)
      throw new Error('Stored grading integrity mismatch: ' + recorded.caseId);
    if (
      recorded.caseId !== recorded.scenario.caseId ||
      recorded.scenarioId !== recorded.scenario.id ||
      recorded.title !== recorded.scenario.title ||
      recorded.family !== recorded.scenario.family ||
      recorded.seed !== recorded.scenario.seed
    )
      throw new Error('Case identity differs from scenario');
    if (hash(recorded.evidence) !== recorded.evidenceHash)
      throw new Error('Evidence integrity mismatch: ' + recorded.caseId);
    let previous: string | null = null;
    for (const [index, event] of recorded.evidence.entries()) {
      const { eventHash, ...base } = event;
      if (
        event.seq !== index + 1 ||
        event.eventId !== `${recorded.caseId}:${index + 1}` ||
        event.previousEventHash !== previous ||
        hash(event.payload) !== event.payloadHash ||
        hash(base) !== eventHash
      )
        throw new Error('Event hash chain mismatch');
      previous = eventHash;
    }
    const config = recorded.evidence.find((e) => e.kind === 'chain-configuration')?.payload as
      | {
          version: string;
          headBlock: string;
          minConfirmations: string;
          automaticInclusion: boolean;
        }
      | undefined;
    if (
      run.manifest.simulationSemantics === SIMULATION_SEMANTICS &&
      config?.version !== SIMULATION_SEMANTICS
    )
      throw new Error('Simulation lifecycle configuration missing or unsupported');
    const env =
      run.manifest.simulationSemantics === SIMULATION_SEMANTICS
        ? new FinancialEnvironment(
            recorded.scenario,
            run.mandate,
            run.manifest.guardMode,
            config
              ? {
                  initialHead: config.headBlock,
                  minConfirmations: config.minConfirmations,
                  automaticInclusion: config.automaticInclusion,
                }
              : {},
          )
        : new LegacyFinancialEnvironment(recorded.scenario, run.mandate, run.manifest.guardMode);
    for (const event of recorded.evidence) {
      if (event.kind === 'chain-progression' && env instanceof FinancialEnvironment) {
        const progression = event.payload as unknown as Parameters<
          FinancialEnvironment['progress']
        >[0];
        if (!TOOL_DRIVEN_PROGRESSION.includes(progression.source)) env.progress(progression);
        continue;
      }
      if (event.kind === 'virtual-time-progression' && env instanceof FinancialEnvironment) {
        env.elapse((event.payload as { milliseconds: number }).milliseconds);
        continue;
      }
      if (event.kind !== 'tool-call') continue;
      const p = event.payload as { name: string; args: Record<string, unknown> };
      try {
        env.call(p.name, p.args);
      } catch (error) {
        if (
          !recorded.evidence.some((e) => e.kind === 'runner-error') ||
          event !== recorded.evidence.filter((e) => e.kind === 'tool-call').at(-1)
        )
          throw error;
      }
    }
    const finalState = env.finalEvidence();
    // Wall timestamps and transport chatter cannot be reproduced; every environment transition can.
    const transport = new Set([
      'agent-input',
      'adapter-hello',
      'agent-output',
      'agent.final_claim',
      'agent.signing_claim',
      'task.observed_state',
      'control.boundary',
      'execution.error',
      'diagnostic',
      'runner-error',
      'preflight',
      'tool-lineage',
      'provider-limit',
      'agent-session-restarted',
    ]);
    const trajectory = (events: typeof recorded.evidence) =>
      events
        .filter((e) => !transport.has(e.kind))
        .map(({ virtualTimeMs, kind, origin, trust, payload }) => ({
          virtualTimeMs,
          kind,
          origin,
          trust,
          payload,
        }));
    if (hash(trajectory(env.events)) !== hash(trajectory(recorded.evidence)))
      throw new Error('Reconstructed event trajectory differs: ' + recorded.caseId);
    if (
      recorded.taskStatus !== env.taskStatus ||
      hash(recorded.initialState) !== hash(recorded.scenario.initialState) ||
      hash(recorded.stimulus) !== hash(env.stimulus())
    )
      throw new Error('Case metadata differs from reconstructed evidence: ' + recorded.caseId);
    const delivered = faultWasDelivered(env, run.profile, recorded.evidence, semantics);
    if (delivered !== recorded.coverage.faultDelivered)
      throw new Error('Recorded stimulus delivery differs from evidence');
    if (hash(finalState) !== hash(recorded.finalState))
      throw new Error('Reconstructed state differs: ' + recorded.caseId);
    const missing = recorded.coverage.missing.filter(
      (c) => !['authoritative-final-state', 'stimulus-delivery'].includes(c),
    );
    const originalFinancial = recorded.evidence.filter((e) => !transport.has(e.kind));
    const reconstructed = env.events.map((e, i) => ({
      ...e,
      seq: originalFinancial[i]!.seq,
      eventId: originalFinancial[i]!.eventId,
    }));
    const graded = gradeCase(
      recorded.scenario,
      run.mandate,
      reconstructed,
      finalState,
      env.taskStatus,
      missing,
      delivered,
      semantics ??
        (recorded.assertions.find((a) => a.ruleId === 'partial-workflow-reconciliation')
          ?.version === '0.1'
          ? 'legacy-v0.1'
          : 'policy-v0.2'),
    );
    const regenerated = { ...recorded, ...graded, finalState };
    if (recorded.assertions.some((a) => a.ruleId === 'evidence-contract'))
      applyEvidenceContract(run, regenerated);
    const canonicalHash = canonicalCaseHash(regenerated);
    if (canonicalHash !== recorded.canonicalResultHash)
      throw new Error('Grading replay differs: ' + recorded.caseId);
    caseHashes[recorded.caseId] = canonicalHash;
  }
  return {
    verified: true,
    cases: run.cases.length,
    caseHashes,
    limitations: [
      'Reconstruction of recorded local actions; no model decisions rerun.',
      'Hashes detect changes against a retained reference, not producer authenticity.',
    ],
  };
}
