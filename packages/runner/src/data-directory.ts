import { lstatSync, mkdirSync, readlinkSync, statSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LEGACY_DATA_ENV = 'REDTAIL_DATA_DIR';
const LEGACY_DATA_FOLDER = 'RedTailLabs';

function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.EMBERTAIL_DATA_DIR ?? env[LEGACY_DATA_ENV];
  if (override !== undefined) return override;
  const base = env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share');
  const directory = path.join(base, 'EmberTail');
  const legacy = path.join(base, LEGACY_DATA_FOLDER);
  // Alias the existing store without moving it or rewriting retained evidence.
  // New installations simply create EmberTail when the Store first writes.
  if (!exists(directory) && exists(legacy) && statSync(legacy).isDirectory()) {
    mkdirSync(base, { recursive: true });
    try {
      symlinkSync(
        path.resolve(legacy),
        directory,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !exists(directory)) {
        throw new Error(
          `Cannot link the existing data store. Set EMBERTAIL_DATA_DIR to ${legacy} to use it.`,
          { cause: error },
        );
      }
    }
  }
  if (exists(directory)) {
    try {
      if (!statSync(directory).isDirectory()) throw Error('Data path is not a directory');
    } catch (error) {
      // Use only the original verified target when a Windows junction cannot
      // be traversed by Node. Never silently open a fresh, empty store.
      const alias = lstatSync(directory).isSymbolicLink();
      if (
        alias &&
        exists(legacy) &&
        statSync(legacy).isDirectory() &&
        path.resolve(path.dirname(directory), readlinkSync(directory)) === path.resolve(legacy)
      )
        return legacy;
      throw new Error(
        'Existing EmberTail data directory is unavailable; repair its link or set EMBERTAIL_DATA_DIR to the retained store.',
        { cause: error },
      );
    }
  }
  return directory;
}
