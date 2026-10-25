// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { getConnectionApi, type ConnectionStatus } from '../src/renderer/api';

describe('getConnectionApi', () => {
  it('getConnectionApi throws when the preload API is missing', () => {
    delete window.agentStudio;
    expect(() => getConnectionApi()).toThrow('Agent Studio preload API is missing (window.agentStudio).');
  });

  it('getConnectionApi normalises payloads and returns the real unsubscribe', () => {
    const off = vi.fn();
    window.agentStudio = {
      connection: {
        onChange: (cb) => {
          cb({ state: 'lost', error: 'x' });
          return off;
        },
      },
    };
    const got: ConnectionStatus[] = [];
    const unsub = getConnectionApi().onChange((s) => got.push(s));
    expect(got).toEqual([{ state: 'lost', error: 'x', distro: null, command: null }]);
    expect(unsub).toBe(off);
  });
});
