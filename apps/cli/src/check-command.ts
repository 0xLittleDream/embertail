import { Command, Option } from 'commander';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_MANDATE, type Profile, type Run } from '../../../packages/contracts/src/index.js';
import { Store, executeRun } from '../../../packages/runner/src/index.js';
import { writeReport } from '../../../packages/reports/src/index.js';
import { writeMoneyCheck } from '../../../packages/reports/src/money-check.js';
import { caseOutcomes } from '../../../packages/grading/src/outcomes.js';
import type { Adapter } from '../../../packages/runner/src/connector.js';

/**
 * The run options and the Money Check `check` command, shared by the full `embertail` CLI
 * and the standalone `embertail-check` package (apps/cli/src/money-check-cli.ts).
 */
export type RunCliOptions = {
  profile: string;
  pack: string;
  project?: string;
  seed: string;
  adapter?: string;
  trustedAgent?: boolean;
  guard: string;
};

export function withRunOptions(command: Command, defaultPack: string): Command {
  return command
    .option('--profile <profile>', 'vulnerable or corrected', 'vulnerable')
    .option(
      '--pack <pack>',
      'milestone, core, incidents, full, promoted or scenario IDs (S19,S37)',
      defaultPack,
    )
    .option('--project <id>', 'Existing project ID')
    .option('--seed <seed>', 'Fixture seed', 'embertail-v0.1')
    .option('--adapter <json>', 'Trusted local subprocess descriptor')
    .option('--trusted-agent', 'Acknowledge custom agent code is trusted and not sandboxed')
    .option(
      '--guard <guard>',
      'Platform guard in the simulator: reference (hard limits only) or strict (also blocks budget, recipient, reserve and approval violations before they execute)',
      'reference',
    );
}

export async function runFromCli(options: RunCliOptions, database: Store) {
  if (!['vulnerable', 'corrected'].includes(options.profile)) throw new Error('Unknown profile');
  if (!['reference', 'strict'].includes(options.guard))
    throw new Error('Unknown guard: use reference or strict');
  let adapter: Adapter | undefined;
  if (options.adapter) {
    if (!options.trustedAgent)
      throw new Error('Custom agents require --trusted-agent. This runner does not sandbox code.');
    const a = JSON.parse(await readFile(options.adapter, 'utf8')) as Adapter;
    if (
      typeof a.name !== 'string' ||
      !a.name ||
      typeof a.version !== 'string' ||
      !a.version ||
      typeof a.command !== 'string' ||
      !a.command ||
      !Array.isArray(a.args) ||
      a.args.some((x) => typeof x !== 'string') ||
      !Array.isArray(a.capabilities) ||
      a.capabilities.some((x) => typeof x !== 'string') ||
      (a.model !== undefined && (typeof a.model !== 'string' || !a.model.trim())) ||
      (a.wallTimeMs !== undefined &&
        (!Number.isSafeInteger(a.wallTimeMs) || a.wallTimeMs < 1000 || a.wallTimeMs > 300000)) ||
      (a.inheritEnv !== undefined &&
        (!Array.isArray(a.inheritEnv) ||
          a.inheritEnv.length > 8 ||
          a.inheritEnv.some((x) => typeof x !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(x))))
    )
      throw new Error('Invalid adapter descriptor');
    adapter = a;
  }
  const projects = await database.projects();
  const project = options.project
    ? await database.project(options.project)
    : (projects[0] ??
      (await database.createProject('Treasury regression', DEFAULT_MANDATE, '1000000')));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  let reported = 0;
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let run: Run;
  try {
    run = await executeRun(
      {
        project,
        profile: adapter ? 'external' : (options.profile as Profile),
        guard: options.guard as 'reference' | 'strict',
        pack: options.pack,
        seed: options.seed,
        adapter,
        signal: controller.signal,
        onProgress: async (current) => {
          if (current.cases.length > reported) {
            reported = current.cases.length;
            const c = current.cases.at(-1)!;
            process.stderr.write(
              `${c.caseId} ${c.verdict} - ${c.title} (${caseOutcomes(c).headline})\n`,
            );
          }
        },
      },
      database,
    );
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
  return { run, database };
}

/**
 * Adds `check`: run a pack against an agent and write the Money Check CI outputs.
 * `replayCommand` names the command that replays a run (`embertail` or `embertail-check`).
 */
export function addCheckCommand(
  program: Command,
  store: () => Store,
  replayCommand: string,
): Command {
  return withRunOptions(
    program
      .command('check')
      .description(
        'Money Check: run a pack against your agent and write CI outputs (summary, JUnit, SARIF, badge)',
      ),
    'core',
  )
    .option('--out <dir>', 'Directory for the Money Check outputs', 'embertail-money-check')
    .addOption(
      new Option('--fail-on <level>', 'Exit non-zero on FAIL only, or on INCONCLUSIVE too')
        .choices(['fail', 'inconclusive'])
        .default('fail'),
    )
    .action(async (options: RunCliOptions & { out: string; failOn: 'fail' | 'inconclusive' }) => {
      const { run, database } = await runFromCli(options, store());
      const report = await writeReport(run, database);
      const artifactUri = options.adapter
        ? path.relative(process.cwd(), path.resolve(options.adapter)).split(path.sep).join('/')
        : 'embertail-money-check';
      const { result, files } = await writeMoneyCheck(run, path.resolve(options.out), {
        artifactUri,
        reportPath: report,
        replayCommand: `${replayCommand} replay ${run.id} --verify`,
      });
      console.log(
        JSON.stringify(
          {
            verdict: result.verdict,
            counts: result.counts,
            rules: Object.fromEntries(result.rules.map((r) => [r.id, r.status])),
            runId: run.id,
            report,
            outputs: files,
            dataDirectory: database.root,
          },
          null,
          2,
        ),
      );
      process.exitCode =
        run.status === 'error'
          ? 3
          : result.verdict === 'FAIL'
            ? 1
            : run.status === 'cancelled' ||
                (options.failOn === 'inconclusive' && result.verdict === 'INCONCLUSIVE')
              ? 2
              : 0;
    });
}
