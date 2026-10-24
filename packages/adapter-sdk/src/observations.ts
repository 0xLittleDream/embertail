import type { Json } from '../../contracts/src/index.js';

export const OBSERVATION_KINDS = [
  'agent.final_claim',
  'agent.signing_claim',
  'task.observed_state',
  'control.boundary',
  'execution.error',
] as const;
export type AdapterObservation = {
  kind: (typeof OBSERVATION_KINDS)[number];
  payload: Record<string, Json>;
};

// Observations cannot execute a financial tool or assert independent authority.
export function assertObservation(value: unknown): asserts value is AdapterObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid observation');
  const observation = value as AdapterObservation;
  if (
    Object.keys(observation).sort().join() !== 'kind,payload' ||
    !OBSERVATION_KINDS.includes(observation.kind) ||
    !observation.payload ||
    typeof observation.payload !== 'object' ||
    Array.isArray(observation.payload) ||
    Buffer.byteLength(JSON.stringify(observation)) > 16000
  )
    throw Error('Invalid observation');
  const p = observation.payload;
  if (observation.kind.startsWith('agent.')) {
    if (typeof p.claim !== 'string' || !p.claim.trim() || p.claim.length > 12000)
      throw Error('Missing actual agent claim');
    if (Object.keys(p).some((key) => key !== 'claim')) throw Error('Invalid claim fields');
  } else if (observation.kind === 'task.observed_state') {
    if (
      !['pending', 'completed', 'failed', 'unknown'].includes(String(p.status)) ||
      typeof p.sourceId !== 'string' ||
      !p.sourceId ||
      typeof p.taskRef !== 'string' ||
      !p.taskRef ||
      !(p.revision === null || typeof p.revision === 'string') ||
      typeof p.observedAt !== 'string' ||
      !Number.isFinite(Date.parse(p.observedAt)) ||
      !(
        p.responseDigest === null ||
        (typeof p.responseDigest === 'string' && /^[a-f0-9]{64}$/.test(p.responseDigest))
      ) ||
      Object.keys(p).sort().join() !== 'observedAt,responseDigest,revision,sourceId,status,taskRef'
    )
      throw Error('Invalid observed task state');
  } else if (observation.kind === 'execution.error') {
    if (
      typeof p.tool !== 'string' ||
      !p.tool ||
      typeof p.message !== 'string' ||
      !p.message ||
      Object.keys(p).sort().join() !== 'message,tool'
    )
      throw Error('Invalid execution error');
  } else if (
    typeof p.paymentPath !== 'string' ||
    !p.paymentPath ||
    !['code-enforced', 'prompt-dependent', 'outside-payment-guards', 'unknown'].includes(
      String(p.enforcement),
    ) ||
    typeof p.detail !== 'string' ||
    !p.detail ||
    Object.keys(p).sort().join() !== 'detail,enforcement,paymentPath'
  )
    throw Error('Invalid control boundary');
}
