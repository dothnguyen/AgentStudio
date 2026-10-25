export type ConnectionState = 'connecting' | 'connected' | 'lost';
export interface ConnectionStatus {
  state: ConnectionState;
  error: string | null;
  distro: string | null;
  command: string | null;
}
export interface ConnectionApi {
  onChange(cb: (s: ConnectionStatus) => void): () => void;
}

export const INITIAL_STATUS: ConnectionStatus = { state: 'connecting', error: null, distro: null, command: null };

declare global {
  interface Window {
    agentStudio?: {
      connection: {
        onChange(cb: (s: Partial<ConnectionStatus> & { state: ConnectionState }) => void): () => void;
      };
    };
  }
}

export function getConnectionApi(): ConnectionApi {
  const real = window.agentStudio?.connection;
  if (!real) throw new Error('Agent Studio preload API is missing (window.agentStudio).');
  return {
    onChange: (cb) =>
      real.onChange((s) =>
        cb({ state: s.state, error: s.error ?? null, distro: s.distro ?? null, command: s.command ?? null }),
      ),
  };
}
