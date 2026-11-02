// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardRuleView, BoardSettings, BoardTicketList } from '../src/renderer/api';
import { CurrentPhaseScreen } from '../src/renderer/boards/CurrentPhaseScreen';
import { boardPhasesFixture, boardTicketListFixture, boardTicketSummary } from './boardFixtures';
import { workspaceA } from './dashboardFixtures';
import { boardSettingsFixture, fakeManagement } from './teamsFixtures';

afterEach(cleanup);

const STATUS_IDS = [
  'backlog', 'unpack-ready', 'refine-ready', 'dev-ready', 'qa-ready', 'need-escalate',
  'review-ready', 'plan-merge-ready', 'plan-merge-conflict', 'merge-ready', 'merge-conflict', 'done', 'close',
];

const STATUSES: BoardSettings['statuses'] = STATUS_IDS.map((id) => ({
  id,
  name: id === 'need-escalate' ? 'Needs escalation' : id === 'qa-ready' ? 'QA ready' : id,
  kind: id === 'backlog' ? 'initial' : id === 'done' ? 'done' : id === 'close' ? 'closed' : null,
}));

function rule(status: string, role: string, index: number): BoardRuleView {
  return {
    index, status, type: 'agent', role, workflow: 'board-develop', during: null, action: null,
    onPass: 'done', onFail: 'dev-ready', onBlocked: null, workspace: 'worktree',
    syncBase: false, maxRounds: null, priority: null, onFailureLimit: null, protected: false,
  };
}

const RULES: BoardRuleView[] = [
  rule('refine-ready', 'TeamLead', 0),
  rule('dev-ready', 'Developer', 1),
  rule('qa-ready', 'QA', 2),
  rule('need-escalate', 'SeniorDeveloper', 3),
  rule('review-ready', 'Reviewer', 4),
];

function ticket(status: string, key: string, overrides: NonNullable<Parameters<typeof boardTicketSummary>[0]> = {}) {
  return boardTicketSummary({ key, status, phase: 'phase-05', title: `Ticket ${key}`, ...overrides });
}

const TICKETS = [
  ticket('backlog', 'T-100'),
  ticket('todo', 'T-101'),
  ...Array.from({ length: 8 }, (_, index) => ticket('in-progress', `T-${200 + index}`)),
  ticket('todo', 'T-300', {
    workflowStatus: 'blocked',
    returnStatus: 'qa-ready',
    blockedReason: 'A run stopped.',
    activity: { state: 'blocked', note: 'A run stopped.' },
  }),
  ticket('todo', 'T-301', {
    title: 'Escalated: scheduler failures on main',
    activity: { state: 'working', agent: 'senior', role: 'SeniorDeveloper', run: 'run-t-301', workflow: 'board-senior' },
  }),
  ticket('todo', 'T-302'),
  ticket('done', 'T-303'),
  ticket('todo', 'T-304', {
    workflowStatus: 'blocked',
    returnStatus: 'gone',
    blockedReason: 'Unknown return status.',
    activity: { state: 'blocked', note: 'Unknown return status.' },
  }),
];

function settings(overrides: Partial<BoardSettings> = {}): BoardSettings {
  return { ...boardSettingsFixture(), statuses: STATUSES, rules: RULES, ...overrides };
}

function ticketList(): BoardTicketList {
  return boardTicketListFixture({ phase: 'phase-05', statuses: STATUS_IDS, tickets: TICKETS });
}

const okR = <T,>(data: T) => ({ ok: true as const, data });

async function settle(): Promise<void> {
  await act(async () => {});
}

async function renderBoard(props: { hideEmpty?: boolean } = {}) {
  const fake = fakeManagement({
    boardPhases: [okR(boardPhasesFixture())],
    boardSettings: [okR(settings())],
    boardTickets: [okR(ticketList())],
  });
  const view = render(<CurrentPhaseScreen workspace={workspaceA} management={fake.api} {...props} />);
  await settle();
  return view;
}

describe('CurrentPhaseScreen lanes and columns', () => {
  it('renders the fixed columns in order with counts', async () => {
    const view = await renderBoard({ hideEmpty: false });
    const columns = [...view.container.querySelectorAll('.boards-column')];
    expect(columns.map(column => column.getAttribute('aria-label'))).toEqual([
      'Backlog column', 'Todo column', 'In Progress column', 'Done column', 'Closed column',
    ]);
    expect(columns.map(column => column.querySelector('.boards-column-count')?.textContent)).toEqual(['1', '5', '8', '1', '0']);
    expect(view.container.querySelector('.boards-lane-header')).toBeNull();
    expect(columns[4]!.textContent).toContain('No tickets');
  });

  it('keeps blocked tickets in their board status column', async () => {
    const view = await renderBoard();
    const todo = view.getByLabelText('Todo column');
    expect(todo.textContent).toContain('T-300');
    expect(todo.textContent).toContain('T-304');
    expect(view.queryByLabelText('Blocked column')).toBeNull();
  });

  it('shows six cards and expands the rest with Show N more', async () => {
    const view = await renderBoard();
    const devReady = view.getByLabelText('In Progress column');

    expect(devReady.querySelectorAll('[data-ticket-key]')).toHaveLength(6);
    const more = within(devReady).getByRole('button', { name: 'Show 2 more' });
    expect(more.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(more);
    expect(devReady.querySelectorAll('[data-ticket-key]')).toHaveLength(8);
    const fewer = within(devReady).getByRole('button', { name: 'Show fewer' });
    expect(fewer.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(fewer);
    expect(devReady.querySelectorAll('[data-ticket-key]')).toHaveLength(6);
  });
});

describe('CurrentPhaseScreen toolbar and filters', () => {
  function cards(view: ReturnType<typeof render>): string[] {
    return [...view.container.querySelectorAll('[data-ticket-key]')].map((card) => card.getAttribute('data-ticket-key') ?? '');
  }

  function countText(view: ReturnType<typeof render>): string {
    return view.container.querySelector('.boards-toolbar-count')?.textContent ?? '';
  }

  function search(view: ReturnType<typeof render>, value: string): void {
    fireEvent.change(view.getByPlaceholderText('Search tickets'), { target: { value } });
  }

  function chip(view: ReturnType<typeof render>, name: string): HTMLElement {
    return view.getByRole('button', { name });
  }

  it('searches keys and titles case-insensitively and shows the filtered count', async () => {
    const view = await renderBoard();
    expect(countText(view)).toBe('15 tickets');

    search(view, 't-20');
    expect(countText(view)).toBe('8 tickets');
    expect(cards(view).sort()).toEqual(['T-200', 'T-201', 'T-202', 'T-203', 'T-204', 'T-205']);
    fireEvent.click(view.getByRole('button', { name: 'Show 2 more' }));
    expect(cards(view).sort()).toEqual(['T-200', 'T-201', 'T-202', 'T-203', 'T-204', 'T-205', 'T-206', 'T-207']);
    expect(view.queryByText('T-100')).toBeNull();

    search(view, 'SCHEDULER');
    expect(countText(view)).toBe('1 ticket');
    expect(cards(view)).toEqual(['T-301']);
  });

  it('filters to blocked tickets with an aria-pressed chip and updates lane counts', async () => {
    const view = await renderBoard();
    const blocked = chip(view, 'Blocked only');
    expect(blocked.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(blocked);
    expect(blocked.getAttribute('aria-pressed')).toBe('true');
    expect(countText(view)).toBe('2 tickets');
    expect(cards(view).sort()).toEqual(['T-300', 'T-304']);
    expect(view.getByLabelText('Todo column').querySelector('.boards-column-count')?.textContent).toBe('2');

    fireEvent.click(blocked);
    expect(blocked.getAttribute('aria-pressed')).toBe('false');
    expect(countText(view)).toBe('15 tickets');
  });

  it('filters to working tickets with an aria-pressed chip', async () => {
    const view = await renderBoard();
    const working = chip(view, 'Working now');
    expect(working.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(working);
    expect(working.getAttribute('aria-pressed')).toBe('true');
    expect(countText(view)).toBe('1 ticket');
    expect(cards(view)).toEqual(['T-301']);
    expect(view.getByLabelText('Todo column').querySelector('.boards-column-count')?.textContent).toBe('1');
  });

  it('hides empty columns by default and toggles the chip off and on', async () => {
    const view = await renderBoard();
    const hideEmpty = chip(view, 'Hide empty columns');
    expect(hideEmpty.getAttribute('aria-pressed')).toBe('true');
    expect(view.queryByLabelText('Closed column')).toBeNull();

    fireEvent.click(hideEmpty);
    expect(hideEmpty.getAttribute('aria-pressed')).toBe('false');
    const closed = view.getByLabelText('Closed column');
    expect(closed.textContent).toContain('No tickets');
    expect(countText(view)).toBe('15 tickets');

    fireEvent.click(hideEmpty);
    expect(hideEmpty.getAttribute('aria-pressed')).toBe('true');
    expect(view.queryByLabelText('Closed column')).toBeNull();
  });

  it('combines search and chips with AND, keeps the progress unfiltered and clears to no match', async () => {
    const view = await renderBoard();
    const progress = view.getByRole('progressbar', { name: 'Phase progress' });
    expect(progress.getAttribute('aria-valuetext')).toBe('1 of 15 tickets done');

    search(view, 't-30');
    fireEvent.click(chip(view, 'Working now'));
    expect(countText(view)).toBe('1 ticket');
    expect(cards(view)).toEqual(['T-301']);
    expect(progress.getAttribute('aria-valuetext')).toBe('1 of 15 tickets done');

    fireEvent.click(chip(view, 'Blocked only'));
    expect(countText(view)).toBe('0 tickets');
    expect(view.getByText('No tickets match these filters')).toBeTruthy();
    expect(view.queryByLabelText('Todo column')).toBeNull();

    fireEvent.click(view.getByRole('button', { name: 'Clear filters' }));
    expect((view.getByPlaceholderText('Search tickets') as HTMLInputElement).value).toBe('');
    expect(chip(view, 'Blocked only').getAttribute('aria-pressed')).toBe('false');
    expect(chip(view, 'Working now').getAttribute('aria-pressed')).toBe('false');
    expect(chip(view, 'Hide empty columns').getAttribute('aria-pressed')).toBe('true');
    expect(countText(view)).toBe('15 tickets');
    expect(view.queryByText('No tickets match these filters')).toBeNull();
    expect(view.getByLabelText('Todo column')).toBeTruthy();
  });

  it('resets the filter state when the screen is left and mounted again', async () => {
    const first = await renderBoard();
    search(first, 'scheduler');
    fireEvent.click(chip(first, 'Blocked only'));
    expect(countText(first)).toBe('0 tickets');
    first.unmount();

    const second = await renderBoard();
    expect((second.getByPlaceholderText('Search tickets') as HTMLInputElement).value).toBe('');
    expect(countText(second)).toBe('15 tickets');
    expect(chip(second, 'Blocked only').getAttribute('aria-pressed')).toBe('false');
  });
});
