import { describe, expect, it } from 'vitest';
import { assertSafeArg, buildWslArgs } from '../src/main/wslArgs';

describe('wslArgs', () => {
  it('accepts safe literals', () => {
    for (const v of ['Ubuntu-24.04', '/home/me/.local/bin/agent-studio', 'serve', '~']) {
      expect(() => assertSafeArg(v)).not.toThrow();
    }
  });

  it('rejects unsafe values with the exact message', () => {
    for (const v of ['', 'a b', 'a;b', '$(x)', 'ü', '"q"']) {
      expect(() => assertSafeArg(v)).toThrow(
        `Refusing to put '${v}' on the wsl.exe command line; only fixed literals are allowed there.`,
      );
    }
  });

  it('builds argument arrays', () => {
    expect(buildWslArgs('Ubuntu', ['--exec', '/x', 'serve'])).toEqual(['-d', 'Ubuntu', '--exec', '/x', 'serve']);
    expect(buildWslArgs(null, ['--exec', '/x', 'serve'])).toEqual(['--exec', '/x', 'serve']);
    expect(() => buildWslArgs('my distro', ['--exec'])).toThrow();
  });

  it('returns a fresh argument array on every call', () => {
    const first = buildWslArgs(null, ['--exec', '/x', 'serve']);
    const second = buildWslArgs(null, ['--exec', '/x', 'serve']);

    expect(first).not.toBe(second);
    first.push('changed');
    expect(second).toEqual(['--exec', '/x', 'serve']);
  });

  it('validates every command-line value before returning arguments', () => {
    expect(() => buildWslArgs('bad distro', ['--exec', '/x'])).toThrow(
      "Refusing to put 'bad distro' on the wsl.exe command line; only fixed literals are allowed there.",
    );
    expect(() => buildWslArgs(null, ['--exec', 'user supplied text'])).toThrow(
      "Refusing to put 'user supplied text' on the wsl.exe command line; only fixed literals are allowed there.",
    );
    expect(() => buildWslArgs(null, ['--exec', ''])).toThrow(
      "Refusing to put '' on the wsl.exe command line; only fixed literals are allowed there.",
    );
  });
});
