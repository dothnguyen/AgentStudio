// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiError, DashboardActivity } from '../src/renderer/api';
import type { DashboardSectionController } from '../src/renderer/dashboard/useDashboardSection';
import { ActivityPanel, activityScopeText } from '../src/renderer/dashboard/ActivityPanel';

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
      const rows = within(result.getByRole('table', { name: 'Recent activity' })).getAllByRole('row');
      expect(rows).toHaveLength(16);
      const body = rows.slice(1);
      expect(body.map((row) => within(row).getAllByRole('cell')[0].textContent))
        .toEqual(entries.slice(0, 15).map((item) => item.summary));
      expect(result.queryByText('Summary 16')).toBeNull();
      expect(body.slice(0, 4).map((row) => within(row).getAllByRole('cell')[1].textContent))
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
    expect(result.container.querySelector('table')).toBeNull();
    result.rerender(<ActivityPanel section={section('ready', activity([]), null, vi.fn())} />);
    expect(result.getByText('No recent activity').textContent).toBe('No recent activity');
    expect(result.queryByRole('status')).toBeNull();
    expect(result.container.querySelector('table')).toBeNull();
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

  it('renders aligned Event, Type and Time column headers', () => {
    const result = render(<ActivityPanel section={section('ready', activity([entry(1)]), null, vi.fn())} />);
    const headers = result.getAllByRole('columnheader');
    expect(headers.map((node) => node.textContent)).toEqual(['Event', 'Type', 'Time']);
    for (const header of headers) expect(header.getAttribute('scope')).toBe('col');
    const row = result.getAllByRole('row')[1];
    const cells = within(row).getAllByRole('cell');
    expect(cells).toHaveLength(3);
    expect(cells[0].textContent).toBe('Summary 1');
    expect(cells[1].querySelector('.status-badge')!.textContent).toBe('team');
    expect(cells[2].querySelector('time[datetime="2026-01-01T01:02:03.000Z"]')).toBeTruthy();
  });

  it('renders every activity kind as a visible badge', () => {
    const entries = [1, 2, 3, 4].map(entry);
    const result = render(<ActivityPanel section={section('ready', activity(entries), null, vi.fn())} />);
    expect(Array.from(result.container.querySelectorAll('.status-badge')).map((node) => node.textContent))
      .toEqual(['team', 'assignment', 'workflow', 'ticket']);
  });

  it('states the returned scope honestly', () => {
    expect(activityScopeText(1, 1)).toBe('1 recent event, newest first');
    expect(activityScopeText(4, 4)).toBe('4 recent events, newest first');
    expect(activityScopeText(15, 16)).toBe('Showing 15 of 16 returned events, newest first');
    expect(activityScopeText(15, 20)).toBe('Showing 15 of 20 returned events, newest first');
    const make = (count: number) => Array.from({ length: count }, (_, index) => entry(index + 1));
    const result = render(<ActivityPanel section={section('ready', activity(make(16)), null, vi.fn())} />);
    expect(result.container.querySelector('.activity-scope')!.textContent)
      .toBe('Showing 15 of 16 returned events, newest first');
    result.rerender(<ActivityPanel section={section('ready', activity(make(4)), null, vi.fn())} />);
    expect(result.container.querySelector('.activity-scope')!.textContent).toBe('4 recent events, newest first');
    result.rerender(<ActivityPanel section={section('ready', activity([]), null, vi.fn())} />);
    expect(result.container.querySelector('.activity-scope')).toBeNull();
    expect(result.container.querySelector('table')).toBeNull();
  });

  it('renders localized and long timestamps and summaries in full', () => {
    const localized = 'Dienstag, 3. Februar 2026 um 04:05:06 Mitteleuropäische Normalzeit';
    const spy = vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue(localized);
    try {
      const entries = [entry(1), entry(2)];
      entries[0] = { ...entries[0], summary: 'x'.repeat(300) };
      entries[1] = { ...entries[1], at: 'y'.repeat(120) };
      const result = render(<ActivityPanel section={section('ready', activity(entries), null, vi.fn())} />);
      const times = result.container.querySelectorAll('time');
      expect(times[0].textContent).toBe(localized);
      expect(times[1].textContent).toBe('y'.repeat(120));
      expect(times[1].getAttribute('datetime')).toBe('y'.repeat(120));
      const row = result.getAllByRole('row')[1];
      expect(within(row).getAllByRole('cell')[0].textContent).toBe('x'.repeat(300));
      expect(result.container.querySelector('[title]')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('exposes Retry as a focusable native button', () => {
    const onRetry = vi.fn();
    const result = render(
      <ActivityPanel section={section('error', null, { code: 'UNAVAILABLE', message: 'Activity could not be loaded.', retryable: true, remediation: '' }, onRetry)} />,
    );
    const button = within(result.getByRole('alert')).getByRole('button', { name: 'Retry' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('tabindex')).toBeNull();
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
