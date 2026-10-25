import { describe, expect, it } from 'vitest';
import type { SpawnFn } from '../src/main/childTypes';
import { DEFAULT_CONFIG, type AppConfig } from '../src/main/config';
import { resolveEntry, runWsl } from '../src/main/resolveEntry';
import { FakeChild } from './fakeChild';

interface Step {
  stdout?: string;
  stderr?: string;
  code: number;
}

function scripted(steps: Step[]) {
  const calls: { command: string; args: string[] }[] = [];
  let i = 0;
  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args });
    const step = steps[i++] ?? { code: 0 };
    const c = new FakeChild();
    setImmediate(() => {
      if (step.stdout) c.stdout.write(step.stdout);
      if (step.stderr) c.stderr.write(step.stderr);
      setImmediate(() => c.exit(step.code));
    });
    return c;
  };
  return { spawn, calls };
}

const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({ ...DEFAULT_CONFIG, distro: 'Ubuntu', ...over });
const INSTALL = 'Inside WSL run: bash /mnt/c/Works/Projects/AgentStudio/backend/install.sh';

describe('resolveEntry', () => {
  it('runWsl collects both output streams until close and preserves UTF-8', async () => {
    const child = new FakeChild();
    const calls: { command: string; args: string[] }[] = [];
    const spawn: SpawnFn = (command, args) => {
      calls.push({ command, args });
      setImmediate(() => {
        child.stdout.write(Buffer.from([0x63, 0x61]));
        child.stderr.write('warn ');
        child.stdout.write(Buffer.from([0x66, 0xc3, 0xa9, 0x0a]));
        child.stderr.write('detail');
        child.emit('exit', 0, null);
        setImmediate(() => child.emit('close', 0, null));
      });
      return child;
    };

    await expect(runWsl(spawn, null, ['--exec', '/bin/true'])).resolves.toEqual({
      exitCode: 0,
      stdout: 'café\n',
      stderr: 'warn detail',
    });
    expect(calls).toEqual([{ command: 'wsl.exe', args: ['--exec', '/bin/true'] }]);
  });

  it('runWsl rejects unsafe arguments before spawning', async () => {
    let spawned = false;
    const spawn: SpawnFn = () => {
      spawned = true;
      return new FakeChild();
    };

    await expect(runWsl(spawn, null, ['--exec', '/home/me/my app'])).rejects.toThrow(
      "Refusing to put '/home/me/my app' on the wsl.exe command line; only fixed literals are allowed there.",
    );
    expect(spawned).toBe(false);
  });

  it('runWsl rejects when wsl.exe is missing', async () => {
    const child = new FakeChild();
    const spawn: SpawnFn = () => {
      setImmediate(() => child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })));
      return child;
    };
    await expect(runWsl(spawn, null, ['--exec', '/bin/true'])).rejects.toThrow(
      'wsl.exe was not found on this computer. Install WSL (wsl --install) and try again.',
    );
  });

  it('runWsl propagates non-ENOENT spawn errors', async () => {
    const child = new FakeChild();
    const spawn: SpawnFn = () => {
      setImmediate(() => child.emit('error', Object.assign(new Error('access denied'), { code: 'EACCES' })));
      return child;
    };
    await expect(runWsl(spawn, null, ['--exec', '/bin/true'])).rejects.toThrow('access denied');
  });

  it('runWsl kills and rejects a child that exceeds its timeout', async () => {
    const child = new FakeChild();
    const spawn: SpawnFn = () => child;
    await expect(runWsl(spawn, null, ['--exec', '/bin/true'], 5)).rejects.toThrow(
      'wsl.exe --exec /bin/true timed out after 5 ms',
    );
    expect(child.killed).toBe(true);
  });

  it('runWsl ignores a late close after the timeout has settled', async () => {
    const child = new FakeChild();
    const spawn: SpawnFn = () => child;
    const request = runWsl(spawn, null, ['--exec', '/bin/true'], 5);
    await expect(request).rejects.toThrow('timed out after 5 ms');
    child.stdout.write('late output');
    child.emit('close', 0, null);
    expect(child.killed).toBe(true);
  });

  it('uses a configured entryPath', async () => {
    const { spawn, calls } = scripted([{ code: 0 }, { code: 0 }]);
    expect(await resolveEntry(spawn, cfg({ entryPath: '/opt/as' }))).toBe('/opt/as');
    expect(calls.map((c) => c.args)).toEqual([
      ['-d', 'Ubuntu', '--exec', '/bin/true'],
      ['-d', 'Ubuntu', '--exec', '/usr/bin/test', '-x', '/opt/as'],
    ]);
    expect(calls.every((c) => c.command === 'wsl.exe')).toBe(true);
  });

  it('derives the path from HOME', async () => {
    const { spawn, calls } = scripted([{ code: 0 }, { code: 0, stdout: '/home/me\n' }, { code: 0 }]);
    expect(await resolveEntry(spawn, cfg())).toBe('/home/me/.local/bin/agent-studio');
    expect(calls.length).toBe(3);
  });

  it('falls back to pwd when HOME is empty', async () => {
    const { spawn, calls } = scripted([{ code: 0 }, { code: 0 }, { code: 0, stdout: '/home/me\n' }, { code: 0 }]);
    expect(await resolveEntry(spawn, cfg())).toBe('/home/me/.local/bin/agent-studio');
    expect(calls[2].args).toEqual(['-d', 'Ubuntu', '--cd', '~', '--exec', '/bin/pwd']);
  });

  it('reports when neither HOME nor pwd yields an absolute path', async () => {
    const { spawn, calls } = scripted([
      { code: 0 },
      { code: 0, stdout: 'relative-home\n' },
      { code: 1, stdout: 'relative-pwd\n', stderr: 'cannot determine cwd' },
    ]);
    await expect(resolveEntry(spawn, cfg())).rejects.toThrow(
      "Could not find your home folder in distro 'Ubuntu' (exit code 1; wsl output: 'relative-pwd'; stderr: 'cannot determine cwd'). Set entryPath to /home/<you>/.local/bin/agent-studio (see app/README.md)",
    );
    expect(calls.map((call) => call.args)).toEqual([
      ['-d', 'Ubuntu', '--exec', '/bin/true'],
      ['-d', 'Ubuntu', '--exec', '/usr/bin/printenv', 'HOME'],
      ['-d', 'Ubuntu', '--cd', '~', '--exec', '/bin/pwd'],
    ]);
  });

  it('resolves HOME in the default distro without adding -d', async () => {
    const { spawn, calls } = scripted([
      { code: 0 },
      { code: 0, stdout: '/home/me\0\n' },
      { code: 0 },
    ]);
    expect(await resolveEntry(spawn, cfg({ distro: null }))).toBe('/home/me/.local/bin/agent-studio');
    expect(calls.map((call) => call.args)).toEqual([
      ['--exec', '/bin/true'],
      ['--exec', '/usr/bin/printenv', 'HOME'],
      ['--exec', '/usr/bin/test', '-x', '/home/me/.local/bin/agent-studio'],
    ]);
  });

  it('reports a distro that cannot run anything, stripping NULs', async () => {
    const { spawn } = scripted([{ code: 1, stdout: 'T\0h\0e\0 \0d\0i\0s\0t\0r\0o\0' }]);
    await expect(resolveEntry(spawn, cfg())).rejects.toThrow(
      "WSL could not run anything in distro 'Ubuntu' (exit code 1; wsl output: 'The distro'",
    );
  });

  it('reports a missing install', async () => {
    const { spawn } = scripted([{ code: 0 }, { code: 0, stdout: '/home/me\n' }, { code: 1 }]);
    await expect(resolveEntry(spawn, cfg())).rejects.toThrow(
      `agent-studio is not installed at /home/me/.local/bin/agent-studio in distro 'Ubuntu'. ${INSTALL}`,
    );
  });

  it('omits -d for the default distro', async () => {
    const { spawn, calls } = scripted([{ code: 0 }, { code: 0, stdout: '/home/me\n' }, { code: 1 }]);
    await expect(resolveEntry(spawn, cfg({ distro: null }))).rejects.toThrow('in the default distro');
    expect(calls.some((c) => c.args.includes('-d'))).toBe(false);
  });
});
