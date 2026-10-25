import type { AppConfig } from './config';
import { WSL_NOT_FOUND, type SpawnFn } from './childTypes';
import { buildWslArgs } from './wslArgs';

export interface WslResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export function cleanWslText(text: string): string {
  return text.replace(/\0/g, '').trim();
}

export function runWsl(spawn: SpawnFn, distro: string | null, argv: string[], timeoutMs = 60000): Promise<WslResult> {
  return new Promise<WslResult>((resolve, reject) => {
    let args: string[];
    try {
      args = buildWslArgs(distro, argv);
    } catch (e) {
      reject(e);
      return;
    }
    const child = spawn('wsl.exe', args);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`wsl.exe ${argv.join(' ')} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const toBuf = (c: unknown): Buffer => (Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8'));
    child.stdout.on('data', (c) => out.push(toBuf(c)));
    child.stderr.on('data', (c) => err.push(toBuf(c)));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(WSL_NOT_FOUND) : e);
    });
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

export async function resolveEntry(spawn: SpawnFn, config: AppConfig): Promise<string> {
  const d = config.distro;
  const where = d === null ? 'the default distro' : `distro '${d}'`;
  const fmt = (r: WslResult): string =>
    `exit code ${r.exitCode}; wsl output: '${cleanWslText(r.stdout)}'; stderr: '${cleanWslText(r.stderr)}'`;

  const r = await runWsl(spawn, d, ['--exec', '/bin/true']);
  if (r.exitCode !== 0) {
    throw new Error(`WSL could not run anything in ${where} (${fmt(r)}). Check the exact name with: wsl -l -v`);
  }

  let path: string;
  if (config.entryPath) {
    path = config.entryPath;
  } else {
    const r1 = await runWsl(spawn, d, ['--exec', '/usr/bin/printenv', 'HOME']);
    let home = cleanWslText(r1.stdout);
    if (!home.startsWith('/')) {
      const r2 = await runWsl(spawn, d, ['--cd', '~', '--exec', '/bin/pwd']);
      home = cleanWslText(r2.stdout);
      if (!home.startsWith('/')) {
        throw new Error(
          `Could not find your home folder in ${where} (${fmt(r2)}). Set entryPath to /home/<you>/.local/bin/agent-studio (see app/README.md)`,
        );
      }
    }
    path = `${home}/.local/bin/agent-studio`;
  }

  const t = await runWsl(spawn, d, ['--exec', '/usr/bin/test', '-x', path]);
  if (t.exitCode !== 0) {
    throw new Error(
      `agent-studio is not installed at ${path} in ${where}. Inside WSL run: bash /mnt/c/Works/Projects/AgentStudio/backend/install.sh`,
    );
  }
  return path;
}
