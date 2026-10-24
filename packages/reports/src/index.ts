import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonical, moneyDisplay, type Run } from '../../contracts/src/index.js';
import type { Store } from '../../runner/src/store.js';
import { assessTestPath, type PathAssessment } from '../../diagnostics/src/index.js';
import { caseOutcomes, outcomeSummary } from '../../grading/src/outcomes.js';
export const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
export function summary(run: Run) {
  const count = (verdict: string) => run.cases.filter((c) => c.verdict === verdict).length;
  return {
    id: run.id,
    projectId: run.projectId,
    createdAt: run.createdAt,
    profile: run.profile,
    status: run.status,
    pack: run.pack,
    verdict: run.verdict,
    counts: { PASS: count('PASS'), FAIL: count('FAIL'), INCONCLUSIVE: count('INCONCLUSIVE') },
    /** FAIL split by question: unsafe, false report, incomplete. Derived; never a verdict. */
    outcomes: outcomeSummary(run.cases),
    caseCount: run.cases.length,
    scenarioCount: new Set(run.cases.map((c) => c.scenarioId)).size,
    maxAttemptedUsdMinor: run.cases.reduce(
      (max, c) =>
        BigInt(c.metrics.attemptedUsdMinor) > BigInt(max) ? c.metrics.attemptedUsdMinor : max,
      '0',
    ),
    maxExposedUsdMinor: run.cases.reduce<string | null>(
      (max, c) =>
        c.metrics.peakExposedUsdMinor === null
          ? max
          : max === null || BigInt(c.metrics.peakExposedUsdMinor) > BigInt(max)
            ? c.metrics.peakExposedUsdMinor
            : max,
      null,
    ),
  };
}
/**
 * One lightweight row per executed case, for dashboards. Excludes the event
 * transcript and ledger snapshots; open the run for evidence.
 */
export function caseSummaries(run: Run) {
  return run.cases.map((c) => {
    const claim = c.evidence.findLast(
      (e) => e.kind === 'task-status' && e.trust === 'agent-reported',
    )?.payload;
    const claimObject =
      claim !== null && typeof claim === 'object' && !Array.isArray(claim) ? claim : {};
    const narrative = c.evidence.findLast(
      (event) => event.kind === 'agent.final_claim' && event.trust === 'agent-reported',
    )?.payload;
    const narrativeObject =
      narrative !== null && typeof narrative === 'object' && !Array.isArray(narrative)
        ? narrative
        : {};
    const failed = c.assertions.filter((a) => a.verdict === 'FAIL');
    const o = caseOutcomes(c);
    return {
      runId: run.id,
      projectId: run.projectId,
      createdAt: run.createdAt,
      runStatus: run.status,
      profile: run.profile,
      pack: run.pack,
      agentName: run.manifest.agentName,
      caseId: c.caseId,
      scenarioId: c.scenarioId,
      title: c.title,
      family: c.family,
      verdict: c.verdict,
      taskStatus: c.taskStatus,
      claimStatus: typeof claimObject.status === 'string' ? claimObject.status : null,
      claimSummary:
        typeof narrativeObject.claim === 'string'
          ? narrativeObject.claim
          : typeof claimObject.summary === 'string'
            ? claimObject.summary
            : null,
      intendedUsdMinor: c.scenario.amountUsdMinor,
      executedUsdMinor: c.metrics.executedUsdMinor,
      simulatedLossUsdMinor: c.metrics.simulatedLossUsdMinor,
      policyOverrunUsdMinor: c.metrics.policyOverrunUsdMinor,
      approvalCapacityUsdMinor: c.metrics.approvalCapacityUsdMinor,
      failedChecks: failed.length,
      firstFailure: failed[0]?.reason ?? null,
      coverageComplete: c.coverage.complete,
      role: o.role,
      safety: o.safety,
      honestReport: o.honestReport,
      taskDone: o.taskDone,
      headline: o.headline,
      afterAmbiguousReply: o.afterAmbiguousReply ?? null,
    };
  });
}
function renderPath(p: PathAssessment): string {
  const e = escapeHtml;
  return `<h3>What this run established</h3>
    <p><b>Financial outcome:</b> ${e(moneyDisplay(p.financialOutcome.settledUsdMinor))} / ${e(moneyDisplay(p.financialOutcome.authorityUsdMinor))} authority. ${e(p.financialOutcome.summary)}.</p>
    <p><b>Observed financial harm:</b> ${e(p.observedFinancialHarm)} (principal movement in the recorded scope).</p>
    <p><b>Target safety property:</b> ${e(p.targetSafetyProperty)}. ${e(p.targetSafetyExplanation)}</p>
    <p><b>Task correctness:</b> ${e(p.taskCorrectness)}. ${e(p.taskDetail)}</p>
    <p><b>Financial truth:</b> ${e(p.financialEnvironment.label)}. ${e(p.financialEnvironment.description)}<br><b>Network:</b> ${e(p.financialEnvironment.network)}<br><b>Transactions settled:</b> ${e(p.transactionsSettled ?? 'Unknown')}<br><b>Authority source:</b> ${e(p.financialEnvironment.authoritySource)}</p>
    <p><b>Agent intent / attempts:</b> ${e(p.agentIntent)}</p>
    <p><b>Expected test path:</b> ${e(p.expectedPath.join(' → '))}<br><b>Observed path:</b> ${e(p.observedPath.join(' → '))}</p>
    <p><b>Did the target guardrail cause the stop?</b> ${e(p.guardrail.summary)}</p>
    ${p.whyNotPass ? `<p><b>Why not PASS?</b> ${e(p.whyNotPass)}</p>` : ''}
    ${p.whyNotFail ? `<p><b>Why not FAIL?</b> ${e(p.whyNotFail)}</p>` : ''}
    <table><tr><th>Test path</th><th>State</th><th>Evidence</th></tr>${p.steps.map((s) => `<tr><td>${e(s.label)}</td><td>${e(s.state)}</td><td>${e(s.detail)}${s.evidenceSeqs.length ? ' Events: ' + e(s.evidenceSeqs.join(', ')) : ''}</td></tr>`).join('')}</table>
    <p class="note">${e(p.financialOutcome.source)}. ${e(p.reasons.join(' · '))}</p>`;
}
function renderOutcomes(c: Run['cases'][number]): string {
  const e = escapeHtml,
    o = caseOutcomes(c);
  const rows: [string, string][] = [
    ['Safety (money moved or tried beyond authority)', o.safety],
    ['Honest report (final answer agrees with the ledger)', o.honestReport],
    ['Task done (or correctly left undone)', o.taskDone],
    ['Evidence complete enough to grade', o.evidence],
  ];
  return `<p><b>${e(o.headline)}.</b>${o.role === 'agent-test' ? '' : ` <small>(${e(o.role)}: checks the test, not the agent)</small>`}</p>
    <table><tr><th>Question</th><th>Answer</th></tr>${rows.map(([q, a]) => `<tr><td>${e(q)}</td><td>${e(a)}</td></tr>`).join('')}</table>
    ${o.afterAmbiguousReply ? `<p><b>After the unclear reply:</b> ${e(o.afterAmbiguousReply)}${o.duplicatePreventedBy ? `; second payment prevented by: ${e(o.duplicatePreventedBy)}` : ''}.</p>` : ''}
    ${o.guardBlocked ? `<p><b>Platform guard refused:</b> ${e(o.guardBlocked.map((b) => `#${b.seq} ${b.reasons.join(', ')}`).join('; '))}. A refusal shows what the agent attempted; it is graded as an attempt.</p>` : ''}`;
}
export function renderReport(run: Run, paths: Record<string, PathAssessment> = {}): string {
  const s = summary(run);
  const e = escapeHtml;
  const environments =
    [
      ...new Set(
        run.cases.map(
          (c) => (paths[c.caseId] ?? assessTestPath(run, c)).financialEnvironment.label,
        ),
      ),
    ].join(', ') || 'UNKNOWN';
  const counts = Object.entries(s.counts)
    .map(
      ([name, count]) => `<div class="metric"><strong>${count}</strong><span>${name}</span></div>`,
    )
    .join('');
  const details = run.cases
    .map(
      (
        c,
      ) => `<section id="${e(c.caseId)}"><div class="eyebrow">${e(c.caseId)} / ${e(c.family)}</div><h2>${e(c.title)} <span class="verdict ${e(c.verdict.toLowerCase())}">${e(c.verdict)}</span></h2>
    <p>${e(c.scenario.description)}</p>${renderOutcomes(c)}${renderPath(paths[c.caseId] ?? assessTestPath(run, c))}<p>Recorded evidence coverage: ${c.coverage.complete ? 'complete' : 'incomplete'}${c.coverage.missing.length ? ' - ' + e(c.coverage.missing.join(', ')) : ''}. Task: ${e(c.taskStatus)}.</p>
    <table><tr><th>Capital measure</th><th>USD at recorded valuation</th></tr>${[
      ['Gross attempted movement', c.metrics.attemptedUsdMinor],
      ['Executed movement', c.metrics.executedUsdMinor],
      ['Peak modeled exposure', c.metrics.peakExposedUsdMinor],
      ['Simulated loss', c.metrics.simulatedLossUsdMinor],
      ['Scenario-bounded potential loss', c.metrics.maximumPotentialLossUsdMinor],
      ['Largest per-action amount overrun', c.metrics.policyOverrunUsdMinor],
      ['Duplicate principal', c.metrics.duplicatePrincipalUsdMinor],
    ]
      .map(([name, value]) => `<tr><td>${e(name)}</td><td>${moneyDisplay(value ?? null)}</td></tr>`)
      .join('')}</table>
    <p class="note">${c.metrics.assumptions.map(e).join(' ')}</p>
    <table><tr><th>Rule / layer</th><th>Verdict</th><th>Evidence / explanation</th></tr>${c.assertions.map((a) => `<tr><td>${e(a.ruleId)}<br><small>${e(a.layer)}</small></td><td>${e(a.verdict)}</td><td>${e(a.reason)}<br><small>Events: ${e(a.evidenceSeqs.join(', ') || 'none required')}</small></td></tr>`).join('')}</table>
    <details><summary>Configured stimulus (check events for delivery)</summary><pre>${e(JSON.stringify(c.stimulus, null, 2))}</pre></details>
    <details><summary>Ordered observable evidence (${c.evidence.length} events)</summary>${c.evidence.map((event) => `<article><b>#${event.seq} ${e(event.kind)}</b> <small>${e(event.virtualTimeMs)} ms / ${e(event.trust)}</small><pre>${e(JSON.stringify(event.payload, null, 2))}</pre></article>`).join('')}</details>
    <p class="hash">Evidence SHA-256: ${e(c.evidenceHash)}<br>Canonical result: ${e(c.canonicalResultHash)}</p></section>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>EmberTail report ${e(run.id)}</title><style>
  :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f3f5f3;color:#192829;font:15px/1.55 system-ui,sans-serif}main{max-width:1000px;margin:40px auto;padding:32px;background:white;border:1px solid #d6dfda}h1{font-size:40px;letter-spacing:-1.5px}h2{font-size:23px}.eyebrow{font:12px monospace;color:#a64331;text-transform:uppercase}section{padding-top:35px;margin-top:35px;border-top:1px solid #d6dfda}.metrics{display:flex;gap:14px;flex-wrap:wrap}.metric{padding:16px 25px;background:#f2f5f3}.metric strong{display:block;font:32px monospace}.metric span,small,.note,.hash{color:#68746e;font-size:12px}.verdict{font:11px monospace;padding:5px 8px;border:1px solid #ddd}.fail{color:#a12f28;background:#fff1ef}.pass{color:#267347;background:#eff8f1}.inconclusive{color:#8b6718;background:#fff8e7}table{border-collapse:collapse;width:100%;margin:20px 0}th{text-align:left;background:#eef2ef}td,th{padding:10px;border-bottom:1px solid #d6dfda;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f3;padding:14px;font-size:12px}details{margin:12px 0}summary{cursor:pointer}article{margin-top:14px}.hash{overflow-wrap:anywhere}a{color:#a64331}.banner{padding:14px;border-left:3px solid #b74331;background:#f7f2ed}
  </style></head><body><main><div class="eyebrow">EMBERTAIL / LOCAL TECHNICAL REPORT</div><h1>Evidence before execution.</h1><p class="banner">Financial environment: ${e(environments)}. ${e(run.manifest.mode)} agent. This report covers the recorded suite and versions only. A passing result is not a production safety certification.</p><p>Run ${e(run.id)}<br>Agent: ${e(run.manifest.agentName)} / ${e(run.profile)}<br>Created: ${e(run.createdAt)}<br>Environment: ${e(run.manifest.environment)} / ${e(run.status)}<br>Seed: ${e(run.seed)}</p><div class="metrics">${counts}</div><p>${s.scenarioCount} scenario definitions / ${s.caseCount} executed cases. Independent cases reset state; loss maxima are not summed into one portfolio forecast.</p><h2>Scope and limitations</h2><ul>${run.manifest.limitations.map((l) => `<li>${e(l)}</li>`).join('')}</ul><p>Report escapes source text. Arbitrary customer text may still contain secrets; review locally before sharing. Private chain-of-thought is neither requested nor recorded.</p><h2>Mandate</h2><pre>${e(JSON.stringify(run.mandate, null, 2))}</pre><h2>Case index</h2><ul>${run.cases.map((c) => `<li><a href="#${e(c.caseId)}">${e(c.caseId)} - ${e(c.title)}</a> ${c.verdict}</li>`).join('')}</ul>${details}<section><h2>Reproduction</h2><pre>npm run embertail -- replay ${e(run.id)} --verify</pre><p>Use the original local data directory. Replay reconstructs recorded actions without a model or network. Rerunning the agent produces a separate observation.</p><pre>${e(JSON.stringify(run.manifest, null, 2))}</pre></section></main></body></html>`;
}
export async function writeReport(run: Run, store: Store): Promise<string> {
  const file = path.join(store.runDir(run.id), 'report.html');
  await writeFile(file, renderReport(run), { encoding: 'utf8', mode: 0o600 });
  return file;
}
