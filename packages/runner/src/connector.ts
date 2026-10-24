import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { FinancialEnvironment } from '../../engine/src/environment.js';
import { fromUsd, type Profile } from '../../contracts/src/index.js';
import { assertObservation } from '../../adapter-sdk/src/observations.js';
export class AdapterCleanupError extends Error {}
/** The simulated agent process stopped after a request; the runner starts a new session (S56). */
export class SimulatedAgentCrash extends Error {
  constructor() {
    super('The agent process stopped after its payment request (simulated crash)');
  }
}
const FRAME_BYTES = 65536;
const OUTPUT_BYTES = 2 * 1024 * 1024;
export type Adapter = {
  name: string;
  version: string;
  command: string;
  args: string[];
  capabilities: string[];
  /** Recorded configuration, not an authenticated provider identity. */
  model?: string;
  /** Explicit secret-name opt-in. Values are never put in the descriptor or manifest. */
  inheritEnv?: string[];
  /** Optional bounded time for multi-step external tasks; defaults to 60 seconds. */
  wallTimeMs?: number;
};
export async function runAdapter(
  adapter: Adapter,
  env: FinancialEnvironment,
  profile: Profile,
  signal?: AbortSignal,
): Promise<string[]> {
  if (
    adapter.wallTimeMs !== undefined &&
    (!Number.isSafeInteger(adapter.wallTimeMs) ||
      adapter.wallTimeMs < 1000 ||
      adapter.wallTimeMs > 300000)
  )
    throw new Error('Invalid adapter wall-time limit');
  if (
    adapter.inheritEnv !== undefined &&
    (!Array.isArray(adapter.inheritEnv) ||
      adapter.inheritEnv.length > 8 ||
      adapter.inheritEnv.some((key) => typeof key !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(key)))
  )
    throw new Error('Invalid adapter environment-name allowlist');
  const missing = env.scenario.requiredCapabilities.filter(
    (c) => !adapter.capabilities.includes(c),
  );
  if (missing.length) {
    env.emit('preflight', 'runner', 'authoritative', { missing });
    return missing;
  }
  if (signal?.aborted) throw new Error('Run cancelled');
  return new Promise((resolve, reject) => {
    const inherited: NodeJS.ProcessEnv = {};
    for (const key of [
      'PATH',
      'Path',
      'SystemRoot',
      'SYSTEMROOT',
      'WINDIR',
      'TEMP',
      'TMP',
      'COMSPEC',
      ...(adapter.inheritEnv ?? []),
    ])
      if (process.env[key]) inherited[key] = process.env[key];
    const child = spawn(adapter.command, adapter.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: inherited,
    });
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let toolCount = 0;
    let observationCount = 0;
    let lastId = 0;
    let hello = false;
    let finishing = false;
    let closed = false;
    let finishError: Error | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    let observedCapabilities: string[] = [];
    const kill = () => {
      if (child.pid && process.platform === 'win32')
        execFile(
          'taskkill',
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true },
          () => {},
        );
      else if (child.pid) child.kill('SIGKILL');
    };
    const end = (error?: Error) => {
      if (finishing) return;
      finishing = true;
      finishError = error;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      // Do not publish final evidence while a child can still emit or mutate the event log.
      kill();
      cleanupTimer = setTimeout(() => {
        if (!closed) reject(new AdapterCleanupError('Adapter termination could not be confirmed'));
      }, 2000);
    };
    const cancel = () => end(new Error('Run cancelled'));
    const wallTimeMs = adapter.wallTimeMs ?? 60000;
    const timer = setTimeout(
      () => end(new Error(`Agent wall-time limit exceeded (${wallTimeMs / 1000} seconds)`)),
      wallTimeMs,
    );
    signal?.addEventListener('abort', cancel, { once: true });
    const write = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    child.on('error', (error) => end(error));
    child.stdin.on('error', (error) => {
      if (!finishing) end(error);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (finishing) return;
      stderrBytes += chunk.length;
      if (stderrBytes > OUTPUT_BYTES)
        return end(new Error('Agent diagnostic output limit exceeded'));
      env.emit('diagnostic', 'agent', 'observed', { text: chunk.toString('utf8').slice(0, 4000) });
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (finishing) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > OUTPUT_BYTES) return end(new Error('Agent protocol output limit exceeded'));
      buffer += decoder.write(chunk);
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0 && !finishing) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (Buffer.byteLength(line) > FRAME_BYTES)
          return end(new Error('Agent protocol frame limit exceeded'));
        try {
          const m = JSON.parse(line) as Record<string, unknown>;
          if (!hello) {
            if (
              m.type !== 'hello' ||
              m.protocolVersion !== '0.1' ||
              !Array.isArray(m.capabilities) ||
              m.capabilities.some((c) => typeof c !== 'string')
            )
              throw new Error('Adapter handshake is invalid');
            observedCapabilities = m.capabilities as string[];
            const observed = env.scenario.requiredCapabilities.filter(
              (c) => !(m.capabilities as unknown[]).includes(c),
            );
            if (observed.length)
              throw new Error(
                'Adapter handshake lacks declared capabilities: ' + observed.join(', '),
              );
            hello = true;
            env.emit('adapter-hello', 'agent', 'agent-reported', {
              protocolVersion: '0.1',
              capabilities: observedCapabilities,
            });
            // Exact SIM_USDC base units alongside every cent amount, so agents need not
            // convert. S27 (amount-normalization) tests that conversion and gets cents only.
            const units = !env.scenario.requiredCapabilities.includes('amount-normalization');
            const task = {
              businessIntentId: env.scenario.businessIntentId,
              kind: env.scenario.task === 'defer' ? 'review' : env.scenario.task,
              amountUsdMinor: env.scenario.amountUsdMinor,
              ...(units ? { amountUnits: fromUsd(env.scenario.amountUsdMinor) } : {}),
              recipient: env.scenario.recipient,
              ...(env.scenario.paymentBatch
                ? {
                    payments: Array.from({ length: env.scenario.paymentBatch.count }, (_, i) => ({
                      id: `${env.scenario.businessIntentId}-${i + 1}`,
                      amountUsdMinor: env.scenario.paymentBatch!.eachUsdMinor,
                      ...(units
                        ? { amountUnits: fromUsd(env.scenario.paymentBatch!.eachUsdMinor) }
                        : {}),
                      recipient: env.scenario.recipient,
                    })),
                  }
                : {}),
              ...(env.scenario.swapWorkflow ? { swap: env.scenario.swapWorkflow } : {}),
              ...(env.scenario.requiredCapabilities.includes('financial-accounting')
                ? {
                    accountingRequired: true,
                    swap: { contract: 'dex-v1', fromAssetId: 'SIM_USDC', toAssetId: 'SIM_ETH' },
                  }
                : {}),
              ...(env.scenario.requiredCapabilities.includes('amount-normalization')
                ? {
                    amountInput:
                      '$' +
                      (BigInt(env.scenario.amountUsdMinor) / 100n).toString() +
                      (BigInt(env.scenario.amountUsdMinor) % 100n === 0n
                        ? ''
                        : '.' +
                          (BigInt(env.scenario.amountUsdMinor) % 100n).toString().padStart(2, '0')),
                  }
                : {}),
            };
            // Hidden ledger truth, fault names and expected behavior are reserved for the transparent fixture demo.
            const input = {
              type: 'start_case',
              protocolVersion: '0.1',
              task,
              ...(profile === 'external'
                ? {}
                : {
                    scenario: env.scenario,
                    // Built-in demo agents only: which session this is after a simulated crash.
                    ...(env.session > 1 ? { session: env.session } : {}),
                  }),
              mandate: env.mandate,
              profile,
            };
            env.emit('agent-input', 'runner', 'observed', input);
            write(input);
          } else if (m.type === 'tool_request') {
            if (!Number.isSafeInteger(m.id) || Number(m.id) !== lastId + 1)
              throw new Error('Tool request IDs must be unique and sequential');
            lastId = Number(m.id);
            if (++toolCount > 30) throw new Error('Agent tool-call limit exceeded (30)');
            if (
              typeof m.name !== 'string' ||
              !m.args ||
              typeof m.args !== 'object' ||
              Array.isArray(m.args)
            )
              throw new Error('Malformed tool request');
            const args = m.args as Record<string, unknown>;
            if (m.lineage !== undefined) {
              const lineage = m.lineage as Record<string, unknown>;
              if (
                !lineage ||
                typeof lineage !== 'object' ||
                Array.isArray(lineage) ||
                Object.keys(lineage).some(
                  (k) => !['agentTurnId', 'financialActionId', 'retryOfActionId'].includes(k),
                ) ||
                Object.entries(lineage).some(
                  ([k, v]) =>
                    !(k === 'retryOfActionId' && v === null) &&
                    (typeof v !== 'string' || !v || v.length > 200),
                )
              )
                throw Error('Invalid tool lineage');
              env.emit('tool-lineage', 'agent', 'agent-reported', {
                ...lineage,
                toolCallId: String(m.id),
                requestId: typeof args.requestId === 'string' ? args.requestId : null,
              });
            }
            const required =
              m.name === 'action'
                ? String(args.kind)
                : m.name === 'status'
                  ? 'receipt'
                  : m.name === 'task'
                    ? 'task-status'
                    : m.name === 'accounting'
                      ? 'financial-accounting'
                      : m.name === 'normalize-amount' || m.name === 'normalization-report'
                        ? 'amount-normalization'
                        : m.name === 'balances' || m.name === 'wait'
                          ? 'receipt'
                          : m.name;
            if (
              !adapter.capabilities.includes(required) ||
              !observedCapabilities.includes(required)
            )
              throw new Error('Tool capability not declared: ' + required);
            const result = env.call(m.name, args);
            // S56, S57: the process stops right after this request; no reply is written.
            if (env.takeCrash()) throw new SimulatedAgentCrash();
            write({ type: 'tool_result', id: m.id, result });
          } else if (m.type === 'observation') {
            if (++observationCount > 100) throw Error('Agent observation limit exceeded');
            assertObservation(m.observation);
            if (
              m.observation.kind === 'task.observed_state' &&
              m.observation.payload.taskRef !== env.scenario.businessIntentId
            )
              throw Error('Observed task belongs to another business intent');
            env.emit(
              m.observation.kind,
              'agent',
              m.observation.kind.startsWith('agent.') ? 'agent-reported' : 'observed',
              m.observation.payload,
            );
          } else if (m.type === 'finish') {
            if (m.completion !== undefined) {
              const completion = m.completion as Record<string, unknown>;
              if (
                !completion ||
                typeof completion !== 'object' ||
                Array.isArray(completion) ||
                Object.keys(completion).sort().join() !== 'agentFinalClaim,taskFinalState' ||
                !['completed', 'deferred', 'unpaid'].includes(String(completion.taskFinalState)) ||
                typeof completion.agentFinalClaim !== 'string' ||
                !completion.agentFinalClaim.trim() ||
                completion.agentFinalClaim.length > 2000
              )
                throw Error('Invalid structured task completion');
              if (
                !adapter.capabilities.includes('task-status') ||
                !observedCapabilities.includes('task-status')
              )
                throw Error('Structured completion requires task-status capability');
              if (env.taskStatus !== 'unknown')
                throw Error(
                  'Task completion was already recorded; do not report a conflicting final state',
                );
              env.call('task', {
                status: completion.taskFinalState,
                summary: completion.agentFinalClaim,
              });
            }
            end();
          } else if (m.type === 'output')
            env.emit('agent-output', 'agent', 'agent-reported', {
              text: String(m.text ?? '').slice(0, 4000),
            });
          else {
            if (m.type === 'error' && m.code === 'PROVIDER_LIMIT')
              env.emit('provider-limit', 'agent', 'agent-reported', { code: 'PROVIDER_LIMIT' });
            throw new Error(
              m.type === 'error' ? String(m.message) : 'Unknown adapter protocol message',
            );
          }
        } catch (error) {
          end(error instanceof Error ? error : new Error(String(error)));
        }
      }
      if (!finishing && Buffer.byteLength(buffer) > FRAME_BYTES)
        end(new Error('Agent protocol frame limit exceeded'));
    });
    child.on('close', (code) => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', cancel);
      if (!finishing) reject(new Error('Adapter exited before finish: ' + code));
      else if (finishError) reject(finishError);
      else resolve([]);
    });
    if (signal?.aborted) cancel();
  });
}
