import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, loadConfig } from '../src/main/config';

const enoent = () => {
  throw Object.assign(new Error('nope'), { code: 'ENOENT' });
};
const file = (text: string) => () => text;

describe('loadConfig', () => {
  it('uses defaults when the file is missing', () => {
    expect(loadConfig({}, '/c.json', enoent)).toEqual(DEFAULT_CONFIG);
  });

  it('reads the file', () => {
    const c = loadConfig({}, '/c.json', file('{"distro":"Ubuntu","entryPath":"/opt/as","requestTimeoutMs":5000}'));
    expect(c).toEqual({ distro: 'Ubuntu', entryPath: '/opt/as', requestTimeoutMs: 5000 });
  });

  it('env overrides file and empty env is ignored', () => {
    const c = loadConfig(
      { AGENT_STUDIO_DISTRO: 'Debian', AGENT_STUDIO_REQUEST_TIMEOUT_MS: '2000', AGENT_STUDIO_ENTRY: '' },
      '/c.json',
      file('{"distro":"Ubuntu","entryPath":"/opt/as","requestTimeoutMs":5000}'),
    );
    expect(c).toEqual({ distro: 'Debian', entryPath: '/opt/as', requestTimeoutMs: 2000 });
  });

  it('rejects bad values with ConfigError', () => {
    const err = (env: Record<string, string>, text: string): ConfigError => {
      try {
        loadConfig(env, '/c.json', file(text));
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        return e as ConfigError;
      }
      throw new Error('expected throw');
    };
    expect(err({}, '{"distro":"my distro"}').message).toMatch(/^Invalid setting distro: "my distro"/);
    expect(err({}, '{"entryPath":"relative/path"}').message).toContain('absolute WSL path');
    expect(err({}, '{"requestTimeoutMs":50}').message).toContain('between 1000 and 600000');
    expect(err({ AGENT_STUDIO_REQUEST_TIMEOUT_MS: 'abc' }, '{}').message).toMatch(
      /^Invalid setting requestTimeoutMs: "abc"/,
    );
    expect(err({}, '{bad').message).toMatch(/^Could not read settings file/);
    expect(err({}, '[]').message).toMatch(/not a JSON object$/);
  });

  it('rejects config read errors other than a missing file', () => {
    const readFailure = () => { throw new Error('permission denied'); };
    expect(() => loadConfig({}, '/c.json', readFailure)).toThrow(
      'Could not read settings file /c.json: permission denied',
    );
  });

  it('rejects every non-object JSON value', () => {
    for (const text of ['null', '1', '"settings"']) {
      expect(() => loadConfig({}, '/c.json', file(text))).toThrow(
        'Could not read settings file /c.json: not a JSON object',
      );
    }
  });

  it('falls back from null and empty file values to defaults', () => {
    expect(loadConfig({}, '/c.json', file('{"distro":null,"entryPath":"","requestTimeoutMs":null}')))
      .toEqual(DEFAULT_CONFIG);
  });

  it('accepts request timeout limits inclusively', () => {
    expect(loadConfig({}, '/c.json', file('{"requestTimeoutMs":1000}')).requestTimeoutMs).toBe(1000);
    expect(loadConfig({}, '/c.json', file('{"requestTimeoutMs":600000}')).requestTimeoutMs).toBe(600000);
  });

  it('rejects values of the wrong type and a timeout above the upper bound', () => {
    for (const text of [
      '{"distro":24}',
      '{"entryPath":false}',
      '{"requestTimeoutMs":600001}',
    ]) {
      expect(() => loadConfig({}, '/c.json', file(text))).toThrow(ConfigError);
    }
  });

  it('validates safe characters for distro and absolute entryPath values', () => {
    for (const [key, value] of [['distro', 'Ubuntu 24.04'], ['entryPath', '/opt/my app/agent-studio']]) {
      expect(() => loadConfig({}, '/c.json', file(JSON.stringify({ [key]: value })))).toThrow(
        new RegExp(`^Invalid setting ${key}:`),
      );
    }
    expect(loadConfig({}, '/c.json', file('{"entryPath":"/opt/agent-studio"}')).entryPath)
      .toBe('/opt/agent-studio');
  });
});
