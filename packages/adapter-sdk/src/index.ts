import { createInterface } from 'node:readline';
import type { Json, Mandate, Profile, ScenarioCase } from '../../contracts/src/index.js';
import { assertObservation, type AdapterObservation } from './observations.js';
export type { AdapterObservation } from './observations.js';
export type BusinessTask = {
  businessIntentId: string;
  kind: 'pay' | 'rebalance' | 'authorize' | 'review';
  amountUsdMinor: string;
  /** Exact SIM_USDC base units (6 decimals) for amountUsdMinor; absent when the case tests conversion. */
  amountUnits?: string;
  recipient: string;
  payments?: { id: string; amountUsdMinor: string; amountUnits?: string; recipient: string }[];
  swap?: { contract: string; fromAssetId: string; toAssetId: string };
  accountingRequired?: boolean;
  amountInput?: string;
};
export type StartMessage = {
  type: 'start_case';
  protocolVersion: '0.1';
  task: BusinessTask;
  mandate: Mandate;
  profile: Profile;
  scenario?: ScenarioCase;
};
export type ToolLineage = {
  agentTurnId?: string;
  financialActionId?: string;
  retryOfActionId?: string | null;
};
export type TaskCompletion = {
  taskFinalState: 'completed' | 'deferred' | 'unpaid';
  agentFinalClaim: string;
};
export type ToolClient = {
  call(name: string, args: Record<string, unknown>, lineage?: ToolLineage): Promise<Json>;
  observe?(observation: AdapterObservation): void;
};
/** Trusted local adapter helper. It is a transport, never a security sandbox. */
export function serveAgent(
  capabilities: string[],
  handle: (
    start: StartMessage,
    tools: ToolClient & { observe(observation: AdapterObservation): void },
  ) => Promise<void | TaskCompletion>,
): void {
  const lines = createInterface({ input: process.stdin });
  const pending = new Map<
    number,
    { resolve: (value: Json) => void; reject: (error: Error) => void }
  >();
  let nextId = 0;
  let started = false;
  const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  send({ type: 'hello', protocolVersion: '0.1', capabilities });
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.type === 'tool_result') {
        const item = pending.get(Number(message.id));
        if (!item) throw new Error('Unknown tool response ID');
        pending.delete(Number(message.id));
        if (message.error) item.reject(new Error(String(message.error)));
        else item.resolve(message.result as Json);
      } else if (message.type === 'start_case' && !started) {
        started = true;
        void handle(message as unknown as StartMessage, {
          observe: (observation) => {
            assertObservation(observation);
            send({ type: 'observation', observation });
          },
          call: (name, args, lineage) =>
            new Promise((resolve, reject) => {
              const id = ++nextId;
              pending.set(id, { resolve, reject });
              send({ type: 'tool_request', id, name, args, ...(lineage ? { lineage } : {}) });
            }),
        })
          .then((completion) => {
            send({ type: 'finish', ...(completion ? { completion } : {}) });
            lines.close();
            process.stdin.destroy();
          })
          .catch((error) => {
            send({
              type: 'error',
              ...([402, 429].includes(error?.status) || error?.code === 'PROVIDER_LIMIT'
                ? { code: 'PROVIDER_LIMIT' }
                : {}),
              message: error instanceof Error ? error.message : String(error),
            });
            process.exitCode = 1;
            lines.close();
            process.stdin.destroy();
          });
      }
    } catch (error) {
      process.stderr.write(String(error) + '\n');
      process.exitCode = 1;
      lines.close();
      process.stdin.destroy();
    }
  });
}
