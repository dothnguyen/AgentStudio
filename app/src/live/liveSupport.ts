import { cleanWslText } from '../main/resolveEntry';
import type { ConnectionState, StateChange } from '../main/serveClient';

export interface LiveOptions {
  distro: string | null;
  entry: string | null;
  repoWsl: string | null;
  out: string | null;
  keep: boolean;
}

export interface StateSource {
  readonly state: ConnectionState;
  readonly lastError: string | null;
  on(event: 'state', listener: (s: StateChange) => void): unknown;
  off(event: 'state', listener: (s: StateChange) => void): unknown;
}

export function parseArgs(argv: string[]): LiveOptions {
  const opts: LiveOptions = { distro: null, entry: null, repoWsl: null, out: null, keep: false };
  const valueFlags: Record<string, 'distro' | 'entry' | 'repoWsl' | 'out'> = {
    '--distro': 'distro',
    '--entry': 'entry',
    '--repo-wsl': 'repoWsl',
    '--out': 'out',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep') {
      opts.keep = true;
    } else if (arg in valueFlags) {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      opts[valueFlags[arg]] = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

export function toWslRepoPath(winPath: string): string {
  const m = /^([A-Za-z]):\\(.*)$/.exec(winPath);
  if (!m) throw new Error(`The repository must be on a local drive (or pass --repo-wsl): ${winPath}`);
  const joined = '/mnt/' + m[1].toLowerCase() + '/' + m[2].replace(/\\/g, '/');
  return joined.replace(/\/+$/, '');
}

export function withWslEnvVar(current: string | undefined, name: string): string {
  const parts = (current ?? '').split(':').filter((p) => p !== '' && p.split('/')[0] !== name);
  parts.push(name + '/u');
  return parts.join(':');
}

export function waitForState(client: StateSource, target: ConnectionState, timeoutMs: number): Promise<StateChange> {
  if (client.state === target) return Promise.resolve({ state: target, error: client.lastError });
  return new Promise((resolve, reject) => {
    const onState = (s: StateChange) => {
      if (s.state !== target) return;
      clearTimeout(timer);
      client.off('state', onState);
      resolve(s);
    };
    const timer = setTimeout(() => {
      client.off('state', onState);
      reject(
        new Error(
          `Timed out after ${timeoutMs} ms waiting for state ${target}; state is ${client.state}: ${client.lastError}`,
        ),
      );
    }, timeoutMs);
    client.on('state', onState);
  });
}

export function lastJsonLine(stdout: string): unknown {
  const lines = cleanWslText(stdout)
    .split('\n')
    .filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error(`No JSON output: ${stdout.slice(0, 200)}`);
  return JSON.parse(lines[lines.length - 1]);
}

export function allDistinct(values: string[]): boolean {
  return new Set(values).size === values.length;
}
