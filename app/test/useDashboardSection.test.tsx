// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '../src/renderer/api';
import { useDashboardSection, type DashboardSection } from '../src/renderer/dashboard/useDashboardSection';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function Harness<T>(props: {
  load(workspaceId: string): Promise<Result<T>>;
  workspaceId: string;
  notify(section: DashboardSection<T>): void;
}) {
  const section = useDashboardSection(props.load, props.workspaceId);
  props.notify(section);
  return <div data-state={section.state}>{section.data === null ? '' : JSON.stringify(section.data)}</div>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useDashboardSection', () => {
  it('loads_once_on_mount_and_records_response_arrival_time', async () => {
    const pending = deferred<Result<string>>();
    const load = vi.fn(() => pending.promise);
    let latest!: DashboardSection<string>;
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    render(
      <StrictMode>
        <Harness load={load} workspaceId="workspace-a" notify={(section) => { latest = section; }} />
      </StrictMode>,
    );

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('workspace-a');
    expect(latest).toMatchObject({ state: 'loading', data: null, error: null, lastUpdatedAt: null });
    await act(async () => pending.resolve({ ok: true, data: 'ready' }));
    expect(latest).toMatchObject({ state: 'ready', data: 'ready', error: null, lastUpdatedAt: 1234 });
  });

  it('reload_is_a_no_op_while_current_request_is_in_flight', () => {
    const pending = deferred<Result<string>>();
    const load = vi.fn(() => pending.promise);
    let latest!: DashboardSection<string>;
    render(<Harness load={load} workspaceId="a" notify={(section) => { latest = section; }} />);

    act(() => { latest.reload(); latest.reload(); });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reload_after_settlement_starts_one_new_request', async () => {
    const first = deferred<Result<string>>();
    const second = deferred<Result<string>>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let latest!: DashboardSection<string>;
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    render(<Harness load={load} workspaceId="a" notify={(section) => { latest = section; }} />);
    await act(async () => first.resolve({ ok: true, data: 'one' }));

    act(() => latest.reload());
    expect(latest).toMatchObject({ state: 'loading', data: null, error: null, lastUpdatedAt: 1234 });
    expect(load).toHaveBeenCalledTimes(2);
    act(() => latest.reload());
    expect(load).toHaveBeenCalledTimes(2);

    await act(async () => second.resolve({
      ok: false,
      error: { code: 'REFRESH_FAILED', message: 'try again', retryable: true },
    }));
    expect(latest).toMatchObject({ state: 'error', data: null, lastUpdatedAt: 1234 });
  });

  it('new_workspace_supersedes_old_response', async () => {
    const firstA = deferred<Result<string>>();
    const secondA = deferred<Result<string>>();
    const b = deferred<Result<string>>();
    const load = vi.fn()
      .mockReturnValueOnce(firstA.promise)
      .mockReturnValueOnce(secondA.promise)
      .mockReturnValueOnce(b.promise);
    let latest!: DashboardSection<string>;
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    const result = render(<Harness load={load} workspaceId="a" notify={(section) => { latest = section; }} />);
    await act(async () => firstA.resolve({ ok: true, data: 'first' }));
    expect(latest.lastUpdatedAt).toBe(1234);
    act(() => latest.reload());
    result.rerender(<Harness load={load} workspaceId="b" notify={(section) => { latest = section; }} />);
    expect(load).toHaveBeenNthCalledWith(3, 'b');
    expect(latest.lastUpdatedAt).toBeNull();

    await act(async () => b.resolve({ ok: true, data: 'new' }));
    expect(latest.data).toBe('new');
    await act(async () => secondA.resolve({ ok: true, data: 'old' }));
    expect(latest.data).toBe('new');
  });

  it('new_loader_supersedes_old_response', async () => {
    const oldResult = deferred<Result<string>>();
    const newResult = deferred<Result<string>>();
    const oldLoad = vi.fn(() => oldResult.promise);
    const newLoad = vi.fn(() => newResult.promise);
    let latest!: DashboardSection<string>;
    const result = render(<Harness load={oldLoad} workspaceId="a" notify={(section) => { latest = section; }} />);
    result.rerender(<Harness load={newLoad} workspaceId="a" notify={(section) => { latest = section; }} />);
    expect(newLoad).toHaveBeenCalledTimes(1);
    await act(async () => newResult.resolve({ ok: true, data: 'new' }));
    await act(async () => oldResult.resolve({ ok: false, error: { code: 'OLD', message: 'old', retryable: false } }));
    expect(latest).toMatchObject({ state: 'ready', data: 'new', error: null });
  });

  it('loader_change_preserves_last_updated_when_the_replacement_fails', async () => {
    const first = deferred<Result<string>>();
    const replacement = deferred<Result<string>>();
    const oldLoad = vi.fn(() => first.promise);
    const newLoad = vi.fn(() => replacement.promise);
    let latest!: DashboardSection<string>;
    vi.spyOn(Date, 'now').mockReturnValue(4321);
    const result = render(<Harness load={oldLoad} workspaceId="a" notify={(section) => { latest = section; }} />);
    await act(async () => first.resolve({ ok: true, data: 'initial' }));
    expect(latest.lastUpdatedAt).toBe(4321);

    result.rerender(<Harness load={newLoad} workspaceId="a" notify={(section) => { latest = section; }} />);
    expect(latest).toMatchObject({ state: 'loading', lastUpdatedAt: 4321 });
    await act(async () => replacement.resolve({
      ok: false,
      error: { code: 'REPLACEMENT_FAILED', message: 'failed', retryable: true },
    }));

    expect(latest).toMatchObject({ state: 'error', data: null, lastUpdatedAt: 4321 });
  });

  it('stale_failure_cannot_replace_a_newer_success', async () => {
    const oldResult = deferred<Result<string>>();
    const newResult = deferred<Result<string>>();
    const oldLoad = vi.fn(() => oldResult.promise);
    const newLoad = vi.fn(() => newResult.promise);
    let latest!: DashboardSection<string>;
    vi.spyOn(Date, 'now').mockReturnValue(9876);
    const result = render(<Harness load={oldLoad} workspaceId="a" notify={(section) => { latest = section; }} />);
    result.rerender(<Harness load={newLoad} workspaceId="a" notify={(section) => { latest = section; }} />);
    await act(async () => newResult.resolve({ ok: true, data: 'current' }));
    await act(async () => oldResult.resolve({
      ok: false,
      error: { code: 'STALE_FAILURE', message: 'stale', retryable: false },
    }));

    expect(latest).toMatchObject({ state: 'ready', data: 'current', error: null, lastUpdatedAt: 9876 });
  });

  it('rejected_promise_maps_to_internal_error_and_retry_can_recover', async () => {
    const first = deferred<Result<string>>();
    const second = deferred<Result<string>>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let latest!: DashboardSection<string>;
    render(<Harness load={load} workspaceId="a" notify={(section) => { latest = section; }} />);
    await act(async () => first.reject(new Error('network down')));
    expect(latest.error).toEqual({ code: 'INTERNAL', message: 'network down', retryable: false });

    act(() => latest.reload());
    await act(async () => second.resolve({ ok: true, data: 'recovered' }));
    expect(latest).toMatchObject({ state: 'ready', data: 'recovered', error: null });
  });

  it('non_error_rejection_uses_stringified_reason', async () => {
    const pending = deferred<Result<string>>();
    const load = vi.fn(() => pending.promise);
    let latest!: DashboardSection<string>;
    render(<Harness load={load} workspaceId="a" notify={(section) => { latest = section; }} />);

    await act(async () => pending.reject({ reason: 'unavailable' }));

    expect(latest.error).toEqual({
      code: 'INTERNAL',
      message: '[object Object]',
      retryable: false,
    });
  });

  it('settlement_after_unmount_emits_no_state_change', async () => {
    const pending = deferred<Result<string>>();
    const notifications: DashboardSection<string>[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = render(<Harness load={() => pending.promise} workspaceId="a" notify={(section) => notifications.push(section)} />);
    const count = notifications.length;
    result.unmount();

    await act(async () => pending.resolve({ ok: true, data: 'late' }));
    expect(notifications).toHaveLength(count);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('rejection_after_unmount_emits_no_state_change', async () => {
    const pending = deferred<Result<string>>();
    const notifications: DashboardSection<string>[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = render(<Harness load={() => pending.promise} workspaceId="a" notify={(section) => notifications.push(section)} />);
    const count = notifications.length;
    result.unmount();

    await act(async () => pending.reject(new Error('late failure')));
    expect(notifications).toHaveLength(count);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
