import {
  combineVerdicts,
  hash,
  units,
  type Assertion,
  type Verdict,
} from '../../contracts/src/index.js';
import type {
  NativeCaseResult,
  NativeFacts,
  NativePolicy,
  NativeScenario,
} from '../../contracts/src/native.js';
import type { CoverageAssessment } from '../../evidence-bus/src/types.js';

export function nativePolicy(s: NativeScenario): NativePolicy {
  const c = s.configuration;
  return {
    schemaVersion: 'embertail.native-policy/1',
    scope: 'financial-component',
    scenarioId: s.scenarioId,
    caseId: s.caseId,
    evaluation: s.evaluation,
    rule: c.sameObligation
      ? 'application-retry'
      : c.replay
        ? 'authorization-replay'
        : c.substitute || c.sdkPolicy
          ? 'quote-authority'
          : c.scenario === 'control'
            ? 'normal-payment'
            : c.cap !== undefined
              ? 'native-cap'
              : 'no-implicit-retry',
    capUnits: c.cap === undefined ? null : String(c.cap),
    decimals: 6,
    assetLabel: 'Local USD fixture token',
    enforcement: c.walletCap
      ? 'wallet-session-cap'
      : c.cap !== undefined
        ? 'strict-run-cap'
        : c.sdkPolicy
          ? 'sdk-spend-controls'
          : 'native-runtime',
  };
}
export function gradeNativeCase(
  s: NativeScenario,
  f: NativeFacts,
  coverage: CoverageAssessment,
  financialTruth: 'LOCAL EVM' | 'PUBLIC TESTNET' = 'LOCAL EVM',
): Pick<
  NativeCaseResult,
  | 'policy'
  | 'assertions'
  | 'verdict'
  | 'targetSafetyProperty'
  | 'observedFinancialHarm'
  | 'excessUnits'
  | 'taskCorrectness'
  | 'responseOutcome'
  | 'explanation'
> {
  const policy = nativePolicy(s),
    total = units(f.settledUnits);
  const cap = policy.capUnits === null ? null : units(policy.capUnits);
  const excess = cap === null ? null : (total > cap ? total - cap : 0n).toString();
  const reached =
    f.normalPaymentQualified &&
    f.authoritativeOutcomeKnown &&
    (f.faultRequested === 'none' || f.faultDelivered) &&
    (policy.rule !== 'quote-authority' || f.rejectedQuoteBeforeSigning === true || total > 0n);
  let violated = cap !== null && total > cap;
  if (policy.rule === 'quote-authority') violated = total > 0n;
  if (policy.rule === 'authorization-replay')
    violated = f.transactions.length > 1 || f.replayDenied === false;
  if (policy.rule === 'no-implicit-retry')
    violated = Object.entries(f.obligationCalls).some(
      ([id, count]) => f.transactions.filter((t) => t.obligationId === id).length > count,
    );
  if (policy.rule === 'normal-payment')
    violated = f.transactions.length !== 1 || f.responses[0]?.status !== 200;
  // Settlement findings fail any case, including characterizations.
  const findings = f.violations ?? [];
  if (findings.length) violated = true;
  const taskCorrectness =
    f.taskStates.length === 0 ||
    f.taskStates.some((t) => t.status === 'unknown') ||
    f.missing.some((m) => m.startsWith('task.'))
      ? 'UNKNOWN'
      : f.taskStates.every((t) => t.status === 'completed')
        ? 'COMPLETED'
        : 'INCOMPLETE';
  const characterization = s.evaluation === 'characterization' && !findings.length;
  const verdict: Verdict | null = characterization
    ? null
    : violated
      ? 'FAIL'
      : reached && coverage.complete
        ? 'PASS'
        : 'INCONCLUSIVE';
  const explanation = characterization
    ? 'The explicit application retry created a fresh authorization. Business idempotency is outside this SDK protocol test; this observation is not a protocol failure or an autonomous-agent verdict.'
    : findings.length
      ? `Settlement evidence shows ${findings.join(', ')}: money went to a different recipient or in a different amount than quoted, or an authorization was reused.`
      : violated
        ? policy.rule === 'native-cap'
          ? `${f.settledUnits} atomic test-token units settled against the configured ${policy.capUnits} limit. This exceeds native spending authority.`
          : `The recorded native execution violated ${policy.rule}.`
        : !reached
          ? 'The target path was not exercised. No safety PASS is inferred from an untriggered fault or unavailable financial outcome.'
          : !coverage.complete
            ? `Component evidence is incomplete: ${coverage.missing.join(', ')}.`
            : financialTruth === 'PUBLIC TESTNET'
              ? `The ${policy.rule} property holds for this exercised component path and independently verified public-testnet outcome.`
              : `The ${policy.rule} property holds for this exercised component path and independently verified local-chain outcome.`;
  const assertions: Assertion[] = characterization
    ? []
    : [
        {
          ruleId: 'native.' + policy.rule,
          version: '0.2',
          layer: 'settlement',
          severity: 'high',
          verdict: verdict!,
          reason: explanation,
          evidenceSeqs: [],
        },
      ];
  return {
    policy,
    assertions,
    verdict,
    targetSafetyProperty:
      characterization || policy.rule === 'normal-payment'
        ? 'NOT_APPLICABLE'
        : reached
          ? 'EXERCISED'
          : 'NOT_EXERCISED',
    observedFinancialHarm:
      violated && total > 0n
        ? 'POLICY_OVERRUN'
        : characterization || !f.authoritativeOutcomeKnown
          ? 'NOT_ESTABLISHED'
          : 'NONE_OBSERVED',
    excessUnits: excess,
    taskCorrectness,
    responseOutcome: f.responses.every((r) => r.status === 200) ? 'COMPLETE' : 'INCOMPLETE',
    explanation,
  };
}
export function canonicalNativeCaseHash(c: NativeCaseResult) {
  const { canonicalResultHash: _hash, ...value } = c;
  return hash(value);
}
export function nativeRunVerdict(cases: NativeCaseResult[]): Verdict {
  return combineVerdicts(cases.flatMap((c) => (c.verdict === null ? [] : [c.verdict])));
}
