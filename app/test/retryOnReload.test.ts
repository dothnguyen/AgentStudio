import { describe, expect, it, vi } from 'vitest';
import { retryOnReload } from '../src/main/retryOnReload';
import type { ConnectionState } from '../src/main/serveClient';

function setup(state: ConnectionState) {
  let listener: () => void = () => {};
  const client = { state, retry: vi.fn(async () => {}) };
  retryOnReload({ on: (_e, l) => void (listener = l) }, client);
  return { client, load: () => listener() };
}

describe('retryOnReload', () => {
  it('first load never retries', () => {
    const s = setup('lost');
    s.load();
    expect(s.client.retry).toHaveBeenCalledTimes(0);
  });

  it('a reload while lost retries', () => {
    const s = setup('lost');
    s.load();
    s.load();
    expect(s.client.retry).toHaveBeenCalledTimes(1);
  });

  it('a reload while connected or connecting does not retry', () => {
    const s = setup('lost');
    s.load();
    s.client.state = 'connected';
    s.load();
    s.client.state = 'connecting';
    s.load();
    expect(s.client.retry).toHaveBeenCalledTimes(0);
  });

  it('every later reload while lost retries again', () => {
    const s = setup('lost');
    s.load();
    s.load();
    s.load();
    expect(s.client.retry).toHaveBeenCalledTimes(2);
  });
});
