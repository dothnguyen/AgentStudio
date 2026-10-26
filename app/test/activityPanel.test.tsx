// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiError, DashboardActivity } from '../src/renderer/api';
import type { DashboardSectionController } from '../src/renderer/dashboard/useDashboardSection';
import { ActivityPanel } from '../src/renderer/dashboard/ActivityPanel';

afterEach(cleanup);

function section(
  state: 'loading' | 'ready' | 'error',
  data: DashboardActivity | null,
  error: ApiError | null,
  onRetry: () => void,
): DashboardSectionController<DashboardActivity> {
  return {
    state, data, error, loading: state === 'loading', lastUpdatedAt: null,
    reload: () => { onRetry(); return Promise.resolve(); },
  };
}

function activity(entries: DashboardActivity['entries']): DashboardActivity {
  return { workspace: '/workspace', dbId: 'activity-db', head: 42, entries };
}

function entry(index: number): DashboardActivity['entries'][number] {
  const kinds: DashboardActivity['entries'][number]['kind'][] = ['team', 'assignment', 'workflow', 'ticket'];
  return {
    id: `event:${index}`,
    at: `2026-01-${String(index).padStart(2, '0')}T01:02:03.000Z`,
    kind: kinds[(index - 1) % kinds.length],
    name: `internal name ${index}`,
    summary: `Summary ${index}`,
    subject: { type: 'ticket', id: `T-${index}`, label: `Ticket ${index}` },
  };
}

describe('ActivityPanel', () => {
  it('renders entries in API order, capped at 15, with stable event-id keys', () => {
    const entries = Array.from({ length: 16 }, (_, index) => entry(index + 1));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = render(<ActivityPanel section={section('ready', activity(entries), null, vi.fn())} />);
      const items = result.getAllByRole('listitem');
      expect(items).toHaveLength(15);
      expect(items.map((item) => item.querySelectorAll('span')[0].textContent))
        .toEqual(entries.slice(0, 15).map((item) => item.summary));
      expect(result.queryByText('Summary 16')).toBeNull();
      expect(items.slice(0, 4).map((item) => item.querySelectorAll('span')[1].textContent))
        .toEqual(['team', 'assignment', 'workflow', 'ticket']);
      expect(Array.from(result.container.querySelectorAll('time')).map((node) => node.getAttribute('datetime')))
        .toEqual(entries.slice(0, 15).map((item) => item.at));

      result.rerender(
        <ActivityPanel section={section('ready', activity(entries.map((item) => ({ ...item, summary: `Changed ${item.id}` }))), null, vi.fn())} />,
      );
      const keyWarnings = consoleError.mock.calls.filter((call) => String(call[0]).toLowerCase().includes('key'));
      expect(keyWarnings).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('formats valid timestamps locally and preserves an invalid timestamp', () => {
    const valid = '2026-02-03T04:05:06.000Z';
    const entries = [entry(1), entry(2)];
    entries[0] = { ...entries[0], at: valid };
    entries[1] = { ...entries[1], at: 'not-a-date' };
    const result = render(<ActivityPanel section={section('ready', activity(entries), null, vi.fn())} />);
    const times = result.container.querySelectorAll('time');
    expect(times[0].textContent).toBe(new Date(valid).toLocaleString());
    expect(times[0].getAttribute('datetime')).toBe(valid);
    expect(times[1].textContent).toBe('not-a-date');
    expect(times[1].getAttribute('datetime')).toBe('not-a-date');
  });

  it('renders only the safe activity projection', () => {
    const unsafe = '<img src=x onerror=alert(1)>';
    const data = activity([{
      ...entry(1),
      summary: unsafe,
      name: 'hidden-name',
      subject: { type: 'ticket', id: 'hidden-subject-id', label: 'hidden-subject-label' },
    }]);
    data.workspace = 'hidden-workspace';
    data.dbId = 'hidden-db';
    data.head = 987654;
    const result = render(<ActivityPanel section={section('ready', data, null, vi.fn())} />);
    expect(result.getByText(unsafe).textContent).toBe(unsafe);
    expect(result.container.querySelector('img')).toBeNull();
    for (const hidden of ['hidden-name', 'hidden-subject-id', 'hidden-subject-label', 'hidden-workspace', 'hidden-db', '987654']) {
      expect(result.container.textContent).not.toContain(hidden);
    }
  });

  it('renders loading and empty states', () => {
    const result = render(<ActivityPanel section={section('ready', activity([entry(1)]), null, vi.fn())} />);
    expect(result.getByText('Summary 1')).toBeTruthy();
    result.rerender(<ActivityPanel section={section('loading', null, null, vi.fn())} />);
    expect(result.getByRole('status').textContent).toBe('Loading recent activity…');
    expect(result.queryByText('Summary 1')).toBeNull();
    result.rerender(<ActivityPanel section={section('ready', activity([]), null, vi.fn())} />);
    expect(result.getByText('No recent activity').textContent).toBe('No recent activity');
    expect(result.queryByRole('status')).toBeNull();
  });

  it('renders an API error and retries exactly once', () => {
    const onRetry = vi.fn();
    const result = render(
      <ActivityPanel section={section('error', null, { code: 'UNAVAILABLE', message: 'Activity could not be loaded.', retryable: true, remediation: 'Try again.' }, onRetry)} />,
    );
    const alert = result.getByRole('alert');
    expect(alert.textContent).toContain('UNAVAILABLE: Activity could not be loaded.');
    expect(alert.textContent).toContain('Try again.');
    fireEvent.click(result.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps Retry available for non-retryable errors and omits empty remediation', () => {
    const onRetry = vi.fn();
    const result = render(
      <ActivityPanel section={section('error', null, { code: 'INVALID', message: 'Activity is unavailable.', retryable: false, remediation: '' }, onRetry)} />,
    );

    const alert = result.getByRole('alert');
    expect(alert.textContent).toContain('INVALID: Activity is unavailable.');
    expect(alert.querySelectorAll('p')).toHaveLength(1);
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
