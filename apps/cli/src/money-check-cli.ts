import { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { Store, replayRun } from '../../../packages/runner/src/index.js';
import { defaultDataDir } from '../../../packages/runner/src/store.js';
import { MONEY_CHECK_VERSION } from '../../../packages/reports/src/money-check.js';
import { writeReport } from '../../../packages/reports/src/index.js';
import { addCheckCommand } from './check-command.js';

/**
 * `embertail-check`: the standalone Money Check CLI, bundled into the installable package by
 * scripts/package-money-check.mjs. It carries only what Money Check needs: `check`, plus
 * `replay` and `report` for the evidence a check leaves behind.
 */
const program = new Command()
  .name('embertail-check')
  .description(
    'EmberTail Money Check: test whether your AI agent keeps money correct, on a deterministic simulated ledger.',
  )
  .version(MONEY_CHECK_VERSION)
  .option(
    '--data-dir <path>',
    'Where runs and evidence are kept (or set EMBERTAIL_DATA_DIR)',
    defaultDataDir(),
  );
const store = () => new Store(program.opts<{ dataDir: string }>().dataDir);

addCheckCommand(program, store, 'embertail-check');
program
  .command('replay')
  .description('Replay a run from its stored evidence, offline')
  .argument('<run-id>')
  .option('--verify', 'Verify evidence hashes and reconstruct state')
  .action(async (id: string) => {
    console.log(JSON.stringify(replayRun(await store().run(id, true)), null, 2));
  });
program
  .command('report')
  .description('Write the HTML report for a run')
  .argument('<run-id>')
  .option('--output <path>', 'Copy the report to this path')
  .action(async (id: string, options: { output?: string }) => {
    const file = await writeReport(await store().run(id, true), store());
    if (options.output) await writeFile(options.output, await readFile(file), { mode: 0o600 });
    console.log(options.output ?? file);
  });
program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 3;
});
