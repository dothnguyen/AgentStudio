import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SpawnFn } from '../src/main/childTypes';
import { makePrepare } from '../src/main/connection';
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

const cfgPath = path.join(os.tmpdir(), 'no-such-dir-t004', 'config.json');

describe('makePrepare', () => {
  it('returns the target from config and resolveEntry', async () => {
    const { spawn, calls } = scripted([{ code: 0 }, { stdout: '/home/u\n', code: 0 }, { code: 0 }]);
    const prepare = makePrepare(spawn, { AGENT_STUDIO_DISTRO: 'D', AGENT_STUDIO_REQUEST_TIMEOUT_MS: '5000' }, cfgPath);
    await expect(prepare()).resolves.toEqual({
      distro: 'D',
      entry: '/home/u/.local/bin/agent-studio',
      requestTimeoutMs: 5000,
    });
    expect(calls[0].args).toEqual(['-d', 'D', '--exec', '/bin/true']);
  });

  it('re-reads env on each call', async () => {
    const { spawn } = scripted(Array.from({ length: 6 }, () => ({ code: 0 })));
    const env: Record<string, string | undefined> = { AGENT_STUDIO_ENTRY: '/a/one' };
    const prepare = makePrepare(spawn, env, cfgPath);
    expect((await prepare()).entry).toBe('/a/one');
    env.AGENT_STUDIO_ENTRY = '/a/two';
    expect((await prepare()).entry).toBe('/a/two');
  });
});
