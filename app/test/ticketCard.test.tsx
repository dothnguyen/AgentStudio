// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardRuleView } from '../src/renderer/api';
import { TicketCard } from '../src/renderer/boards/TicketCard';
import { agentInitials, blockedReasonLine, roundLabel } from '../src/renderer/boards/ticketCardModel';
import { boardTicketSummary } from './boardFixtures';

afterEach(cleanup);

function rule(status: string, overrides: Partial<BoardRuleView> = {}): BoardRuleView {
  return {
    index: 0, status, type: 'agent', role: 'Developer', workflow: 'board-develop', action: null,
    onPass: 'done', onFail: 'dev-ready', onBlocked: null, workspace: 'worktree',
    syncBase: false, maxRounds: null, priority: null, onFailureLimit: null, protected: false,
    ...overrides,
  };
}

function cardChip(overrides: NonNullable<Parameters<typeof boardTicketSummary>[0]>, rules: readonly BoardRuleView[] = []) {
  const ticket = boardTicketSummary(overrides);
  const view = render(<TicketCard ticket={ticket} rules={rules} />);
  return view.container.querySelector('.boards-ticket-chip');
}

describe('TicketCard activity chip', () => {
  it('shows green Working when working without a complete round count', () => {
    const chip = cardChip({ status: 'dev-ready', rounds: { 'dev-ready': 2 }, activity: { state: 'working', agent: 'dev' } });
    expect(chip?.textContent).toBe('Working');
    expect(chip?.getAttribute('data-chip')).toBe('working');
  });

  it('adds round X/Y only when the current round and the rule limit are both known', () => {
    const ticket = boardTicketSummary({
      status: 'dev-ready', rounds: { 'dev-ready': 2 },
      activity: { state: 'working', agent: 'dev' },
    });

    expect(roundLabel(ticket, [rule('dev-ready', { maxRounds: 6 })])).toBe('round 2/6');

    const view = render(<TicketCard ticket={ticket} rules={[rule('dev-ready', { maxRounds: 6 })]} />);
    expect(view.container.querySelector('.boards-ticket-chip')?.textContent).toBe('Working · round 2/6');

    expect(roundLabel(ticket, [rule('dev-ready', { maxRounds: null })])).toBeNull();
    expect(roundLabel(boardTicketSummary({ status: 'dev-ready', rounds: null, activity: { state: 'working' } }), [rule('dev-ready', { maxRounds: 6 })])).toBeNull();
  });

  it('shows an amber Blocked chip and the first blocked-reason line under the title', () => {
    const view = render(<TicketCard ticket={boardTicketSummary({
      status: 'blocked',
      returnStatus: 'qa-ready',
      blockedReason: 'The run was stopped.\nUnblock it to continue.',
      activity: { state: 'blocked', note: 'The run was stopped.\nUnblock it to continue.' },
    })} />);

    const chip = view.container.querySelector('.boards-ticket-chip');
    expect(chip?.textContent).toBe('Blocked');
    expect(chip?.getAttribute('data-chip')).toBe('blocked');
    expect(view.container.querySelector('.boards-ticket-reason')?.textContent).toBe('The run was stopped.');
    expect(view.container.textContent).not.toContain('Unblock it to continue.');
    expect(blockedReasonLine(' \nsecond')).toBeNull();
  });

  it('shows a grey Waits for chip with the first open dependency and +N for the rest', () => {
    const multiple = cardChip({
      status: 'dev-ready', openDependsOn: ['T-114', 'T-115', 'T-116'],
      activity: { state: 'not started', waitingFor: 'Developer' },
    }, [rule('dev-ready')]);
    expect(multiple?.textContent).toBe('Waits for T-114 +2');
    expect(multiple?.getAttribute('data-chip')).toBe('waiting');

    const single = cardChip({ status: 'dev-ready', openDependsOn: ['T-114'], activity: { state: 'not started', waitingFor: 'Developer' } });
    expect(single?.textContent).toBe('Waits for T-114');
  });

  it('shows blue Ready, queued for a not-started ticket in a worker status', () => {
    const chip = cardChip({
      status: 'dev-ready',
      activity: { state: 'not started', waitingFor: 'Developer' },
    }, [rule('dev-ready')]);
    expect(chip?.textContent).toBe('Ready, queued');
    expect(chip?.getAttribute('data-chip')).toBe('queued');
  });

  it('shows grey Not started when no worker rule owns the status', () => {
    const withAction = cardChip({ status: 'plan-merge-ready', activity: { state: 'not started' } }, [
      rule('plan-merge-ready', { type: 'action', role: null, workflow: null, action: 'merge' }),
    ]);
    expect(withAction?.textContent).toBe('Not started');
    expect(withAction?.getAttribute('data-chip')).toBe('idle');

    const withoutRule = cardChip({ status: 'backlog', activity: { state: 'not started' } });
    expect(withoutRule?.textContent).toBe('Not started');
  });

  it('shows green Merged for a done ticket and Closed for a closed one', () => {
    const done = cardChip({ status: 'done', activity: { state: 'finished' } });
    expect(done?.textContent).toBe('Merged');
    expect(done?.getAttribute('data-chip')).toBe('done');

    expect(cardChip({ status: 'close', activity: { state: 'finished' } })?.textContent).toBe('Closed');
  });
});

describe('TicketCard details', () => {
  it('shows the priority tag top-right only when priority is not 100', () => {
    const normal = render(<TicketCard ticket={boardTicketSummary({ priority: 100 })} />);
    expect(normal.queryByText(/Priority/)).toBeNull();
    normal.unmount();

    const view = render(<TicketCard ticket={boardTicketSummary({ priority: 50 })} />);
    const priority = view.getByText('Priority 50');
    expect(priority.className).toBe('boards-ticket-priority');
    expect(view.container.querySelector('.boards-ticket-head')?.lastElementChild).toBe(priority);
  });

  it('shows the owner initials badge and agent name from activity.agent, and hides them when absent', () => {
    const view = render(<TicketCard ticket={boardTicketSummary({
      status: 'dev-ready', rounds: { 'dev-ready': 1 },
      activity: { state: 'working', agent: 'Senior Developer' },
    })} />);
    expect(view.getByText('SD')).toBeTruthy();
    expect(view.getByText('Senior Developer')).toBeTruthy();

    const noAgent = render(<TicketCard ticket={boardTicketSummary({ activity: { state: 'not started' } })} />);
    expect(noAgent.container.querySelector('.boards-ticket-owner')).toBeNull();
    expect(agentInitials('dev')).toBe('DE');
    expect(agentInitials('qa')).toBe('QA');
  });

  it('uses a green or amber left edge for working and blocked cards and no colour otherwise', () => {
    const working = render(<TicketCard ticket={boardTicketSummary({ activity: { state: 'working' } })} />);
    expect(working.getByRole('button').getAttribute('data-activity')).toBe('working');
    working.unmount();

    const blocked = render(<TicketCard ticket={boardTicketSummary({ status: 'blocked', activity: { state: 'blocked' } })} />);
    expect(blocked.getByRole('button').getAttribute('data-activity')).toBe('blocked');
    blocked.unmount();

    const idle = render(<TicketCard ticket={boardTicketSummary({ activity: { state: 'not started' } })} />);
    expect(idle.getByRole('button').getAttribute('data-activity')).toBe('idle');
  });

  it('navigates on click and on Enter or Space', () => {
    const onOpenTicket = vi.fn();
    const view = render(<TicketCard ticket={boardTicketSummary({ key: 'T-114' })} onOpenTicket={onOpenTicket} />);
    const button = view.getByRole('button', { name: 'Open T-114: Boards v1: Current Phase board and ticket page' });

    fireEvent.click(button);
    expect(onOpenTicket).toHaveBeenLastCalledWith('T-114');

    onOpenTicket.mockClear();
    expect(fireEvent.keyDown(button, { key: 'Enter' })).toBe(false);
    expect(onOpenTicket).toHaveBeenLastCalledWith('T-114');

    onOpenTicket.mockClear();
    expect(fireEvent.keyDown(button, { key: ' ' })).toBe(false);
    expect(onOpenTicket).toHaveBeenLastCalledWith('T-114');
  });
});
