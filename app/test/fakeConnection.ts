import type { ConnectionApi, ConnectionStatus } from '../src/renderer/api';

export function fakeConnection(initial?: ConnectionStatus) {
  const listeners = new Set<(s: ConnectionStatus) => void>();
  let unsubscribeCalls = 0;
  const api: ConnectionApi = {
    onChange(cb) {
      listeners.add(cb);
      if (initial) cb(initial);
      return () => {
        listeners.delete(cb);
        unsubscribeCalls++;
      };
    },
  };
  return {
    api,
    emit(s: ConnectionStatus): void {
      for (const l of [...listeners]) l(s);
    },
    listenerCount: () => listeners.size,
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
  };
}
