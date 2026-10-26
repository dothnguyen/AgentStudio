// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardBoard } from '../src/renderer/api';
import { BoardPanel, boardProgress } from '../src/renderer/dashboard/BoardPanel';
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

  it('renders_zero_total_board_with_every_status_count', () => {
    const result = render(<BoardPanel section={section({ state: 'ready', data: emptyBoard })} onNavigate={vi.fn()} />);

    expect(result.getByText('Current phase')).toBeTruthy();
    expect(result.getByText('Default')).toBeTruthy();
    expect(result.getByText('open')).toBeTruthy();
    expect(result.getByText('No tickets counted in the current phase.')).toBeTruthy();
    expect(result.queryByRole('progressbar')).toBeNull();
    const items = within(result.getByRole('list', { name: 'Board status counts' })).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['Ideas0initial', 'Shipped0done']);
    expect(result.queryByLabelText('Board totals')).toBeNull();
    expect(result.queryByRole('list', { name: 'High-priority tickets' })).toBeNull();
    expect(result.queryByText('No active or blocked tickets.')).toBeNull();
    expect(result.getByRole('button', { name: 'View board' })).toBeTruthy();
  });

  it('zero_total_ignores_backend_totals', () => {
    const data: DashboardBoard = {
      ...emptyBoard,
      columns: [{ status: 'idea', kind: null, title: 'Ideas', count: 0 }],
      totals: { active: 2, blocked: 1, done: 4 },
    };
    const result = render(<BoardPanel section={section({ state: 'ready', data })} onNavigate={vi.fn()} />);

    expect(result.getByText('No tickets counted in the current phase.')).toBeTruthy();
    expect(result.queryByRole('progressbar')).toBeNull();
    expect(result.queryByLabelText('Board totals')).toBeNull();
    const items = within(result.getByRole('list', { name: 'Board status counts' })).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['Ideas0']);
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

    expect(result.getByText('No tickets counted in the current phase.')).toBeTruthy();
    expect(within(result.getByRole('list', { name: 'High-priority tickets' })).getByText('T-000')).toBeTruthy();
    expect(result.getByText('Priority 0')).toBeTruthy();
    expect(result.getByText(/Highest-priority working or blocked tickets/)).toBeTruthy();
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
    expect(totals.textContent).toBe('Active0Blocked1');
    expect(result.getByRole('progressbar', { name: '1 of 3 completed (33%)' })).toBeTruthy();
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
    expect(result.queryByText(/Highest-priority working or blocked tickets/)).toBeNull();
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
    expect(result.getByText('0 of 1 completed (0%)')).toBeTruthy();
    expect(result.getByText('1 open')).toBeTruthy();
    expect(within(result.getByRole('list', { name: 'High-priority tickets' })).getByText('waiting')).toBeTruthy();
  });

  it('view_board_navigates_to_boards', () => {
    const onNavigate = vi.fn();
    const result = render(<BoardPanel section={section({ state: 'ready', data: emptyBoard })} onNavigate={onNavigate} />);

    fireEvent.click(result.getByRole('button', { name: 'View board' }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('boards');
  });

  it('computes_progress_from_done_and_closed_kinds', () => {
    const data: DashboardBoard = {
      ...emptyBoard,
      columns: [
        { status: 'a', kind: 'initial', title: 'Ideas', count: 2 },
        { status: 'b', kind: null, title: 'In flight', count: 3 },
        { status: 'c', kind: 'done', title: 'Shipped', count: 4 },
        { status: 'd', kind: 'closed', title: 'Archived', count: 1 },
        { status: 'blocked', kind: null, title: 'Blocked', count: 2 },
      ],
      totals: { active: 0, blocked: 2, done: 99 },
    };
    const result = render(<BoardPanel section={section({ state: 'ready', data })} onNavigate={vi.fn()} />);

    const bar = result.getByRole('progressbar', { name: '5 of 12 completed (41%)' });
    expect(bar.getAttribute('value')).toBe('5');
    expect(bar.getAttribute('max')).toBe('12');
    expect(result.getByText('7 open')).toBeTruthy();
  });

  it('shows_full_completion_only_when_every_ticket_is_complete', () => {
    const full: DashboardBoard = { ...emptyBoard, columns: [{ status: 's', kind: 'done', title: 'Shipped', count: 3 }] };
    const first = render(<BoardPanel section={section({ state: 'ready', data: full })} onNavigate={vi.fn()} />);
    expect(first.getByText('3 of 3 completed (100%)')).toBeTruthy();
    expect(first.getByText('0 open')).toBeTruthy();
    cleanup();

    const almost: DashboardBoard = {
      ...emptyBoard,
      columns: [
        { status: 's', kind: 'done', title: 'Shipped', count: 199 },
        { status: 'i', kind: 'initial', title: 'Ideas', count: 1 },
      ],
    };
    const second = render(<BoardPanel section={section({ state: 'ready', data: almost })} onNavigate={vi.fn()} />);
    expect(second.getByText('199 of 200 completed (99%)')).toBeTruthy();
  });

  it('renders_no_statuses_message_without_grid', () => {
    const data: DashboardBoard = { ...emptyBoard, columns: [], tickets: [] };
    const result = render(<BoardPanel section={section({ state: 'ready', data })} onNavigate={vi.fn()} />);

    expect(result.getByText('No statuses configured for this board.')).toBeTruthy();
    expect(result.queryByRole('list', { name: 'Board status counts' })).toBeNull();
    expect(result.queryByRole('progressbar')).toBeNull();
    expect(result.getByRole('button', { name: 'View board' })).toBeTruthy();
  });

  it('renders_many_statuses_in_backend_order', () => {
    const columns = Array.from({ length: 12 }, (_, i) => ({ status: `s${i}`, kind: null, title: `Status ${i}`, count: i }));
    const data: DashboardBoard = { ...emptyBoard, columns };
    const result = render(<BoardPanel section={section({ state: 'ready', data })} onNavigate={vi.fn()} />);

    const items = within(result.getByRole('list', { name: 'Board status counts' })).getAllByRole('listitem');
    expect(items).toHaveLength(12);
    expect(items.map((item) => item.textContent)).toEqual(columns.map((c, i) => `Status ${i}${i}`));
    expect(result.getByRole('progressbar', { name: '0 of 66 completed (0%)' })).toBeTruthy();
  });

  it('renders_long_phase_and_ticket_text_in_full', () => {
    const phase = 'P'.repeat(300);
    const column = 'C'.repeat(300);
    const ticket = 'T'.repeat(300);
    const data: DashboardBoard = {
      ...emptyBoard,
      currentPhase: { slug: 'long', name: phase, status: 'open' },
      columns: [{ status: 'long', kind: null, title: column, count: 1 }],
      tickets: [{
        key: 'T-001', title: ticket, status: 'long', priority: 1, phase: 'long', activity: { state: 'working' },
      }],
    };
    const result = render(<BoardPanel section={section({ state: 'ready', data })} onNavigate={vi.fn()} />);

    expect(result.getByText(phase).classList.contains('board-phase-name')).toBe(true);
    expect(result.getByText(column).classList.contains('board-status-name')).toBe(true);
    expect(result.getByText(ticket).classList.contains('board-ticket-title')).toBe(true);
  });

  it('hides_view_board_in_error_states', () => {
    const generic = render(<BoardPanel section={section({
      state: 'error', error: { code: 'UNAVAILABLE', message: 'Failed', retryable: false },
    })} onNavigate={vi.fn()} />);
    expect(generic.queryByRole('button', { name: 'View board' })).toBeNull();
    cleanup();
    const invalid = render(<BoardPanel section={section({
      state: 'error', error: { code: 'BOARD_CONFIG_INVALID', message: 'Bad', retryable: true },
    })} onNavigate={vi.fn()} />);
    expect(invalid.queryByRole('button', { name: 'View board' })).toBeNull();
  });

  it('view_board_is_a_native_button', () => {
    const result = render(<BoardPanel section={section({ state: 'ready', data: emptyBoard })} onNavigate={vi.fn()} />);
    const button = result.getByRole('button', { name: 'View board' });

    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
  });

  it('phase_status_is_text_not_color', () => {
    const data: DashboardBoard = { ...emptyBoard, currentPhase: { slug: 'x', name: 'Custom phase', status: 'closed' } };
    const result = render(<BoardPanel section={section({ state: 'ready', data })} onNavigate={vi.fn()} />);
    const badge = result.getByText('closed');

    expect(badge.classList.contains('status-badge')).toBe(true);
    expect(badge.classList.contains('phase-status')).toBe(true);
    expect(result.getByText('Current phase')).toBeTruthy();
  });

  it('boardProgress_sums_columns_and_floors_percent', () => {
    expect(boardProgress([])).toEqual({ total: 0, completed: 0, open: 0, percent: null });
    expect(boardProgress([
      { status: 'a', kind: 'done', title: 'A', count: 1 },
      { status: 'b', kind: 'initial', title: 'B', count: 2 },
    ])).toEqual({ total: 3, completed: 1, open: 2, percent: 33 });
  });

  it('contains_no_software_board_status_literals', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/renderer/dashboard/BoardPanel.tsx'), 'utf8');

    for (const literal of ['backlog', 'unpack-ready', 'refine-ready', 'dev-ready', 'qa-ready', 'review-ready', 'merge-ready']) {
      expect(source.toLowerCase()).not.toContain(literal);
    }
  });
});

describe('BoardPanel icons', () => {
  it('renders_status_icons_and_heading_icon', () => {
    const data: DashboardBoard = {
      ...emptyBoard,
      columns: [...emptyBoard.columns, { status: ['dev', 'ready'].join('-'), kind: null, title: 'Dev', count: 0 }],
    };
    const result = render(<BoardPanel section={section({ state: 'ready', data })} onNavigate={vi.fn()} />);
    const h2 = result.getByRole('heading', { level: 2 });
    expect(h2.textContent).toBe('Board status');
    expect(h2.querySelector('svg[data-icon="boards"]')).not.toBeNull();
    const items = result.getByRole('list', { name: 'Board status counts' }).querySelectorAll('li');
    expect(Array.from(items).map((li) => li.querySelector('svg')!.getAttribute('data-icon')))
      .toEqual(['document', 'check-circle', 'code']);
    expect(items[1].querySelector('svg')!.classList.contains('icon-success')).toBe(true);
    expect(items[0].textContent).toBe('Ideas0initial');
    const button = result.getByRole('button', { name: 'View board' });
    expect(button.querySelector('svg[data-icon="arrow-right"]')).not.toBeNull();
  });

  it('state_views_add_no_icons_beyond_the_heading', () => {
    const states = [
      section(),
      section({ state: 'error', error: { code: 'X', message: 'boom', retryable: true } }),
      section({ state: 'error', error: { code: 'BOARD_CONFIG_INVALID', message: 'bad', retryable: false } }),
    ];
    for (const s of states) {
      const result = render(<BoardPanel section={s} onNavigate={vi.fn()} />);
      expect(result.getByRole('region').querySelectorAll('svg')).toHaveLength(1);
      cleanup();
    }
  });
});
