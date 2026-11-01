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
    index, status, type: 'agent', role, workflow: 'board-develop', action: null,
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
  ticket('refine-ready', 'T-101'),
  ...Array.from({ length: 8 }, (_, index) => ticket('dev-ready', `T-${200 + index}`)),
  ticket('blocked', 'T-300', { returnStatus: 'qa-ready', blockedReason: 'A run stopped.' }),
  ticket('need-escalate', 'T-301'),
  ticket('review-ready', 'T-302'),
  ticket('done', 'T-303'),
  ticket('blocked', 'T-304', { returnStatus: 'gone', blockedReason: 'Unknown return status.' }),
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
  it('renders the four lanes, their counts and the board columns in design order', async () => {
    const view = await renderBoard();

    expect([...view.container.querySelectorAll('.boards-lane')].map((lane) => lane.getAttribute('aria-label'))).toEqual([
      'Intake lane', 'Build lane', 'Review and merge lane', 'Finished lane',
    ]);

    const intake = view.getByLabelText('Intake lane');
    expect(intake.textContent).toContain('Intake');
    expect(intake.textContent).toContain('2 tickets');
    expect(within(intake).getByLabelText('Backlog column')).toBeTruthy();
    expect(within(intake).getByLabelText('Refine ready column')).toBeTruthy();

    const build = view.getByLabelText('Build lane');
    expect(build.textContent).toContain('Build');
    expect(build.textContent).toContain('11 tickets');
    expect(within(build).getAllByRole('region').map((column) => column.getAttribute('aria-label'))).toEqual([
      'Dev ready column', 'QA ready column', 'Needs escalation column', 'Blocked column',
    ]);
  });

  it('takes each worker line from the board rules and omits it when no rule applies', async () => {
    const view = await renderBoard();
    const built = view.getByLabelText('Build lane');
    const intake = view.getByLabelText('Intake lane');

    expect(within(built).getByLabelText('Dev ready column').textContent).toContain('Developer works this');
    expect(within(built).getByLabelText('QA ready column').textContent).toContain('QA works this');
    expect(within(built).getByLabelText('Needs escalation column').textContent).toContain('SeniorDeveloper works this');
    expect(within(built).getByLabelText('Blocked column').textContent).not.toContain('works this');
    expect(within(intake).getByLabelText('Backlog column').textContent).not.toContain('works this');
  });

  it('hides empty columns and names them in the lane placeholder', async () => {
    const view = await renderBoard();

    expect(view.queryByLabelText('Unpack ready column')).toBeNull();
    expect(within(view.getByLabelText('Intake lane')).getByText('1 empty hidden: Unpack ready')).toBeTruthy();
    expect(within(view.getByLabelText('Review and merge lane')).getByText(
      '4 empty hidden: Plan merge ready, Plan merge conflict, Merge ready, Merge conflict',
    )).toBeTruthy();
  });

  it('shows empty columns with No tickets when hideEmpty is off', async () => {
    const view = await renderBoard({ hideEmpty: false });

    const unpack = view.getByLabelText('Unpack ready column');
    expect(unpack.textContent).toContain('No tickets');
    expect(view.queryByText(/empty hidden/)).toBeNull();
  });

  it('collapses Finished by default and expands it with the chevron', async () => {
    const view = await renderBoard();
    const finished = view.getByLabelText('Finished lane');

    const expand = within(finished).getByRole('button', { name: 'Expand Finished lane' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(within(finished).queryByLabelText('Done column')).toBeNull();
    expect(finished.textContent).toContain('1 ticket');

    fireEvent.click(expand);
    const collapse = within(finished).getByRole('button', { name: 'Collapse Finished lane' });
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    expect(within(finished).getByLabelText('Done column')).toBeTruthy();
  });

  it('places blocked tickets in their return status column and falls back to a Blocked column', async () => {
    const view = await renderBoard();
    const build = view.getByLabelText('Build lane');

    expect(within(build).getByLabelText('QA ready column').textContent).toContain('T-300');
    const blocked = within(build).getByLabelText('Blocked column');
    expect(blocked.textContent).toContain('T-304');
    expect(blocked.textContent).not.toContain('T-300');
  });

  it('shows six cards and expands the rest with Show N more', async () => {
    const view = await renderBoard();
    const devReady = within(view.getByLabelText('Build lane')).getByLabelText('Dev ready column');

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
