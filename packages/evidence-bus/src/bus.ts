import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { assertMandate, hash, type Json } from '../../contracts/src/index.js';
import { atomicJson } from '../../runner/src/store.js';
import { redact, redactText, environmentSecrets } from '../../investigator/src/redaction.js';
import { assessCoverage } from './contract.js';
import { assessVerification } from '../../verifiers/src/correlation.js';
import { KINDS, type BusEvent, type EvidenceInput, type EvidenceScope } from './types.js';
export function safeId(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw Error('Invalid evidence session ID');
  return id;
}
const sources = ['otlp', 'mcp', 'native', 'subprocess', 'sandbox', 'recorded-run', 'verifier'];
const identityKeys = [
  'runId',
  'taskId',
  'businessIntentId',
  'agentTurnId',
  'toolCallId',
  'financialActionId',
  'retryOfActionId',
  'idempotencyKey',
  'transactionHash',
  'receiptId',
  'traceId',
  'spanId',
  'parentSpanId',
  'chainId',
];
function boundedJson(value: unknown, depth = 0): void {
  if (depth > 20) throw Error('Evidence nesting limit exceeded');
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return;
  if (!value || typeof value !== 'object') throw Error('Invalid evidence JSON');
  for (const child of Object.values(value)) boundedJson(child, depth + 1);
}
export class EvidenceBus {
  private queues = new Map<string, Promise<unknown>>();
  constructor(
    readonly root: string,
    readonly env: NodeJS.ProcessEnv = process.env,
  ) {}
  private file(id: string) {
    return path.join(this.root, safeId(id) + '.json');
  }
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.queues.set(id, next);
    void next
      .finally(() => {
        if (this.queues.get(id) === next) this.queues.delete(id);
      })
      .catch(() => {});
    return next;
  }
  async create(input: Omit<EvidenceScope, 'id' | 'createdAt'>) {
    if (input.policySnapshot.schemaVersion === 'embertail.verification-policy/1') {
      if (
        input.scenarioId !== 'external-financial' ||
        input.faultRequested !== 'none' ||
        Object.keys(input.policySnapshot).sort().join() !== 'purpose,schemaVersion' ||
        input.policySnapshot.purpose !== 'independent-facts-only'
      )
        throw Error('Invalid independent verification scope');
    } else if (input.policySnapshot.schemaVersion === 'embertail.native-policy/1') {
      const p = input.policySnapshot;
      if (
        p.scope !== 'financial-component' ||
        p.scenarioId !== input.scenarioId ||
        p.caseId !== input.taskId ||
        !/^S\d{2}$/.test(p.scenarioId) ||
        p.decimals !== 6 ||
        p.assetLabel !== 'Local USD fixture token' ||
        !['regression', 'characterization'].includes(p.evaluation) ||
        ![
          'native-cap',
          'quote-authority',
          'authorization-replay',
          'no-implicit-retry',
          'normal-payment',
          'application-retry',
        ].includes(p.rule) ||
        !['strict-run-cap', 'wallet-session-cap', 'sdk-spend-controls', 'native-runtime'].includes(
          p.enforcement,
        ) ||
        (p.capUnits !== null && !/^(0|[1-9]\d{0,77})$/.test(p.capUnits)) ||
        (p.rule === 'native-cap' && p.capUnits === null)
      )
        throw Error('Invalid native component policy scope');
    } else assertMandate(input.policySnapshot);
    for (const value of [input.runId, input.taskId, input.businessIntentId, input.scenarioId])
      if (typeof value !== 'string' || !value || value.length > 200)
        throw Error('Invalid evidence scope');
    const scope: EvidenceScope = {
        ...input,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      },
      token = randomBytes(32).toString('hex');
    await mkdir(this.root, { recursive: true });
    await atomicJson(this.file(scope.id), {
      scope,
      scopeHash: hash(scope),
      tokenHash: hash(token),
      events: [],
    });
    return { scope, token };
  }
  private async saved(
    id: string,
  ): Promise<{ scope: EvidenceScope; tokenHash: string; events: BusEvent[] }> {
    const saved = JSON.parse(await readFile(this.file(id), 'utf8'));
    if (
      saved.scope?.id !== id ||
      saved.scopeHash !== hash(saved.scope) ||
      !Array.isArray(saved.events)
    )
      throw Error('Invalid evidence journal');
    let previous: string | null = null;
    for (const [i, event] of (saved.events as BusEvent[]).entries()) {
      const { hash: digest, ...base } = event;
      if (event.sequence !== i + 1 || event.previousHash !== previous || hash(base) !== digest)
        throw Error('Evidence journal integrity mismatch');
      previous = digest;
    }
    return saved;
  }
  async authorize(id: string, token: string) {
    const saved = await this.saved(id),
      a = Buffer.from(hash(token)),
      b = Buffer.from(saved.tokenHash);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw Error('Invalid evidence ingestion capability');
    return saved.scope;
  }
  async read(id: string) {
    const saved = await this.saved(id);
    return {
      scope: saved.scope,
      events: saved.events,
      assessment: assessCoverage(saved.scope, saved.events),
      verificationAssessment: assessVerification(saved.events),
    };
  }
  async append(id: string, input: EvidenceInput[], source: BusEvent['source'], trusted = false) {
    return this.serial(id, async () => {
      const saved = await this.saved(id);
      if (!sources.includes(source) || input.length > 500) throw Error('Invalid evidence batch');
      const staged = [...saved.events];
      let accepted = 0,
        duplicates = 0;
      for (const event of input) {
        boundedJson(event);
        if (
          Object.keys(event).sort().join() !== 'id,identity,kind,occurredAt,payload' ||
          !KINDS.includes(event.kind) ||
          typeof event.id !== 'string' ||
          !event.id ||
          event.id.length > 300 ||
          typeof event.occurredAt !== 'string' ||
          !Number.isFinite(Date.parse(event.occurredAt))
        )
          throw Error('Invalid canonical evidence event');
        if (
          !event.identity ||
          event.identity.runId !== saved.scope.runId ||
          event.identity.taskId !== saved.scope.taskId ||
          event.identity.businessIntentId !== saved.scope.businessIntentId
        )
          throw Error('Evidence scope mismatch');
        if (
          Object.entries(event.identity).some(
            ([k, v]) =>
              !identityKeys.includes(k) ||
              (!(k === 'retryOfActionId' && v === null) &&
                (typeof v !== 'string' || !v || v.length > 300)),
          )
        )
          throw Error('Invalid evidence identity');
        const secrets = environmentSecrets(this.env),
          clean = redact(event, secrets);
        const identifier = (value: string) =>
          redactText(value, secrets) === value
            ? value
            : 'opaque:' + createHmac('sha256', saved.tokenHash).update(value).digest('hex');
        // Preserve correlation when conservative secret filtering would collapse opaque IDs.
        clean.id = identifier(event.id);
        for (const [key, value] of Object.entries(event.identity))
          if (typeof value === 'string')
            (clean.identity as Record<string, string | null>)[key] = identifier(value);
        // Independently read public chain identifiers and proof digests are not keys.
        // Restore only this closed verifier payload surface; remote observations retain normal redaction.
        if (
          source === 'verifier' &&
          trusted &&
          [
            'intent.binding',
            'verification.snapshot',
            'verification.action',
            'financial.action',
            'financial.settlement',
            'task.observed_state',
          ].includes(event.kind)
        ) {
          const restore = (raw: unknown, redacted: unknown): void => {
            if (!raw || typeof raw !== 'object' || !redacted || typeof redacted !== 'object')
              return;
            for (const [key, value] of Object.entries(raw)) {
              if (
                typeof value === 'string' &&
                [
                  'transactionHash',
                  'blockHash',
                  'hash',
                  'parentHash',
                  'planDigest',
                  'requestDigest',
                  'responseDigest',
                ].includes(key) &&
                /^(?:0x)?[a-fA-F0-9]{64}$/.test(value) &&
                !secrets.some((secret) => secret.length >= 4 && value.includes(secret))
              )
                (redacted as Record<string, unknown>)[key] = value;
              else if (
                typeof value === 'string' &&
                ['financialActionId', 'retryOfActionId'].includes(key)
              )
                (redacted as Record<string, unknown>)[key] = identifier(value);
              else restore(value, (redacted as Record<string, unknown>)[key]);
            }
          };
          restore(event.payload, clean.payload);
        }
        if (
          event.kind === 'fault.delivered' &&
          event.payload &&
          typeof event.payload === 'object' &&
          !Array.isArray(event.payload) &&
          Array.isArray(event.payload.evidenceIds)
        )
          (clean.payload as Record<string, Json>).evidenceIds = event.payload.evidenceIds.map(
            (id) => (typeof id === 'string' ? identifier(id) : id),
          );
        // Identity hashes are identifiers; their fixed validated formats are retained.
        for (const key of ['traceId', 'spanId', 'parentSpanId'] as const)
          if (
            event.identity[key] &&
            /^(?:0x)?[a-fA-F0-9]{16,64}$/.test(event.identity[key]!) &&
            !secrets.some((secret) => secret.length >= 4 && event.identity[key]!.includes(secret))
          )
            clean.identity[key] = event.identity[key];
        if (Buffer.byteLength(JSON.stringify(clean)) > 65536)
          throw Error('Evidence event exceeds limit');
        const trust: BusEvent['trust'] = [
          'agent.final_claim',
          'agent.signing_claim',
          'task.final_state',
        ].includes(event.kind)
          ? 'agent-reported'
          : event.kind === 'task.observed_state' && source !== 'verifier'
            ? 'observed'
            : trusted &&
                ['recorded-run', 'verifier', 'subprocess'].includes(source) &&
                !['agent.span', 'tool.call', 'tool.result'].includes(event.kind)
              ? 'authoritative'
              : 'observed';
        const existing = staged.find((e) => e.id === clean.id);
        if (existing) {
          const {
            sequence,
            capturedAt,
            previousHash,
            hash: digest,
            schemaVersion,
            ...prior
          } = existing;
          if (hash(prior) !== hash({ ...clean, source, trust }))
            throw Error('Conflicting duplicate evidence ID');
          duplicates++;
          continue;
        }
        const base = {
          ...clean,
          schemaVersion: 'embertail.evidence/1' as const,
          source,
          trust,
          sequence: staged.length + 1,
          capturedAt: new Date().toISOString(),
          previousHash: staged.at(-1)?.hash ?? null,
        };
        staged.push({ ...base, hash: hash(base) });
        accepted++;
      }
      if (staged.length > 10000 || Buffer.byteLength(JSON.stringify(staged)) > 16 * 1024 * 1024)
        throw Error('Evidence journal limit exceeded');
      await atomicJson(this.file(id), { ...saved, events: staged });
      return { accepted, duplicates, assessment: assessCoverage(saved.scope, staged) };
    });
  }
}
