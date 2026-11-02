import { describe, expect, it } from 'vitest';
import { boardTicketDetailFixture } from './boardFixtures';
import {
  blockedReturnLabel,
  openDependencyKeys,
  ticketActivitySummary,
  ticketStatusChip,
  ticketStatusId,
} from '../src/renderer/boards/ticketPageModel';

describe('ticket page status chip', () => {
  it('uses the return status for a blocked ticket', () => {
    const ticket = { status: 'blocked', returnStatus: 'qa-ready' };
    expect(ticketStatusId(ticket)).toBe('qa-ready');
    expect(ticketStatusChip(ticket)).toEqual({ id: 'qa-ready', label: 'QA ready', tone: 'blue' });
  });

  it('falls back to the blocked status when no return status is known', () => {
    expect(ticketStatusId({ status: 'blocked', returnStatus: null })).toBe('blocked');
    expect(ticketStatusChip({ status: 'blocked', returnStatus: '  ' })).toEqual({
      id: 'blocked', label: 'Blocked', tone: 'red',
    });
  });

  it('honours board display names and status kinds', () => {
    const statuses = [
      { id: 'dev-ready', name: 'Ready for dev', kind: null },
      { id: 'done', name: null, kind: 'done' },
    ];
    expect(ticketStatusChip({ status: 'dev-ready', returnStatus: null }, statuses)).toEqual({
      id: 'dev-ready', label: 'Ready for dev', tone: 'blue',
    });
    expect(ticketStatusChip({ status: 'done', returnStatus: null }, statuses)).toEqual({
      id: 'done', label: 'Done', tone: 'green',
    });
  });

  it('names the status a blocked ticket returns to', () => {
    expect(blockedReturnLabel({ status: 'blocked', returnStatus: 'qa-ready' })).toBe('QA ready');
    expect(blockedReturnLabel({ status: 'blocked', returnStatus: null })).toBeNull();
    expect(blockedReturnLabel({ status: 'dev-ready', returnStatus: 'qa-ready' })).toBeNull();
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
