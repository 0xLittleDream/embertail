import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  assertMandate,
  canonical,
  hash,
  type Project,
  type Run,
} from '../../contracts/src/index.js';

export { defaultDataDir } from './data-directory.js';
import { defaultDataDir } from './data-directory.js';
import type { NativeRun } from '../../contracts/src/native.js';
function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid ID');
  return id;
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, canonical(value) + '\n', { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
}
export class Store {
  constructor(readonly root = defaultDataDir()) {}
  nativeRunDir(id: string): string {
    return path.join(this.root, 'native-runs', safeId(id));
  }
  async saveNativeRun(run: NativeRun): Promise<void> {
    const dir = this.nativeRunDir(run.id);
    if (run.status !== 'running') {
      const content = nativeBundle(run);
      const files: Record<string, string> = {};
      for (const [name, value] of Object.entries(content)) {
        await atomicJson(path.join(dir, name), value);
        files[name] = hash(await readFile(path.join(dir, name), 'utf8'));
      }
      await atomicJson(path.join(dir, 'integrity.json'), { runHash: hash(run), files });
    }
    await atomicJson(path.join(dir, 'run.json'), run);
  }
  async nativeRun(id: string, verify = false): Promise<NativeRun> {
    const dir = this.nativeRunDir(id);
    const run = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8')) as NativeRun;
    if (
      run.id !== id ||
      run.schemaVersion !== 'embertail.native-run/1' ||
      run.runtime !== 'native-component'
    )
      throw Error('Stored native run identity mismatch');
    if (verify) {
      if (run.status === 'running') throw Error('Cannot replay an unfinished native run');
      const integrity = JSON.parse(await readFile(path.join(dir, 'integrity.json'), 'utf8'));
      if (hash(run) !== integrity.runHash) throw Error('Native run integrity mismatch');
      for (const [name, expected] of Object.entries(nativeBundle(run))) {
        const raw = await readFile(path.join(dir, name), 'utf8');
        if (
          hash(raw) !== integrity.files[name] ||
          canonical(JSON.parse(raw)) !== canonical(expected)
        )
          throw Error('Native evidence bundle content mismatch: ' + name);
      }
    }
    return run;
  }
  async nativeRuns(): Promise<NativeRun[]> {
    let entries;
    try {
      entries = await readdir(path.join(this.root, 'native-runs'), { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    return (
      await Promise.all(entries.filter((e) => e.isDirectory()).map((e) => this.nativeRun(e.name)))
    ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  runDir(id: string): string {
    return path.join(this.root, 'runs', safeId(id));
  }
  async createProject(
    name: string,
    mandate: Project['mandate'],
    capitalUsdMinor: string,
  ): Promise<Project> {
    assertMandate(mandate);
    if (!name.trim() || name.length > 100) throw new Error('Project name must be 1-100 characters');
    if (!/^[1-9]\d{0,11}$/.test(capitalUsdMinor))
      throw new Error('Capital must be positive minor USD units, at most 12 digits');
    const project: Project = {
      id: randomUUID(),
      name: name.trim(),
      createdAt: new Date().toISOString(),
      mandate,
      capitalUsdMinor,
    };
    await atomicJson(path.join(this.root, 'projects', project.id + '.json'), project);
    return project;
  }
  async project(id: string): Promise<Project> {
    const project = JSON.parse(
      await readFile(path.join(this.root, 'projects', safeId(id) + '.json'), 'utf8'),
    ) as Project;
    assertMandate(project.mandate);
    if (
      project.id !== id ||
      typeof project.name !== 'string' ||
      !/^[1-9]\d{0,11}$/.test(project.capitalUsdMinor)
    )
      throw new Error('Invalid stored project');
    return project;
  }
  async projects(): Promise<Project[]> {
    try {
      const files = await readdir(path.join(this.root, 'projects'));
      return Promise.all(
        files.filter((f) => f.endsWith('.json')).map(async (f) => this.project(f.slice(0, -5))),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }
  async saveRun(run: Run): Promise<void> {
    const dir = this.runDir(run.id);
    if (run.status !== 'running') {
      await mkdir(dir, { recursive: true });
      const bundle = bundleContent(run);
      await atomicJson(path.join(dir, 'manifest.json'), bundle.manifest);
      await writeFile(path.join(dir, 'events.jsonl'), bundle.events, { mode: 0o600 });
      await atomicJson(path.join(dir, 'result.json'), bundle.result);
      const files: Record<string, string> = {};
      for (const name of ['manifest.json', 'events.jsonl', 'result.json'])
        files[name] = hash(await readFile(path.join(dir, name), 'utf8'));
      await atomicJson(path.join(dir, 'integrity.json'), {
        runHash: hash(run),
        files,
        purpose: 'Local accidental-corruption detection; no authenticity claim',
      });
    }
    // Publish terminal status only after the complete evidence bundle is available.
    await atomicJson(path.join(dir, 'run.json'), run);
  }
  async run(id: string, verify = false): Promise<Run> {
    const dir = this.runDir(id);
    const run = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8')) as Run;
    if (run.id !== id) throw new Error('Stored run identity mismatch');
    if (verify) {
      if (run.status === 'running') throw new Error('Cannot replay an unfinished run');
      const integrity = JSON.parse(await readFile(path.join(dir, 'integrity.json'), 'utf8')) as {
        runHash: string;
        files: Record<string, string>;
      };
      if (hash(run) !== integrity.runHash) throw new Error('Run integrity mismatch');
      for (const name of ['manifest.json', 'events.jsonl', 'result.json']) {
        if (hash(await readFile(path.join(dir, name), 'utf8')) !== integrity.files?.[name])
          throw new Error('Evidence bundle integrity mismatch: ' + name);
      }
      const expected = bundleContent(run);
      if (
        canonical(JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'))) !==
          canonical(expected.manifest) ||
        canonical(JSON.parse(await readFile(path.join(dir, 'result.json'), 'utf8'))) !==
          canonical(expected.result) ||
        (await readFile(path.join(dir, 'events.jsonl'), 'utf8')) !== expected.events
      )
        throw new Error('Evidence bundle content differs from run');
    }
    return run;
  }
  async runs(): Promise<Run[]> {
    let dirs: string[];
    try {
      dirs = (await readdir(path.join(this.root, 'runs'), { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const values = await Promise.all(
      dirs.map(async (id) => {
        try {
          return await this.run(id);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw new Error(`Cannot read stored run ${id}`, { cause: error });
        }
      }),
    );
    return values
      .filter((v): v is Run => v !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
function nativeBundle(run: NativeRun) {
  return {
    'manifest.json': { ...run.manifest, manifestHash: run.manifestHash, runId: run.id },
    'events.json': run.cases.flatMap((c) => c.evidence.map((e) => ({ caseId: c.caseId, ...e }))),
    'result.json': {
      verdict: run.verdict,
      agentVerdict: null,
      cases: run.cases.map(({ evidence, ...c }) => c),
    },
    'packet.json': run.packet,
  };
}
function bundleContent(run: Run) {
  return {
    manifest: {
      ...run.manifest,
      manifestHash: run.manifestHash,
      runId: run.id,
      mandate: run.mandate,
      seed: run.seed,
      pack: run.pack,
    },
    events:
      run.cases
        .flatMap((c) => c.evidence.map((e) => canonical({ caseId: c.caseId, ...e })))
        .join('\n') + '\n',
    result: { verdict: run.verdict, cases: run.cases.map(({ evidence, ...c }) => c) },
  };
}
