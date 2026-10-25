import type { ConnectionState } from './serveClient';

export interface LoadEvents {
  on(event: 'did-finish-load', listener: () => void): unknown;
}
export interface Retryable {
  readonly state: ConnectionState;
  retry(): Promise<void>;
}

// The Retry button reloads the window; a reload while the connection is lost asks the client to reconnect.
export function retryOnReload(wc: LoadEvents, client: Retryable): void {
  let loads = 0;
  wc.on('did-finish-load', () => {
    loads++;
    if (loads > 1 && client.state === 'lost') void client.retry();
  });
}
