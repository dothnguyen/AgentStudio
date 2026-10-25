import { useEffect, useRef, type ReactNode } from 'react';
import type { ConnectionApi, ConnectionStatus } from './api';
import { useConnection } from './useConnection';

export const CONNECTING_TEXT = 'Connecting to Agent Studio…';
export const LOST_TITLE = 'Connection lost';
export const FAILED_TITLE = 'Could not connect to Agent Studio';
export const NO_REASON = 'No reason was reported.';
export const NOT_STARTED = 'Not started (the connection failed before serve was started)';
export const DISTRO_UNKNOWN = 'Not known (the connection failed before serve was started)';
export const DISTRO_DEFAULT = 'Default WSL distro';
export const CONNECTED_TEXT = 'Connected to Agent Studio.';

function ConnectionLostView(props: { status: ConnectionStatus; title: string; onRetry: () => void }) {
  const { status, title, onRetry } = props;
  const retryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    retryRef.current?.focus();
  }, []);
  return (
    <div className="connection-shell">
      <div className="connection-brand" aria-hidden="true">AS</div>
      <section className="connection-panel" aria-labelledby="connection-title">
        <div className="state-icon error-icon" aria-hidden="true">!</div>
        <div className="state-content">
          <h1 id="connection-title">{title}</h1>
          <p role="alert">{status.error ?? NO_REASON}</p>
          <button type="button" ref={retryRef} onClick={onRetry}>
            Retry
          </button>
        </div>
        <section className="diagnostics" aria-labelledby="diagnostics-title">
          <h2 id="diagnostics-title">Diagnostics</h2>
          <dl>
            <dt>Command</dt>
            <dd>
              <code>{status.command ?? NOT_STARTED}</code>
            </dd>
            <dt>Distro</dt>
            <dd>{status.distro ?? (status.command === null ? DISTRO_UNKNOWN : DISTRO_DEFAULT)}</dd>
            <dt>Last error</dt>
            <dd>
              <code>{status.error ?? 'None'}</code>
            </dd>
          </dl>
        </section>
      </section>
    </div>
  );
}

export function StartupScreen(props: { connection: ConnectionApi; onRetry: () => void; connectedView: ReactNode }) {
  const status = useConnection(props.connection);
  const seenConnected = useRef(false);
  if (status.state === 'connected') seenConnected.current = true;
  return (
    <main className="app-shell" aria-busy={status.state === 'connecting'}>
      {status.state === 'connecting' && (
        <div className="connecting-state" role="status" aria-live="polite">
          <div className="connection-brand" aria-hidden="true">AS</div>
          <span className="spinner" aria-hidden="true"></span>
          <p>{CONNECTING_TEXT}</p>
        </div>
      )}
      {status.state === 'lost' && (
        <ConnectionLostView
          status={status}
          title={seenConnected.current ? LOST_TITLE : FAILED_TITLE}
          onRetry={props.onRetry}
        />
      )}
      {status.state === 'connected' && props.connectedView}
    </main>
  );
}
