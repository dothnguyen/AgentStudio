import { describe, expect, it } from 'vitest';
import type { AttentionCommandRequest, AttentionRun, BlockedTicket } from '../src/renderer/api';
import { buildAttentionRows } from '../src/renderer/boards/attentionModel';
import { boardTicketSummary } from './boardFixtures';
import { member, overviewFixture, team } from './teamsFixtures';

function blockedTicket(overrides: Partial<BlockedTicket> = {}): BlockedTicket {
  return {
    key: 'T-136',
    title: 'Fix flaky teamsA11y focus test after the dialog change',
    reason: 'The run was stopped when the team stopped. Unblock it to continue.',
    returnStatus: 'qa-ready',
    memberId: 'dev',
    updatedAt: '2026-11-01T10:41:00Z',
    ...overrides,
  };
}

function commandRequest(overrides: Partial<AttentionCommandRequest> = {}): AttentionCommandRequest {
  return {
    id: 'cmd-1',
    command: 'app-dev-dependency-add',
    status: 'requested',
    reason: null,
    workflowRunId: 'run-t-124',
    memberId: 'dev',
    ...overrides,
  };
}

function attentionRun(overrides: Partial<AttentionRun> = {}): AttentionRun {
  return {
    workflowRunId: 'run-t-124',
    status: 'paused',
    stage: 'develop',
    memberId: 'dev',
    ticketKey: 'T-124',
    assignmentId: null,
    assignmentStatus: null,
    diagnosticCode: null,
    delegating: false,
    ...overrides,
  };
}

function overview(parts: {
  blocked?: BlockedTicket[];
  runs?: AttentionRun[];
  commandRequests?: AttentionCommandRequest[];
}) {
  return overviewFixture([
    team({
      members: [member({ memberId: 'dev', name: 'dev', role: 'Developer' })],
      attention: {
        runs: parts.runs ?? [],
        commandRequests: parts.commandRequests ?? [],
        truncated: { runs: false, commandRequests: false },
      },
    }),
  ], { blockedTickets: parts.blocked ?? [] });
}

describe('buildAttentionRows', () => {
  it('lists blocked tickets first with their key, title and first reason line', () => {
    const rows = buildAttentionRows(overview({
      blocked: [blockedTicket({ reason: 'The run was stopped.\nUnblock it to continue.' })],
    }));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'blocked',
      key: 'T-136',
      title: 'Fix flaky teamsA11y focus test after the dialog change',
      reason: 'The run was stopped.',
      ticketKey: 'T-136',
    });
  });

  it('uses a blocked ticket on the board when the overview omits it, without duplicating the overview row', () => {
    const board = boardTicketSummary({
      key: 'T-200',
      status: 'in-progress', workflowStatus: 'blocked',
      blockedReason: 'QA stopped the run.',
      activity: { state: 'blocked', note: 'QA stopped the run.' },
    });
    const duplicate = boardTicketSummary({ key: 'T-136', status: 'in-progress', workflowStatus: 'blocked' });

    const rows = buildAttentionRows(
      overview({ blocked: [blockedTicket()] }),
      [board, duplicate],
    );

    expect(rows.map((row) => row.key)).toEqual(['T-136', 'T-200']);
    expect(rows[1]?.reason).toBe('QA stopped the run.');
  });

  it('lists only delegated commands waiting for approval, with the approver role and the ticket key from its run', () => {
    const rows = buildAttentionRows(overview({
      runs: [attentionRun({ status: 'running' })],
      commandRequests: [
        commandRequest(),
        commandRequest({ id: 'cmd-2', command: 'app-deps-install', status: 'approved' }),
      ],
    }));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'command',
      key: 'T-124',
      ticketKey: 'T-124',
      title: 'A delegated command waits for approval: app-dev-dependency-add',
      reason: 'Requested by Developer. It needs a human to approve it before the ticket can continue.',
    });
  });

  it('keeps paused and diagnosed runs and leaves ordinary running runs out', () => {
    const rows = buildAttentionRows(overview({
      runs: [
        attentionRun({ workflowRunId: 'run-paused', ticketKey: 'T-300', stage: 'qa' }),
        attentionRun({ workflowRunId: 'run-failed', status: 'running', ticketKey: 'T-301', stage: null, diagnosticCode: 'LEASE_LOST' }),
        attentionRun({ workflowRunId: 'run-working', status: 'running', ticketKey: 'T-302' }),
        attentionRun({ workflowRunId: 'run-queued', status: 'queued', ticketKey: 'T-303', stage: null }),
      ],
    }));

    expect(rows.map((row) => row.key)).toEqual(['T-300', 'T-301']);
    expect(rows[0]).toMatchObject({
      source: 'run',
      title: 'A workflow run is paused',
      reason: 'Paused at stage qa.',
      ticketKey: 'T-300',
    });
    expect(rows[1]).toMatchObject({
      source: 'run',
      title: 'A workflow run needs attention',
      reason: 'The run reported LEASE_LOST.',
      ticketKey: 'T-301',
    });
  });

  it('orders blocked tickets, then commands, then runs', () => {
    const rows = buildAttentionRows(overview({
      blocked: [blockedTicket()],
      runs: [attentionRun()],
      commandRequests: [commandRequest()],
    }));

    expect(rows.map((row) => row.source)).toEqual(['blocked', 'command', 'run']);
  });

  it('returns no rows when nothing needs attention', () => {
    expect(buildAttentionRows(overview({}))).toEqual([]);
  });

  it('skips blocked tickets with empty or whitespace-only keys', () => {
    const rows = buildAttentionRows(overview({
      blocked: [
        blockedTicket({ key: '' }),
        blockedTicket({ key: '  ' }),
        blockedTicket({ key: 'T-136' }),
      ],
    }));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe('T-136');
  });

  it('deduplicates blocked tickets from overview and board', () => {
    const board = boardTicketSummary({
      key: 'T-136',
      status: 'blocked',
      blockedReason: 'A run stopped.',
      activity: { state: 'blocked', note: 'A run stopped.' },
    });

    const rows = buildAttentionRows(
      overview({ blocked: [blockedTicket()] }),
      [board],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe('T-136');
  });

  it('handles blocked tickets with whitespace-only reason', () => {
    const rows = buildAttentionRows(overview({
      blocked: [blockedTicket({ reason: '   ' })],
    }));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('Blocked. Unblock it to continue.');
  });

  it('handles command requests with no matching run (no ticket key)', () => {
    const rows = buildAttentionRows(overview({
      commandRequests: [commandRequest({ workflowRunId: 'run-no-ticket' })],
    }));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'command',
      key: 'run-no-ticket',
      ticketKey: null,
    });
  });

  it('uses member ID when role and name are missing', () => {
    const rows = buildAttentionRows(overview({
      commandRequests: [commandRequest({ memberId: 'unknown-id' })],
    }));

    expect(rows[0]?.reason).toContain('Requested by unknown-id.');
  });

  it('uses member name when role is missing', () => {
    const customOverview = overviewFixture([
      team({
        members: [member({ memberId: 'dev', name: 'Alice', role: '' })],
        attention: {
          runs: [],
          commandRequests: [commandRequest({ memberId: 'dev' })],
          truncated: { runs: false, commandRequests: false },
        },
      }),
    ], { blockedTickets: [] });

    const rows = buildAttentionRows(customOverview);

    expect(rows[0]?.reason).toContain('Requested by Alice.');
  });

  it('handles runs without ticketKey', () => {
    const rows = buildAttentionRows(overview({
      runs: [attentionRun({ ticketKey: '', workflowRunId: 'run-no-ticket', stage: 'develop' })],
    }));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'run',
      key: 'run-no-ticket',
      ticketKey: null,
    });
  });

  it('shows paused-run reason with stage', () => {
    const rows = buildAttentionRows(overview({
      runs: [attentionRun({ stage: 'qa' })],
    }));

    expect(rows[0]?.reason).toBe('Paused at stage qa.');
  });

  it('shows generic reason for paused run with no stage', () => {
    const rows = buildAttentionRows(overview({
      runs: [attentionRun({ stage: null })],
    }));

    expect(rows[0]?.reason).toBe('The run needs a human to retry or cancel it.');
  });

  it('shows diagnostic code reason instead of stage', () => {
    const rows = buildAttentionRows(overview({
      runs: [attentionRun({ status: 'running', stage: 'develop', diagnosticCode: 'TIMEOUT' })],
    }));

    expect(rows[0]).toMatchObject({
      title: 'A workflow run needs attention',
      reason: 'The run reported TIMEOUT.',
    });
  });

  it('skips runs with whitespace-only diagnostic and no stage', () => {
    const rows = buildAttentionRows(overview({
      runs: [
        attentionRun({ diagnosticCode: '  ', stage: null, status: 'running' }),
        attentionRun({ diagnosticCode: 'ERROR', stage: 'develop' }),
      ],
    }));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toContain('ERROR');
  });
});
