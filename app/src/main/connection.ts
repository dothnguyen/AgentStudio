import { spawn as cpSpawn } from 'node:child_process';
import type { SpawnFn } from './childTypes';
import { loadConfig } from './config';
import { resolveEntry } from './resolveEntry';
import type { ConnectTarget } from './serveClient';

export const realSpawn: SpawnFn = (cmd, args) =>
  cpSpawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });

export function makePrepare(
  spawn: SpawnFn,
  env: Record<string, string | undefined>,
  configPath: string,
): () => Promise<ConnectTarget> {
  return async () => {
    const c = loadConfig(env, configPath);
    const entry = await resolveEntry(spawn, c);
    return { distro: c.distro, entry, requestTimeoutMs: c.requestTimeoutMs };
  };
}
