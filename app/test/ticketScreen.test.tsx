// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardSettings, BoardTicketDetail, Result } from '../src/renderer/api';
import { TicketScreen } from '../src/renderer/boards/TicketScreen';
import { boardTicketDetailFixture } from './boardFixtures';
import { workspaceA } from './dashboardFixtures';
import { boardSettingsFixture, fakeManagement } from './teamsFixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const okR = <T,>(data: T): Result<T> => ({ ok: true, data });

function ticketSettings(overrides: Partial<BoardSettings> = {}): BoardSettings {
  const base = boardSettingsFixture();
  return {
    ...base,
    statuses: [
      { id: 'dev-ready', name: 'Dev ready', kind: null },
      { id: 'qa-ready', name: 'QA ready', kind: null },
      { id: 'done', name: 'Done', kind: 'done' },
      { id: 'blocked', name: null, kind: null },
    ],
    workflowStatuses: [
      { id: 'dev-ready', name: 'Dev ready', kind: null },
      { id: 'qa-ready', name: 'QA ready', kind: null },
      { id: 'done', name: 'Done', kind: 'done' },
      { id: 'blocked', name: null, kind: null },
    ],
    rules: [{
      index: 0, status: 'dev-ready', type: 'agent', role: 'Developer', workflow: 'board-develop',
      action: null, onPass: 'qa-ready', onFail: 'dev-ready', onBlocked: null, workspace: 'worktree',
      syncBase: false, maxRounds: 6, priority: null, onFailureLimit: null, protected: false,
    }],
    ...overrides,
  };
}

function setupTicket(options: {
  key?: string;
  detail?: BoardTicketDetail;
  ticketResults?: Array<Result<BoardTicketDetail>>;
  settings?: BoardSettings;
  boardLabel?: string;
  onOpenBoard?: () => void;
  onOpenTicket?: (key: string) => void;
} = {}) {
  const key = options.key ?? 'T-114';
  const detail = options.detail ?? boardTicketDetailFixture(key);
  const boardTicket = options.ticketResults === undefined
    ? vi.fn(async (_id: string, _input: { key: string }) => okR(detail))
    : vi.fn(async (_id: string, _input: { key: string }) => options.ticketResults!.shift()!);
  const fake = fakeManagement({
    boardSettings: [okR(options.settings ?? ticketSettings())],
    calls: { boardTicket },
  });
  const view = render(
    <TicketScreen
      workspace={workspaceA}
      management={fake.api}
      ticketKey={key}
      boardLabel={options.boardLabel}
      onOpenBoard={options.onOpenBoard}
      onOpenTicket={options.onOpenTicket}
    />,
  );
  return { view, fake, boardTicket, detail };
}

async function settle(): Promise<void> {
  await act(async () => {});
}

describe('TicketScreen header', () => {
  it('renders the breadcrumb, key, status, working chip and title from fake data', async () => {
    const onOpenBoard = vi.fn();
    const { view, boardTicket, detail } = setupTicket({ onOpenBoard });
    await settle();

    const breadcrumb = view.getByRole('navigation', { name: 'Breadcrumb' });
    expect(breadcrumb.textContent).toContain('Boards');
    expect(breadcrumb.textContent).toContain('Current Phase');
    expect(breadcrumb.querySelector('[aria-current="page"]')?.textContent).toBe('T-114');

    expect(view.container.querySelector('.boards-ticket-key-chip')?.textContent).toBe('T-114');
    expect(view.container.querySelector('.boards-ticket-column-chip')?.textContent).toBe(detail.ticket.status);
    const status = view.container.querySelector('.boards-ticket-status-chip')!;
    expect(status.textContent).toBe('Dev ready');
    expect(status.querySelector('.boards-status-dot-blue')).toBeTruthy();
    expect(view.container.querySelector('.boards-ticket-activity-chip')?.textContent).toBe('Working · round 2/6');
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Roles v2: edit dialogs and the New role dialog');

    fireEvent.click(view.getByRole('button', { name: 'Current Phase' }));
    expect(onOpenBoard).toHaveBeenCalledTimes(1);
    expect(boardTicket).toHaveBeenCalledWith(workspaceA.id, { key: 'T-114' });
  });

  it('uses a custom board label for the breadcrumb when opened elsewhere', async () => {
    const onOpenBoard = vi.fn();
    const { view } = setupTicket({ boardLabel: 'Backlog', onOpenBoard });
    await settle();
    const breadcrumb = view.getByRole('navigation', { name: 'Breadcrumb' });
    expect(breadcrumb.textContent).toContain('Backlog');
    fireEvent.click(view.getByRole('button', { name: 'Backlog' }));
    expect(onOpenBoard).toHaveBeenCalledTimes(1);
  });

  it('renders the Phases breadcrumb variant and returns through its first board crumb', async () => {
    const onOpenBoard = vi.fn();
    const { view } = setupTicket({ boardLabel: 'Phases', onOpenBoard });
    await settle();

    const breadcrumb = view.getByRole('navigation', { name: 'Breadcrumb' });
    expect(breadcrumb.textContent).toContain('Boards');
    expect(breadcrumb.textContent).toContain('Phases');
    expect(breadcrumb.querySelector('[aria-current="page"]')?.textContent).toBe('T-114');
    fireEvent.click(within(breadcrumb).getByRole('button', { name: 'Phases' }));
    expect(onOpenBoard).toHaveBeenCalledTimes(1);
  });

  it('renders a waiting ticket with its dependency and non-default priority', async () => {
    const { view } = setupTicket({ key: 'T-118' });
    await settle();

    expect(view.container.querySelector('.boards-ticket-activity-chip')?.textContent).toBe('Waits for T-117');
    expect(view.container.querySelector('.boards-ticket-activity-chip')?.getAttribute('data-chip')).toBe('waiting');
    expect(view.getByText('Priority 50')).toBeTruthy();
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Routing v1: edit, add and remove rules in dialogs');
  });

  it('renders a finished ticket as merged without a blocked banner', async () => {
    const { view } = setupTicket({ key: 'T-112' });
    await settle();

    expect(view.container.querySelector('.boards-ticket-status-chip')?.textContent).toBe('Done');
    expect(view.container.querySelector('.boards-ticket-status-chip .boards-status-dot-green')).toBeTruthy();
    expect(view.container.querySelector('.boards-ticket-activity-chip')?.textContent).toBe('Merged');
    expect(view.container.querySelector('.boards-ticket-activity-chip')?.getAttribute('data-chip')).toBe('done');
    expect(view.queryByText(/It returns to/)).toBeNull();
  });
});

describe('TicketScreen blocked banner', () => {
  it('shows the blocked reason and the return status, read-only', async () => {
    const onOpenBoard = vi.fn();
    const { view } = setupTicket({ key: 'T-136', onOpenBoard });
    await settle();

    const banner = view.getByRole('status');
    expect(banner.classList.contains('boards-blocked-banner')).toBe(true);
    expect(banner.textContent).toContain('Blocked.');
    expect(banner.textContent).toContain('The run was stopped when the team stopped. Unblock it to continue.');
    expect(banner.textContent).toContain('It returns to QA ready when it is unblocked.');

    expect(view.container.querySelector('.boards-ticket-status-chip')?.textContent).toBe('QA ready');
    expect(view.container.querySelector('.boards-ticket-chips')?.textContent).toContain('Blocked');
    expect(view.container.querySelector('.boards-ticket-activity-chip')?.textContent).toBe('Blocked');
    expect(view.container.querySelector('.boards-ticket-activity-chip')?.getAttribute('data-chip')).toBe('blocked');
    expect(view.getByRole('button', { name: 'Current Phase' })).toBeTruthy();
    expect(view.container.querySelector('.boards-blocked-banner button')).toBeNull();
  });
});

describe('TicketScreen workflow actions', () => {
  it('reopens a closed claimed ticket through the Todo status picker and reloads it', async () => {
    const detail = boardTicketDetailFixture('T-114');
    detail.ticket.status = 'closed';
    detail.ticket.assignee = 'agent';
    const boardTicket = vi.fn(async () => okR(detail));
    const ticketMove = vi.fn(async () => ({ ok: true as const, data: {} }));
    const settings = ticketSettings({ todoEntry: ['qa-ready'], todoDefault: 'qa-ready' });
    const fake = fakeManagement({ boardSettings: [okR(settings)], calls: { boardTicket, ticketMove } });
    const view = render(<TicketScreen workspace={workspaceA} management={fake.api} ticketKey="T-114" />);
    await settle();

    fireEvent.click(view.getByRole('button', { name: 'Reopen' }));
    expect(view.getByRole('dialog', { name: 'Reopen ticket' })).toBeTruthy();
    expect((view.getByLabelText('Workflow status') as HTMLSelectElement).value).toBe('qa-ready');
    fireEvent.click(view.getByRole('dialog', { name: 'Reopen ticket' }).querySelector('button.dialog-action-primary')!);

    await waitFor(() => expect(boardTicket).toHaveBeenCalledTimes(2));
    expect(ticketMove).toHaveBeenCalledWith(workspaceA.id, { key: 'T-114', to: 'todo', workflowStatus: 'qa-ready', force: true });
  });

  it('applies an allowed workflow status and reloads the ticket after success', async () => {
    const detail = boardTicketDetailFixture('T-114');
    detail.ticket.status = 'todo';
    detail.ticket.assignee = null;
    const boardTicket = vi.fn(async () => okR(detail));
    const ticketWorkflow = vi.fn(async () => ({ ok: true as const, data: {} }));
    const fake = fakeManagement({
      boardSettings: [okR(ticketSettings())],
      calls: { boardTicket, ticketWorkflow },
    });
    const view = render(<TicketScreen workspace={workspaceA} management={fake.api} ticketKey="T-114" />);
    await settle();
    fireEvent.click(view.getByRole('button', { name: 'Change workflow status' }));
    const select = view.getByLabelText('Workflow status') as HTMLSelectElement;
    expect(Array.from(select.options).map(option => option.value)).toEqual(['qa-ready']);
    fireEvent.click(view.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(boardTicket).toHaveBeenCalledTimes(2));
    expect(ticketWorkflow).toHaveBeenCalledWith(workspaceA.id, { key: 'T-114', to: 'qa-ready' });
  });

  it('shows workflow action errors inline', async () => {
    const detail = boardTicketDetailFixture('T-114');
    detail.ticket.status = 'todo';
    detail.ticket.assignee = null;
    const ticketWorkflow = vi.fn(async () => ({ ok: false as const, error: { code: 'INVALID', message: 'Status is unavailable', retryable: false } }));
    const boardTicket = vi.fn(async () => okR(detail));
    const fake = fakeManagement({ boardSettings: [okR(ticketSettings())], calls: { boardTicket, ticketWorkflow } });
    const view = render(<TicketScreen workspace={workspaceA} management={fake.api} ticketKey="T-114" />);
    await settle();
    fireEvent.click(view.getByRole('button', { name: 'Change workflow status' }));
    fireEvent.click(view.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(view.getByRole('alert').textContent).toBe('Status is unavailable'));
  });
});

describe('TicketScreen description', () => {
  it('renders the ticket body in the monospace card', async () => {
    const { view } = setupTicket();
    await settle();

    const card = view.getByRole('region', { name: 'Description' });
    expect(card.classList.contains('section-card')).toBe(true);
    expect(card.classList.contains('boards-description-card')).toBe(true);
    expect(card.textContent).toContain('The ticket body. The next agent receives it as its task.');
    const body = card.querySelector('.boards-ticket-body') as HTMLElement;
    expect(body.tagName).toBe('PRE');
    expect(body.textContent).toContain('## Goal');
    expect(body.textContent).toContain('## Done when');
  });

  it('explains an empty body instead of rendering a blank box', async () => {
    const detail = boardTicketDetailFixture('T-114');
    detail.ticket.body = null;
    const { view } = setupTicket({ detail });
    await settle();

    expect(view.getByText('This ticket has no body.')).toBeTruthy();
  });
});

describe('TicketScreen timeline', () => {
  const at = new Date(2026, 10, 1, 13, 57).toISOString();

  function timelineDetail(): BoardTicketDetail {
    const detail = boardTicketDetailFixture('T-114');
    detail.events = [
      { id: 1, at, actor: 'operator', name: 'ticket.created', from: null, to: 'dev-ready', payload: { key: 'T-114' } },
      { id: 2, at, actor: 'operator', name: 'ticket.moved', from: 'dev-ready', to: 'qa-ready', payload: {} },
      { id: 3, at, actor: 'operator', name: 'ticket.workflow_changed', from: 'dev-ready', to: 'qa-ready', payload: {} },
      { id: 4, at, actor: 'operator', name: 'ticket.migrated', from: 'qa-ready', to: 'dev-ready', payload: {} },
      { id: 5, at, actor: 'coordinator', name: 'ticket.some_new_event', from: null, to: null, payload: {} },
    ];
    detail.eventsTruncated = true;
    return detail;
  }

  it('renders events oldest first with labels, details, times and the truncation notice', async () => {
    const { view } = setupTicket({ detail: timelineDetail() });
    await settle();

    const card = view.getByRole('region', { name: 'Timeline' });
    expect(card.textContent).toContain('What happened to this ticket, oldest first.');
    expect(card.textContent).toContain('Showing the latest 5 events');
    const rows = Array.from(card.querySelectorAll('.boards-event-row'));
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.querySelector('.boards-event-title')?.textContent)).toEqual([
      'Created', 'Moved to qa-ready', 'Workflow status changed', 'Workflow status migrated', 'ticket some new event',
    ]);
    expect(rows[1]!.querySelector('.boards-event-detail')?.textContent).toBe('Moved by operator');
    expect(rows[0]!.querySelector('.boards-event-dot-grey')).toBeTruthy();
    expect(rows[1]!.querySelector('.boards-event-dot-blue')).toBeTruthy();
    expect(rows[0]!.querySelector('.boards-event-time')?.textContent).toBe('Sun 13:57');
  });

  it('does not show the truncation notice when every event is present', async () => {
    const detail = timelineDetail();
    detail.eventsTruncated = false;
    const { view } = setupTicket({ detail });
    await settle();
    expect(view.queryByText(/Showing the latest/)).toBeNull();
  });

  it('renders paused, cancelled, and approval decision events with their details', async () => {
    const detail = timelineDetail();
    detail.events = [
      { id: 6, at, actor: 'coordinator', name: 'ticket.run_paused', from: null, to: null, payload: { reason: 'Waiting for approval' } },
      { id: 7, at, actor: 'operator', name: 'ticket.run_cancelled', from: null, to: null, payload: { reason: 'User stopped the run' } },
      { id: 8, at, actor: 'operator', name: 'ticket.approval_decided', from: null, to: null, payload: { outcome: 'pass', note: 'Looks good' } },
      { id: 9, at, actor: 'operator', name: 'ticket.approval_decided', from: null, to: null, payload: { outcome: 'fail', note: 'Please revise' } },
    ];
    detail.eventsTruncated = false;
    const { view } = setupTicket({ detail });
    await settle();

    const rows = Array.from(view.getByRole('region', { name: 'Timeline' }).querySelectorAll('.boards-event-row'));
    expect(rows.map((row) => row.querySelector('.boards-event-title')?.textContent)).toEqual([
      'Run paused', 'Run cancelled', 'Approved', 'Rejected',
    ]);
    expect(rows.map((row) => row.querySelector('.boards-event-detail')?.textContent)).toEqual([
      'Waiting for approval', 'User stopped the run', 'Looks good', 'Please revise',
    ]);
  });
});

describe('TicketScreen work card', () => {
  it('shows the owner, round, branch and shortened run with the full id in title', async () => {
    const detail = boardTicketDetailFixture('T-114');
    detail.ticket.activeRunId = '9a77ab12c3d1';
    const { view } = setupTicket({ detail });
    await settle();

    const card = view.getByRole('region', { name: 'Work' });
    expect(card.textContent).toContain('Who is on it now.');
    expect(card.textContent).toContain('dev');
    expect(card.textContent).toContain('2 of 6');
    expect(card.textContent).toContain('ticket/t-114');
    const run = card.querySelector('[title="9a77ab12c3d1"]');
    expect(run?.textContent).toBe('9a77…c3d1');
  });

  it('explains that nobody is working on an idle ticket', async () => {
    const detail = boardTicketDetailFixture('T-118');
    detail.ticket.activity = { state: 'not started' };
    detail.ticket.activeRunId = null;
    detail.ticket.runId = null;
    detail.ticket.branch = null;
    detail.events = [];
    const { view } = setupTicket({ detail });
    await settle();

    const card = view.getByRole('region', { name: 'Work' });
    expect(card.textContent).toContain('Nobody is working on this ticket');
    expect(card.textContent).toContain('No branch yet');
    expect(card.textContent).toContain('—');
  });
});

describe('TicketScreen dependencies card', () => {
  it('links each waiting and blocking ticket with its status label', async () => {
    const onOpenTicket = vi.fn();
    const { view } = setupTicket({ onOpenTicket });
    await settle();

    const card = view.getByRole('region', { name: 'Dependencies' });
    const waits = view.getByRole('heading', { name: 'Waits for' });
    const blocks = view.getByRole('heading', { name: 'Blocks' });
    expect(waits.compareDocumentPosition(blocks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.textContent).toContain('Dev ready');

    fireEvent.click(within(card).getByRole('button', { name: /T-113/ }));
    expect(onOpenTicket).toHaveBeenLastCalledWith('T-113');
    fireEvent.click(within(card).getByRole('button', { name: /T-115/ }));
    expect(onOpenTicket).toHaveBeenLastCalledWith('T-115');
  });

  it('shows None for both empty dependency lists', async () => {
    const detail = boardTicketDetailFixture('T-138');
    detail.links = { dependsOn: [], dependents: [] };
    const { view } = setupTicket({ key: 'T-138', detail });
    await settle();

    const card = view.getByRole('region', { name: 'Dependencies' });
    expect(within(card).getAllByText('None')).toHaveLength(2);
    expect(within(card).queryByRole('button')).toBeNull();
  });
});

describe('TicketScreen details and column order', () => {
  it('shows the phase, priority and local created/updated times', async () => {
    const detail = boardTicketDetailFixture('T-114');
    detail.ticket.createdAt = new Date(2026, 10, 1, 13, 57).toISOString();
    detail.ticket.updatedAt = new Date(2026, 10, 1, 21, 12).toISOString();
    const { view } = setupTicket({ detail });
    await settle();

    const card = view.getByRole('region', { name: 'Details' });
    expect(card.textContent).toContain('Phase 05');
    expect(card.textContent).toContain('20');
    expect(card.textContent).toContain('Sun 13:57');
    expect(card.textContent).toContain('Sun 21:12');
  });

  it('stacks Work, Dependencies and Details in that order on the right', async () => {
    const { view } = setupTicket();
    await settle();

    const aside = view.getByRole('complementary', { name: 'Ticket details' });
    const headings = Array.from(aside.querySelectorAll(':scope > section')).map((section) => section.querySelector('h2')?.textContent);
    expect(headings).toEqual(['Work', 'Dependencies', 'Details']);
  });
});

describe('TicketScreen states', () => {
  it('shows a loading state while the ticket reads are pending', async () => {
    const fake = fakeManagement({
      boardSettings: [okR(ticketSettings())],
      calls: { boardTicket: vi.fn(() => new Promise<never>(() => {})) },
    });
    const view = render(<TicketScreen workspace={workspaceA} management={fake.api} ticketKey="T-114" />);
    await settle();

    expect(view.getByRole('status').textContent).toContain('Loading the ticket…');
    expect(view.getByRole('navigation', { name: 'Breadcrumb' }).textContent).toContain('T-114');
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('shows a ticket not found state with a link back to the board', async () => {
    const onOpenBoard = vi.fn();
    const notFound: Result<BoardTicketDetail> = {
      ok: false,
      error: { code: 'TICKET_NOT_FOUND', message: 'Ticket does not exist.', retryable: false },
    };
    const { view } = setupTicket({ key: 'T-999', ticketResults: [notFound], onOpenBoard });
    await settle();

    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Ticket not found');
    expect(view.getByText('No ticket with key T-999 exists on this board.')).toBeTruthy();
    expect(view.getByRole('navigation', { name: 'Breadcrumb' }).textContent).toContain('T-999');
    fireEvent.click(view.getByRole('button', { name: 'Back to Current Phase' }));
    expect(onOpenBoard).toHaveBeenCalledTimes(1);
  });

  it('shows an error card and recovers when Retry succeeds', async () => {
    const error: Result<BoardTicketDetail> = {
      ok: false,
      error: { code: 'BOARD_DOWN', message: 'the ticket store is unreadable', retryable: true },
    };
    const { view, boardTicket } = setupTicket({ ticketResults: [error, okR(boardTicketDetailFixture('T-114'))] });
    await settle();

    const alert = view.getByRole('alert');
    expect(alert.textContent).toContain('BOARD_DOWN');
    expect(alert.textContent).toContain('the ticket store is unreadable');

    fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    await settle();

    expect(boardTicket).toHaveBeenCalledTimes(2);
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Roles v2: edit dialogs and the New role dialog');
  });

  it('still renders the ticket when only the board settings read fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const key = 'T-114';
    const detail = boardTicketDetailFixture(key);
    const boardTicket = vi.fn(async () => okR(detail));
    const fake = fakeManagement({
      boardSettings: [{ ok: false, error: { code: 'SETTINGS_DOWN', message: 'no rules', retryable: true } }],
      calls: { boardTicket },
    });
    const view = render(<TicketScreen workspace={workspaceA} management={fake.api} ticketKey={key} />);
    await settle();

    expect(view.getByRole('heading', { level: 1 }).textContent).toBe(detail.ticket.title);
    expect(view.container.querySelector('.boards-ticket-activity-chip')?.textContent).toBe('Working');
    expect(view.queryByRole('alert')).toBeNull();
  });
});

describe('ticket attention panels', () => {
  const context = { workflow: 'Publish', stage: 'approve', assignmentId: 'assignment-1', member: 'editor', agent: 'Agent', routes: { pass: 'publish', fail: '$fail' }, end: { fail: 'To edit' } };
  it.each([true, false])('sends approval decision %s with the note and refreshes', async (approve) => {
    const detail = boardTicketDetailFixture('T-114');
    detail.ticket.waitingApproval = { workflowRunId: 'run-1', stage: 'approve', ask: 'Publish?', since: '2026-01-01T00:00:00Z' };
    detail.attentionContext = context;
    const decide = vi.fn(async () => okR({ workflowRunId: 'run-1', stage: 'approve', outcome: 'pass' }));
    const boardTicket = vi.fn(async () => okR(detail));
    const fake = fakeManagement({ boardSettings: [okR(ticketSettings())], calls: { boardTicket, approveWorkflow: decide } });
    render(<TicketScreen workspace={workspaceA} management={fake.api} ticketKey="T-114" />);
    await settle();
    expect(screen.getByText('Waiting for your approval')).toBeTruthy();
    expect(screen.getByText('Publish?')).toBeTruthy();
    expect(screen.getByText(/Workflow Publish · step approve · since/)).toBeTruthy();
    expect(screen.getByText(/Approve → step publish\. Reject → workflow fails: To edit\./)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'Please revise' } });
    fireEvent.click(screen.getByRole('button', { name: approve ? 'Approve' : 'Reject' }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith(workspaceA.id, { workflowRunId: 'run-1', stage: 'approve', approve, note: 'Please revise' }));
    await waitFor(() => expect(screen.getByText('Sent')).toBeTruthy());
    expect(boardTicket).toHaveBeenCalledTimes(2);
  });
  it('shows approval errors inline and keeps the panel available for retry', async () => {
    const detail = boardTicketDetailFixture('T-114');
    detail.ticket.waitingApproval = { workflowRunId: 'run-1', stage: 'approve', ask: 'Publish?', since: '2026-01-01T00:00:00Z' };
    detail.attentionContext = context;
    const decide = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'NO', message: 'Approval unavailable', retryable: false } })
      .mockResolvedValueOnce(okR({ workflowRunId: 'run-1', stage: 'approve', outcome: 'pass' }));
    const fake = fakeManagement({ boardSettings: [okR(ticketSettings())], calls: { boardTicket: async () => okR(detail), approveWorkflow: decide } });
    render(<TicketScreen workspace={workspaceA} management={fake.api} ticketKey="T-114" />);
    await settle();

    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'Please revise' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Approval unavailable'));
    expect(screen.queryByText('Sent')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(screen.getByText('Sent')).toBeTruthy());
    expect(decide).toHaveBeenNthCalledWith(1, workspaceA.id, { workflowRunId: 'run-1', stage: 'approve', approve: true, note: 'Please revise' });
    expect(decide).toHaveBeenNthCalledWith(2, workspaceA.id, { workflowRunId: 'run-1', stage: 'approve', approve: false, note: 'Please revise' });
  });
  it('sends an answer and shows errors inline', async () => {
    const detail = boardTicketDetailFixture('T-114');
    detail.ticket.needsInput = { question: 'Which database?', since: '2026-01-01T00:00:00Z' };
    detail.attentionContext = context;
    const answer = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'NO', message: 'Try again', retryable: false } }).mockResolvedValueOnce(okR({}));
    const fake = fakeManagement({ boardSettings: [okR(ticketSettings())], calls: { boardTicket: async () => okR(detail), answerAssignment: answer } });
    render(<TicketScreen workspace={workspaceA} management={fake.api} ticketKey="T-114" />);
    await settle();
    expect(screen.getByText('The agent asked a question')).toBeTruthy();
    expect(screen.getByText('Which database?')).toBeTruthy();
    expect(screen.getByText(/Workflow Publish · step approve · editor \(Agent\) · since/)).toBeTruthy();
    expect(screen.getByText('The same session continues with your answer')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Postgres' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Try again'));
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await waitFor(() => expect(screen.getByText('Sent')).toBeTruthy());
    expect(answer).toHaveBeenCalledWith(workspaceA.id, { assignmentId: 'assignment-1', answer: 'Postgres' });
  });
  it('shows a new question after an answer refreshes the ticket', async () => {
    const first = boardTicketDetailFixture('T-114');
    first.ticket.needsInput = { question: 'First?', since: '2026-01-01T00:00:00Z' };
    first.attentionContext = context;
    const next = boardTicketDetailFixture('T-114');
    next.ticket.needsInput = { question: 'Second?', since: '2026-01-01T00:01:00Z' };
    next.attentionContext = context;
    const boardTicket = vi.fn().mockResolvedValueOnce(okR(first)).mockResolvedValue(okR(next));
    const fake = fakeManagement({ boardSettings: [okR(ticketSettings())], calls: { boardTicket, answerAssignment: async () => okR({}) } });
    render(<TicketScreen workspace={workspaceA} management={fake.api} ticketKey="T-114" />);
    await settle();
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Answer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await waitFor(() => expect(screen.getByText('Second?')).toBeTruthy());
    expect(screen.queryByText('Sent')).toBeNull();
  });
});
