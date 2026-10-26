// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardBoard } from '../src/renderer/api';
import { BoardPanel } from '../src/renderer/dashboard/BoardPanel';
import type { DashboardSection } from '../src/renderer/dashboard/useDashboardSection';

afterEach(cleanup);

const emptyBoard: DashboardBoard = {
  workspace: '/workspace',
  currentPhase: { slug: 'default', name: 'Default', status: 'open' },
  columns: [
    { status: 'idea', kind: 'initial', title: 'Ideas', count: 0 },
    { status: 'shipped', kind: 'done', title: 'Shipped', count: 0 },
  ],
  totals: { active: 0, blocked: 0, done: 0 },
  tickets: [],
};

function section(overrides: Partial<DashboardSection<DashboardBoard>> = {}): DashboardSection<DashboardBoard> {
  const merged = {
    state: 'loading' as const, data: null, error: null, lastUpdatedAt: null,
    reload: vi.fn(() => Promise.resolve()), ...overrides,
  };
  return { loading: merged.state === 'loading', ...merged };
}

describe('BoardPanel', () => {
  it('renders_loading_state', () => {
    const result = render(<BoardPanel section={section()} onNavigate={vi.fn()} />);

    expect(result.getByRole('region', { name: 'Board status' })).toBeTruthy();
    expect(result.getByRole('status').textContent).toBe('Loading board…');
    expect(result.queryByRole('button', { name: 'View board' })).toBeNull();
  });

  it('renders_empty_configured_board', () => {
    const result = render(<BoardPanel section={section({ state: 'ready', data: emptyBoard })} onNavigate={vi.fn()} />);

    expect(result.getByText('Default')).toBeTruthy();
    expect(result.getByText('open')).toBeTruthy();
    expect(result.getByText('No tickets in the current phase.')).toBeTruthy();
    expect(result.queryByRole('list', { name: 'Board status counts' })).toBeNull();
    expect(result.queryByRole('list', { name: 'High-priority tickets' })).toBeNull();
    expect(result.getByRole('button', { name: 'View board' })).toBeTruthy();
  });

  it('determines_empty_from_column_counts_and_tickets_only', () => {
    const data: DashboardBoard = {
      ...emptyBoard,
      currentPhase: { slug: 'default', name: 'Default', status: 'open' },
      columns: [{ status: 'idea', kind: null, title: 'Ideas', count: 0 }],
      totals: { active: 2, blocked: 1, done: 4 },
    };
    const result = render(<BoardPanel section={section({ state: 'ready', data })} onNavigate={vi.fn()} />);

    expect(result.getByText('No tickets in the current phase.')).toBeTruthy();
    expect(result.queryByRole('list', { name: 'Board status counts' })).toBeNull();
    expect(result.queryByRole('list', { name: 'High-priority tickets' })).toBeNull();
  });

  it('renders_candidate_tickets_even_when_all_column_counts_are_zero', () => {
    const data: DashboardBoard = {
      ...emptyBoard,
      tickets: [{
        key: 'T-000', title: 'Queued candidate', status: 'idea', priority: 0, phase: 'default',
        activity: { state: 'working' },
      }],
    };
    const result = render(<BoardPanel section={section({ state: 'ready', data })} onNavigate={vi.fn()} />);

    expect(result.queryByText('No tickets in the current phase.')).toBeNull();
    expect(within(result.getByRole('list', { name: 'High-priority tickets' })).getByText('T-000')).toBeTruthy();
    expect(result.getByText('Priority 0')).toBeTruthy();
  });

  it('renders_custom_columns_totals_and_ticket_projection_in_backend_order', () => {
    const data: DashboardBoard = {
      workspace: '/workspace',
      currentPhase: { slug: 'phase-x', name: 'Custom phase', status: 'closed' },
      columns: [
        { status: 'idea', kind: 'initial', title: 'Ideas', count: 0 },
        { status: 'busy', kind: null, title: 'In flight', count: 2 },
        { status: 'shipped', kind: 'done', title: 'Shipped', count: 1 },
      ],
      totals: { active: 0, blocked: 1, done: 3 },
      tickets: [
        {
          key: 'T-009', title: 'First projection', status: 'busy', priority: 0, phase: 'phase-x',
          activity: { state: 'working', agent: 'agent-a', role: 'developer' },
        },
        {
          key: 'T-002', title: 'Second projection', status: 'idea', priority: 7, phase: 'phase-x',
          activity: { state: 'blocked' },
        },
      ],
    };
    const result = render(<BoardPanel section={section({ state: 'ready', data })} onNavigate={vi.fn()} />);

    expect(result.getByText('Custom phase')).toBeTruthy();
    expect(result.getByText('closed')).toBeTruthy();
    const statuses = within(result.getByRole('list', { name: 'Board status counts' })).getAllByRole('listitem');
    expect(statuses.map((item) => item.textContent)).toEqual(['Ideas0initial', 'In flight2', 'Shipped1done']);
    const totals = result.getByLabelText('Board totals');
    expect(totals.textContent).toBe('Active0Blocked1Done3');
    const tickets = within(result.getByRole('list', { name: 'High-priority tickets' })).getAllByRole('listitem');
    expect(tickets.map((item) => item.textContent)).toEqual([
      'T-009First projectionbusyPriority 0workingAgent: agent-aRole: developer',
      'T-002Second projectionideaPriority 7blocked',
    ]);
    expect(within(tickets[0]).getByText('T-009').classList.contains('ticket-key')).toBe(true);
    expect(tickets[1].textContent).not.toContain('Agent:');
    expect(tickets[1].textContent).not.toContain('Role:');
  });

  it('renders_no_candidate_message_when_counts_exist_without_tickets', () => {
    const data: DashboardBoard = {
      ...emptyBoard,
      columns: [{ status: 'idea', kind: 'initial', title: 'Ideas', count: 1 }],
    };
    const result = render(<BoardPanel section={section({ state: 'ready', data })} onNavigate={vi.fn()} />);

    expect(result.getByText('No active or blocked tickets.')).toBeTruthy();
    expect(result.queryByText('No tickets in the current phase.')).toBeNull();
  });

  it('maps_board_config_invalid_without_retry', () => {
    const result = render(<BoardPanel section={section({
      state: 'error',
      error: { code: 'BOARD_CONFIG_INVALID', message: 'Backend details', retryable: true },
    })} onNavigate={vi.fn()} />);

    expect(result.getByRole('status').textContent).toBe('No board configured for this workspace');
    expect(result.queryByText('Backend details')).toBeNull();
    expect(result.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('renders_other_error_and_retries_only_its_section', () => {
    const reload = vi.fn();
    const result = render(<BoardPanel section={section({
      state: 'error', reload,
      error: { code: 'UNAVAILABLE', message: 'Board request failed exactly', retryable: false, remediation: 'Try the service later.' },
    })} onNavigate={vi.fn()} />);

    expect(result.getByRole('alert').textContent).toBe('Board request failed exactly');
    expect(result.getByText('Try the service later.')).toBeTruthy();
    fireEvent.click(result.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('omits_absent_error_remediation', () => {
    const result = render(<BoardPanel section={section({
      state: 'error',
      error: { code: 'UNAVAILABLE', message: 'Board request failed', retryable: false },
    })} onNavigate={vi.fn()} />);

    expect(result.getByRole('alert').textContent).toBe('Board request failed');
    expect(result.queryByText(/remediation/i)).toBeNull();
    expect(result.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('omits_empty_error_remediation', () => {
    const result = render(<BoardPanel section={section({
      state: 'error',
      error: { code: 'UNAVAILABLE', message: 'Board request failed', retryable: false, remediation: '' },
    })} onNavigate={vi.fn()} />);

    expect(result.getByRole('alert').textContent).toBe('Board request failed');
    expect(result.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(Array.from(result.container.querySelectorAll('p')).map((paragraph) => paragraph.textContent)).toEqual(['Board request failed']);
  });

  it('preserves_unrecognized_kind_and_activity_text', () => {
    const futureData = {
      ...emptyBoard,
      columns: [{ status: 'future-status', kind: 'future-kind', title: 'Future title', count: 1 }],
      tickets: [{
        key: 'T-100', title: 'Future ticket', status: 'future-status', priority: 0, phase: 'default',
        activity: { state: 'waiting' },
      }],
    } as unknown as DashboardBoard;
    const result = render(<BoardPanel section={section({ state: 'ready', data: futureData })} onNavigate={vi.fn()} />);

    const columns = within(result.getByRole('list', { name: 'Board status counts' }));
    expect(columns.getByText('Future title')).toBeTruthy();
    expect(columns.getByText('future-kind')).toBeTruthy();
    expect(within(result.getByRole('list', { name: 'High-priority tickets' })).getByText('waiting')).toBeTruthy();
  });

  it('view_board_navigates_to_boards', () => {
    const onNavigate = vi.fn();
    const result = render(<BoardPanel section={section({ state: 'ready', data: emptyBoard })} onNavigate={onNavigate} />);

    fireEvent.click(result.getByRole('button', { name: 'View board' }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('boards');
  });

  it('contains_no_software_board_status_literals', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/renderer/dashboard/BoardPanel.tsx'), 'utf8');

    for (const literal of ['backlog', 'unpack-ready', 'refine-ready', 'dev-ready', 'qa-ready', 'review-ready', 'merge-ready']) {
      expect(source.toLowerCase()).not.toContain(literal);
    }
  });
});
