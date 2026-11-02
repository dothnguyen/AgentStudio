import { describe, expect, it } from 'vitest';
import type { BoardTicketEvent } from '../src/renderer/api';
import { boardTicketDetailFixture } from './boardFixtures';
import {
  blockedReturnLabel,
  formatLocalTime,
  openDependencyKeys,
  shortenRunId,
  ticketActivitySummary,
  ticketDetails,
  ticketEventRows,
  ticketStatusChip,
  ticketStatusId,
  ticketWork,
  waitsForRows,
} from '../src/renderer/boards/ticketPageModel';

describe('ticket page status chip', () => {
  it('uses the return status for a blocked ticket', () => {
    const ticket = { workflowStatus: 'blocked', returnStatus: 'qa-ready' };
    expect(ticketStatusId(ticket)).toBe('qa-ready');
    expect(ticketStatusChip(ticket)).toEqual({ id: 'qa-ready', label: 'QA ready', tone: 'blue' });
  });

  it('falls back to the blocked status when no return status is known', () => {
    expect(ticketStatusId({ workflowStatus: 'blocked', returnStatus: null })).toBe('blocked');
    expect(ticketStatusChip({ workflowStatus: 'blocked', returnStatus: '  ' })).toEqual({
      id: 'blocked', label: 'Blocked', tone: 'red',
    });
  });

  it('honours board display names and status kinds', () => {
    const statuses = [
      { id: 'dev-ready', name: 'Ready for dev', kind: null },
      { id: 'done', name: null, kind: 'done' },
    ];
    expect(ticketStatusChip({ workflowStatus: 'dev-ready', returnStatus: null }, statuses)).toEqual({
      id: 'dev-ready', label: 'Ready for dev', tone: 'blue',
    });
    expect(ticketStatusChip({ workflowStatus: 'done', returnStatus: null }, statuses)).toEqual({
      id: 'done', label: 'Done', tone: 'green',
    });
  });

  it('names the status a blocked ticket returns to', () => {
    expect(blockedReturnLabel({ workflowStatus: 'blocked', returnStatus: 'qa-ready' })).toBe('QA ready');
    expect(blockedReturnLabel({ workflowStatus: 'blocked', returnStatus: null })).toBeNull();
    expect(blockedReturnLabel({ workflowStatus: 'dev-ready', returnStatus: 'qa-ready' })).toBeNull();
  });
});

describe('ticket activity summary', () => {
  it('turns the detail links into the card open-dependency list', () => {
    const detail = boardTicketDetailFixture('T-118');
    expect(openDependencyKeys(detail)).toEqual(['T-117']);
    const summary = ticketActivitySummary(detail);
    expect(summary.key).toBe('T-118');
    expect(summary.openDependsOn).toEqual(['T-117']);
    expect(summary).not.toHaveProperty('body');
  });
});

describe('ticket timeline events', () => {
  const at = new Date(2026, 10, 1, 13, 57).toISOString();
  const event = (id: number, name: string, overrides: Partial<BoardTicketEvent> = {}): BoardTicketEvent => ({
    id,
    at,
    actor: 'coordinator',
    name,
    from: null,
    to: null,
    payload: {},
    ...overrides,
  });

  it('maps the known event names to their labels, details and dot tones', () => {
    const rows = ticketEventRows([
      event(1, 'ticket.created', { from: null, to: 'dev-ready', actor: 'operator' }),
      event(2, 'ticket.depends', { payload: { on: ['T-113'] } }),
      event(3, 'ticket.moved', { from: 'dev-ready', to: 'qa-ready', actor: 'operator' }),
      event(4, 'ticket.claimed', { to: 'dev-ready', payload: { agent: 'dev' } }),
      event(5, 'ticket.claimed', { to: 'dev-ready', payload: { agent: 'dev' } }),
      event(6, 'ticket.command_requested', { payload: { command: 'test-ui' } }),
      event(7, 'ticket.command_finished', { payload: { command: 'test-ui', status: 'succeeded', durationMs: 14 * 60_000 } }),
      event(8, 'ticket.committed', { payload: { message: 'Roles v2 (3/4): edit dialogs' } }),
      event(9, 'ticket.outcome_applied', {
        to: 'dev-ready',
        payload: { outcome: 'fail', rounds: 1, reason: 'Round 1 failed: 2 findings; going round 2' },
      }),
      event(10, 'ticket.outcome_applied', { to: 'qa-ready', payload: { outcome: 'pass', rounds: 1 } }),
    ]);

    expect(rows.map((row) => [row.title, row.detail, row.tone])).toEqual([
      ['Created', null, 'grey'],
      ['Depends on T-113', null, 'grey'],
      ['Moved to qa-ready', 'Moved by operator', 'blue'],
      ['Claimed by dev', 'Round 1', 'green'],
      ['Claimed by dev', 'Round 2', 'green'],
      ['Command requested: test-ui', 'Waiting for the coordinator to run it', 'amber'],
      ['Command finished: test-ui', 'Passed in 14 min', 'green'],
      ['Committed', 'Roles v2 (3/4): edit dialogs', 'green'],
      ['Outcome applied: dev-ready', 'Round 1 failed: 2 findings; going round 2', 'amber'],
      ['Outcome applied: qa-ready', 'Round 1 passed', 'blue'],
    ]);
    expect(rows[0]!.time).toBe('Sun 13:57');
  });

  it('renders a failed command in amber and reads the summary from the payload', () => {
    const rows = ticketEventRows([
      event(1, 'ticket.command_finished', {
        payload: { command: 'test-ui', status: 'failed', durationMs: 45_000 },
      }),
      event(2, 'ticket.outcome_applied', {
        to: 'qa-ready',
        payload: { outcome: 'fail', summary: 'Two findings; going round 2' },
      }),
    ]);
    expect(rows[0]).toMatchObject({ detail: 'Failed in 45 s', tone: 'amber' });
    expect(rows[1]).toMatchObject({ detail: 'Two findings; going round 2', tone: 'amber' });
  });

  it('keeps an unknown event name raw with spaces and no detail', () => {
    const [row] = ticketEventRows([event(1, 'ticket.some_new_event', { payload: { anything: true } })]);
    expect(row).toMatchObject({ title: 'ticket some new event', detail: null, tone: 'grey' });
  });

  it('formats local times and shortens run ids for the Work card', () => {
    expect(formatLocalTime('not a date')).toBe('—');
    expect(formatLocalTime(null)).toBe('—');
    expect(shortenRunId('9a77ab12c3d1')).toBe('9a77…c3d1');
    expect(shortenRunId('run-t-114')).toBe('run-t-114');
    expect(shortenRunId(null)).toBeNull();

    const detail = boardTicketDetailFixture('T-114');
    const work = ticketWork(detail, [{
      index: 0, status: 'dev-ready', type: 'agent', role: 'Developer', workflow: 'board-develop',
      action: null, onPass: 'qa-ready', onFail: 'dev-ready', onBlocked: null, workspace: 'worktree',
      syncBase: false, maxRounds: 6, priority: null, onFailureLimit: null, protected: false,
    }]);
    expect(work).toEqual({
      owner: 'dev', round: '2 of 6', branch: 'ticket/t-114', run: 'run-t-114', runId: 'run-t-114',
    });
    expect(ticketDetails(detail)).toMatchObject({ phase: 'Phase 05', priority: '20' });
  });
});

describe('ticket dependencies and work empty states', () => {
  it('labels dependency rows and treats a stale link as unknown', () => {
    const detail = boardTicketDetailFixture('T-114');
    detail.links.dependsOn = [
      { key: 'T-113', title: 'Roles v2: role page', status: 'review-ready', phase: 'phase-05' },
      { key: 'T-999', title: null, status: null, phase: null },
    ];
    const rows = waitsForRows(detail, []);
    expect(rows.map((row) => [row.key, row.statusLabel, row.statusTone])).toEqual([
      ['T-113', 'Review ready', 'blue'],
      ['T-999', 'Unknown', 'neutral'],
    ]);
  });

  it('shows nobody working and em dashes when a ticket is idle', () => {
    const detail = boardTicketDetailFixture('T-118');
    detail.ticket.activity = { state: 'not started' };
    detail.ticket.activeRunId = null;
    detail.ticket.runId = null;
    detail.ticket.branch = null;
    detail.events = [];
    const work = ticketWork(detail);
    expect(work).toEqual({
      owner: 'Nobody is working on this ticket', round: '—', branch: 'No branch yet', run: '—', runId: null,
    });
  });
});
