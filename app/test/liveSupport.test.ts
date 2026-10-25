import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  allDistinct,
  lastJsonLine,
  parseArgs,
  toWslRepoPath,
  waitForState,
  withWslEnvVar,
  type StateSource,
} from '../src/live/liveSupport';

const fake = (state: 'connecting' | 'connected' | 'lost', lastError: string | null = null) =>
  Object.assign(new EventEmitter(), { state, lastError }) as unknown as StateSource & EventEmitter;

describe('liveSupport', () => {
  it('parseArgs defaults', () => {
    expect(parseArgs([])).toEqual({ distro: null, entry: null, repoWsl: null, out: null, keep: false });
  });
  it('parseArgs all flags', () => {
    expect(
      parseArgs(['--distro', 'Ubuntu-24.04', '--entry', '/h/e', '--repo-wsl', '/mnt/c/r', '--out', 'C:\\o.json', '--keep']),
    ).toEqual({ distro: 'Ubuntu-24.04', entry: '/h/e', repoWsl: '/mnt/c/r', out: 'C:\\o.json', keep: true });
  });
  it('parseArgs unknown flag', () => {
    expect(() => parseArgs(['--nope'])).toThrow('Unknown argument: --nope');
  });
  it('parseArgs missing value', () => {
    expect(() => parseArgs(['--distro'])).toThrow('Missing value for --distro');
  });
  it.each(['--entry', '--repo-wsl', '--out'])('parseArgs rejects missing value for %s', (flag) => {
    expect(() => parseArgs([flag])).toThrow(`Missing value for ${flag}`);
  });
  it('toWslRepoPath drive path', () => {
    expect(toWslRepoPath('C:\\Works\\Projects\\AgentStudio')).toBe('/mnt/c/Works/Projects/AgentStudio');
    expect(toWslRepoPath('D:\\x\\')).toBe('/mnt/d/x');
    expect(toWslRepoPath('C:\\')).toBe('/mnt/c');
  });
  it('toWslRepoPath rejects UNC', () => {
    expect(() => toWslRepoPath('\\\\wsl$\\Ubuntu\\home')).toThrow(/^The repository must be on a local drive/);
  });
  it('withWslEnvVar', () => {
    expect(withWslEnvVar(undefined, 'XDG_STATE_HOME')).toBe('XDG_STATE_HOME/u');
    expect(withWslEnvVar('WT_SESSION:USERPROFILE/p', 'XDG_STATE_HOME')).toBe('WT_SESSION:USERPROFILE/p:XDG_STATE_HOME/u');
    expect(withWslEnvVar('XDG_STATE_HOME/p:FOO', 'XDG_STATE_HOME')).toBe('FOO:XDG_STATE_HOME/u');
  });
  it('waitForState resolves immediately', async () => {
    await expect(waitForState(fake('lost', 'x'), 'lost', 50)).resolves.toEqual({ state: 'lost', error: 'x' });
  });
  it('waitForState resolves on event', async () => {
    const c = fake('connected');
    const p = waitForState(c, 'lost', 1000);
    c.emit('state', { state: 'connecting', error: null });
    c.emit('state', { state: 'lost', error: 'gone' });
    await expect(p).resolves.toEqual({ state: 'lost', error: 'gone' });
    expect(c.listenerCount('state')).toBe(0);
  });
  it('waitForState times out', async () => {
    const c = fake('connected');
    await expect(waitForState(c, 'lost', 20)).rejects.toThrow(/^Timed out after 20 ms waiting for state lost/);
    expect(c.listenerCount('state')).toBe(0);
  });
  it('lastJsonLine', () => {
    expect(lastJsonLine('noise\n{"a":1}\n\n')).toEqual({ a: 1 });
    expect(lastJsonLine('n\0o\0i\0s\0e\n{"b":2}')).toEqual({ b: 2 });
    expect(() => lastJsonLine('')).toThrow('No JSON output');
  });
  it('allDistinct', () => {
    expect(allDistinct(['a', 'b'])).toBe(true);
    expect(allDistinct(['a', 'a'])).toBe(false);
  });
});
