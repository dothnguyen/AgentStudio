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
    index: 0, status, type: 'agent', role: 'Developer', workflow: 'board-develop', during: null, action: null,
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
      rule('plan-merge-ready', { type: 'action', role: null, workflow: null, during: null, action: 'merge' }),
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


describe('workflow status chip', () => {
  it('shows configured names, status tones and the responsible role', () => {
    const statuses = [
      { id: 'dev-ready', name: 'Development ready', kind: null },
      { id: 'developing', name: 'Developing', kind: null },
      { id: 'blocked', name: 'Blocked', kind: null },
      { id: 'complete', name: 'Complete', kind: 'done' },
    ];
    const rules = [rule('dev-ready', { during: 'developing' })];
    for (const [id, label, tone, tooltip] of [
      ['dev-ready', 'Development ready', 'blue', 'Developer works this'],
      ['developing', 'Developing', 'amber', 'Developer works this'],
      ['blocked', 'Blocked', 'red', null],
      ['complete', 'Complete', 'green', null],
      ['unknown', 'unknown', 'blue', null],
    ]) {
      const view = render(<TicketCard ticket={boardTicketSummary({ workflowStatus: id! })} rules={rules} workflowStatuses={statuses} />);
      const chip = view.container.querySelector('[data-workflow-tone]');
      expect(chip?.textContent).toBe(label);
      expect(chip?.getAttribute('data-workflow-tone')).toBe(tone);
      expect(chip?.getAttribute('title')).toBe(tooltip);
      view.unmount();
    }
  });
});

describe('workflow attention cards', () => {
  const approval = { workflowRunId: 'run-1', stage: 'review', ask: 'Publish this?', since: '2026-01-01T00:00:00Z' };
  it('shows approval and submits approve or rejection with a note', async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    const view = render(<TicketCard ticket={boardTicketSummary({ waitingApproval: approval })} onApprove={onApprove} />);
    expect(view.getByText('Waiting for approval')).toBeTruthy();
    expect(view.getByText('Publish this?')).toBeTruthy();
    fireEvent.click(view.getByText('Approve'));
    expect(onApprove).toHaveBeenCalledWith({ workflowRunId: 'run-1', stage: 'review', approve: true });
    await vi.waitFor(() => expect(view.getByText('Reject…').hasAttribute('disabled')).toBe(false));
    fireEvent.click(view.getByText('Reject…'));
    fireEvent.change(view.getByLabelText('Note (optional)'), { target: { value: 'Revise it' } });
    fireEvent.click(view.getByText('Reject'));
    expect(onApprove).toHaveBeenLastCalledWith({ workflowRunId: 'run-1', stage: 'review', approve: false, note: 'Revise it' });
  });
  it('shows the question and opens the ticket, and renders a paused reason', () => {
    const open = vi.fn();
    const view = render(<TicketCard ticket={boardTicketSummary({ key: 'T-201', needsInput: { question: 'Which one?', since: '2026-01-01T00:00:00Z' } })} onOpenTicket={open} />);
    expect(view.getByText('Needs your answer')).toBeTruthy();
    expect(view.getByText('Which one?')).toBeTruthy();
    fireEvent.click(view.getByText('Answer…'));
    expect(open).toHaveBeenCalledWith('T-201');
    view.rerender(<TicketCard ticket={boardTicketSummary({ paused: { reason: 'usage limit', at: '2026-01-01T00:00:00Z' } })} />);
    expect(view.getByText('Paused · usage limit')).toBeTruthy();
  });
  it('reports a failed decision and permits retry', async () => {
    const view = render(<TicketCard ticket={boardTicketSummary({ waitingApproval: approval })} onApprove={vi.fn().mockRejectedValue(new Error('Failed'))} />);
    fireEvent.click(view.getByText('Approve'));
    expect((await view.findByRole('alert')).textContent).toBe('Failed');
  });
  it('selects approval before question or paused state and shows elapsed time', async () => {
    const { ticketAttention, elapsedAttention } = await import('../src/renderer/boards/ticketCardModel');
    const ticket = boardTicketSummary({
      waitingApproval: approval,
      needsInput: { question: 'Question', since: '2026-01-01T00:00:00Z' },
      paused: { reason: 'later', at: '2026-01-01T00:00:00Z' },
    });
    expect(ticketAttention(ticket)).toMatchObject({ kind: 'approval', label: 'Waiting for approval', text: 'Publish this?' });
    expect(elapsedAttention('2026-01-01T00:00:00Z', Date.parse('2026-01-01T01:05:00Z'))).toBe('1 hr');
    expect(elapsedAttention('invalid', Date.now())).toBe('');
  });
  it('shows the paused label and elapsed time for a paused-only ticket', async () => {
    const { ticketAttention, elapsedAttention } = await import('../src/renderer/boards/ticketCardModel');
    const paused = boardTicketSummary({ paused: { reason: 'usage limit', at: '2026-01-01T00:00:00Z' } });
    expect(ticketAttention(paused)).toMatchObject({ kind: 'paused', label: 'Paused · usage limit' });
    const view = render(<TicketCard ticket={paused} />);
    expect(view.container.querySelector('[data-attention="paused"]')).toBeTruthy();
    expect(elapsedAttention('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:42:00Z'))).toBe('42 min');
  });
});
