// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_STATUS, type ConnectionStatus } from '../src/renderer/api';
import {
  CONNECTED_TEXT,
  CONNECTING_TEXT,
  DISTRO_DEFAULT,
  DISTRO_UNKNOWN,
  FAILED_TITLE,
  LOST_TITLE,
  NOT_STARTED,
  NO_REASON,
  StartupScreen,
} from '../src/renderer/StartupScreen';
import { fakeConnection } from './fakeConnection';

afterEach(cleanup);

const LOST: ConnectionStatus = {
  state: 'lost',
  error: 'wsl.exe was not found on this computer. Install WSL (wsl --install) and try again.',
  distro: 'Ubuntu-24.04',
  command: 'wsl.exe -d Ubuntu-24.04 --exec /home/me/.local/bin/agent-studio serve',
};

function setup(initial?: ConnectionStatus) {
  const f = fakeConnection(initial);
  const spy = vi.fn();
  const view = render(<StartupScreen connection={f.api} onRetry={spy} connectedView={() => <p>{CONNECTED_TEXT}</p>} />);
  const emit = (s: ConnectionStatus) => act(() => f.emit(s));
  return { f, spy, emit, ...view };
}

function expectConnecting(r: ReturnType<typeof setup>) {
  expect(r.getByRole('status').textContent).toContain(CONNECTING_TEXT);
  expect(r.container.querySelector('.spinner')?.getAttribute('aria-hidden')).toBe('true');
  expect(r.queryAllByRole('button')).toHaveLength(0);
  expect(r.container.querySelector('[data-role="app-shell"]')?.getAttribute('aria-busy')).toBe('true');
}

describe('StartupScreen', () => {
  it('connecting shows the text and a spinner and no buttons', () => {
    const result = setup();
    expectConnecting(result);
    expect(result.container.querySelector('[data-role="app-shell"]')?.classList.contains('app-shell')).toBe(true);
    expect(result.container.querySelector('.connecting-state')).toBeTruthy();
  });

  it('explicit connecting payload shows the connecting view', () => {
    expectConnecting(setup({ ...INITIAL_STATUS }));
  });

  it('failed shows title, reason, Retry and diagnostics', () => {
    const r = setup();
    r.emit(LOST);
    expect(r.getByRole('heading', { level: 1 }).textContent).toBe(FAILED_TITLE);
    expect(r.getByRole('alert').textContent).toBe(LOST.error);
    expect(r.getAllByRole('button').map((b) => b.textContent)).toEqual(['Retry']);
    const diag = r.getByRole('region', { name: 'Diagnostics' }).textContent!;
    expect(diag).toContain(LOST.command!);
    expect(diag).toContain('Ubuntu-24.04');
    expect(diag).toContain(LOST.error!);
    expect(r.queryByRole('status')).toBeNull();
    expect(r.queryByText(/create workspace/i)).toBeNull();
    expect(r.queryByRole('list')).toBeNull();
    expect(r.container.querySelector('[data-role="app-shell"]')?.getAttribute('aria-busy')).toBe('false');
    expect(r.container.querySelector('.connection-panel')).toBeTruthy();
  });

  it('lost after connected is titled Connection lost', () => {
    const r = setup();
    r.emit({ state: 'connected', error: null, distro: 'Ubuntu-24.04', command: LOST.command });
    r.emit({ ...LOST, error: 'serve exited (code 1, signal null)' });
    expect(r.getByRole('heading', { level: 1 }).textContent).toBe(LOST_TITLE);
    expect(r.getByRole('alert').textContent).toBe('serve exited (code 1, signal null)');
  });

  it('Retry calls onRetry once', () => {
    const r = setup();
    r.emit(LOST);
    fireEvent.click(r.getByRole('button', { name: 'Retry' }));
    expect(r.spy).toHaveBeenCalledTimes(1);
  });

  it('focus moves to Retry when the state becomes lost', () => {
    const r = setup();
    r.emit(LOST);
    expect(document.activeElement).toBe(r.getByRole('button', { name: 'Retry' }));
  });

  it('diagnostics fallbacks when serve was never started', () => {
    const r = setup();
    r.emit({ state: 'lost', error: 'Invalid setting distro', distro: null, command: null });
    const diag = r.getByRole('region', { name: 'Diagnostics' }).textContent!;
    expect(diag).toContain(NOT_STARTED);
    expect(diag).toContain(DISTRO_UNKNOWN);
  });

  it('null distro with a command shows the default distro', () => {
    const r = setup();
    r.emit({ ...LOST, distro: null });
    expect(r.getByRole('region', { name: 'Diagnostics' }).textContent).toContain(DISTRO_DEFAULT);
  });

  it('null error shows the no-reason text', () => {
    const r = setup();
    r.emit({ ...LOST, error: null });
    expect(r.getByRole('alert').textContent).toBe(NO_REASON);
    expect(r.getByRole('region', { name: 'Diagnostics' }).textContent).toContain('None');
  });

  it('transitions follow onChange', () => {
    const r = setup();
    r.emit({ ...INITIAL_STATUS });
    expect(r.getByRole('status')).toBeTruthy();
    r.emit(LOST);
    expect(r.getByRole('alert')).toBeTruthy();
    expect(r.getByRole('button', { name: 'Retry' })).toBeTruthy();
    r.emit({ ...INITIAL_STATUS });
    expect(r.getByRole('status')).toBeTruthy();
    expect(r.queryAllByRole('button')).toHaveLength(0);
    r.emit({ state: 'connected', error: null, distro: 'Ubuntu-24.04', command: LOST.command });
    expect(r.getByText(CONNECTED_TEXT)).toBeTruthy();
    expect(r.queryAllByRole('button')).toHaveLength(0);
  });

  it('connected view provides the only main landmark', () => {
    const f = fakeConnection({ state: 'connected', error: null, distro: null, command: 'x' });
    const result = render(
      <StartupScreen connection={f.api} onRetry={vi.fn()} connectedView={() => <main>Workspace</main>} />,
    );
    expect(result.getAllByRole('main')).toHaveLength(1);
  });

  it('passes the exact subscribed status to the connected view', () => {
    const status: ConnectionStatus = { state: 'connected', error: null, distro: 'Ubuntu', command: 'serve' };
    const f = fakeConnection(status);
    const connectedView = vi.fn((received: ConnectionStatus) => <main>{received.command}</main>);
    render(<StartupScreen connection={f.api} onRetry={vi.fn()} connectedView={connectedView} />);

    expect(connectedView).toHaveBeenCalledWith(status);
  });

  it('unsubscribes on unmount', () => {
    const r = setup();
    r.unmount();
    expect(r.f.listenerCount()).toBe(0);
    expect(r.f.unsubscribeCalls).toBe(1);
    expect(() => r.f.emit(LOST)).not.toThrow();
  });
});
