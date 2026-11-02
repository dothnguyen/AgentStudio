import { describe, expect, it } from 'vitest';
import type { BoardRuleView } from '../src/renderer/api';
import {
  BOARD_CARD_LIMIT,
  buildBoardLanes,
  hiddenColumnsLabel,
  humanizeStatusId,
  laneCountLabel,
  statusLabel,
  statusTone,
  workerLineForStatus,
  type BoardStatusInfo,
} from '../src/renderer/boards/boardLanes';
import { boardTicketSummary } from './boardFixtures';

const STATUS_IDS = [
  'backlog', 'unpack-ready', 'refine-ready', 'dev-ready', 'qa-ready', 'need-escalate',
  'review-ready', 'plan-merge-ready', 'plan-merge-conflict', 'merge-ready', 'merge-conflict', 'done', 'close',
];

const STATUSES: BoardStatusInfo[] = STATUS_IDS.map((id) => ({
  id,
  name: id === 'need-escalate' ? 'Needs escalation' : id === 'qa-ready' ? 'QA ready' : id,
  kind: id === 'backlog' ? 'initial' : id === 'done' ? 'done' : id === 'close' ? 'closed' : null,
}));

function rule(status: string, role: string, index = 0): BoardRuleView {
  return {
    index, status, type: 'agent', role, workflow: 'board-develop', action: null,
    onPass: 'done', onFail: 'dev-ready', onBlocked: null, workspace: 'worktree',
    syncBase: false, maxRounds: null, priority: null, onFailureLimit: null, protected: false,
  };
}

function action(status: string, action: string, index = 0): BoardRuleView {
  return {
    ...rule(status, '', index), type: 'action', role: null, workflow: null, action,
  };
}

const RULES: BoardRuleView[] = [
  rule('unpack-ready', 'ProductOwner', 0),
  rule('refine-ready', 'TeamLead', 1),
  rule('dev-ready', 'Developer', 2),
  rule('qa-ready', 'QA', 3),
  rule('need-escalate', 'SeniorDeveloper', 4),
  rule('review-ready', 'Reviewer', 5),
  action('plan-merge-ready', 'merge', 6),
  rule('plan-merge-conflict', 'TeamLead', 7),
  action('merge-ready', 'merge', 8),
  rule('merge-conflict', 'TeamLead', 9),
];

let counter = 0;

function ticket(status: string, overrides: NonNullable<Parameters<typeof boardTicketSummary>[0]> = {}) {
  counter += 1;
  return boardTicketSummary({ key: `T-${100 + counter}`, status, ...overrides });
}

describe('buildBoardLanes', () => {
  it('groups tickets into Intake, Build, Review and merge and Finished from the fake board', () => {
    const tickets = [
      ticket('backlog', { key: 'T-101' }),
      ticket('unpack-ready', { key: 'T-102' }),
      ticket('refine-ready', { key: 'T-103' }),
      ticket('dev-ready', { key: 'T-104' }),
      ticket('qa-ready', { key: 'T-105' }),
      ticket('need-escalate', { key: 'T-106' }),
      ticket('review-ready', { key: 'T-107' }),
      ticket('done', { key: 'T-108' }),
    ];
    const lanes = buildBoardLanes(STATUSES, RULES, tickets);

    expect(lanes.map((lane) => lane.name)).toEqual(['Intake', 'Build', 'Review and merge', 'Finished']);
    expect(lanes.map((lane) => lane.total)).toEqual([3, 3, 1, 1]);
    expect(lanes[0]!.columns.map((column) => column.id)).toEqual(['backlog', 'unpack-ready', 'refine-ready']);
    expect(lanes[1]!.columns.map((column) => column.id)).toEqual(['dev-ready', 'qa-ready', 'need-escalate']);
    expect(lanes[2]!.columns.map((column) => column.id)).toEqual(['review-ready']);
    expect(lanes[3]!.columns.map((column) => column.id)).toEqual(['done']);
    expect(lanes[3]!.columns[0]!.tickets.map((entry) => entry.key)).toEqual(['T-108']);
  });

  it('puts a status that is not in the design lanes into an Other lane', () => {
    const statuses = [...STATUSES, { id: 'triage', name: 'Triage', kind: null }];
    const lanes = buildBoardLanes(statuses, RULES, [ticket('triage', { key: 'T-200' })]);

    const other = lanes[lanes.length - 1]!;
    expect(other.name).toBe('Other');
    expect(other.total).toBe(1);
    expect(other.columns.map((column) => column.id)).toEqual(['triage']);
    expect(other.columns[0]!.label).toBe('Triage');
  });

  it('shows a blocked ticket in its return status column', () => {
    const blocked = ticket('blocked', { key: 'T-300', returnStatus: 'qa-ready' });
    const lanes = buildBoardLanes(STATUSES, RULES, [blocked]);

    const build = lanes.find((lane) => lane.id === 'build')!;
    expect(build.columns.find((column) => column.id === 'qa-ready')!.tickets.map((entry) => entry.key)).toEqual(['T-300']);
    expect(build.columns.some((column) => column.id === 'blocked')).toBe(false);
    expect(build.total).toBe(1);
  });

  it('adds one Blocked column at the end of Build when the return status is unknown', () => {
    const tickets = [
      ticket('blocked', { key: 'T-301', returnStatus: 'qa-ready' }),
      ticket('blocked', { key: 'T-302', returnStatus: 'gone' }),
      ticket('blocked', { key: 'T-303', returnStatus: null }),
    ];
    const lanes = buildBoardLanes(STATUSES, RULES, tickets);

    const build = lanes.find((lane) => lane.id === 'build')!;
    expect(build.columns.map((column) => column.id)).toEqual(['qa-ready', 'blocked']);
    expect(build.columns[build.columns.length - 1]).toMatchObject({
      id: 'blocked', label: 'Blocked', fallback: true,
    });
    expect(build.columns[build.columns.length - 1]!.tickets.map((entry) => entry.key)).toEqual(['T-302', 'T-303']);
    expect(build.total).toBe(3);
  });

  it('describes hidden empty columns and keeps their order for the placeholder', () => {
    const lanes = buildBoardLanes(STATUSES, RULES, [
      ticket('backlog', { key: 'T-401' }),
      ticket('refine-ready', { key: 'T-402' }),
    ]);

    const intake = lanes[0]!;
    expect(intake.columns.map((column) => column.id)).toEqual(['backlog', 'refine-ready']);
    expect(intake.hiddenColumns.map((column) => column.label)).toEqual(['Unpack ready']);
    expect(hiddenColumnsLabel(intake.hiddenColumns)).toBe('1 empty hidden: Unpack ready');
    expect(intake.total).toBe(2);
    expect(hiddenColumnsLabel([])).toBeNull();
  });

  it('keeps empty columns when hideEmpty is off', () => {
    const lanes = buildBoardLanes(STATUSES, RULES, [ticket('dev-ready', { key: 'T-500' })], { hideEmpty: false });

    const intake = lanes[0]!;
    expect(intake.columns.map((column) => column.id)).toEqual(['backlog', 'unpack-ready', 'refine-ready']);
    expect(intake.hiddenColumns).toEqual([]);
    expect(intake.columns.every((column) => column.tickets.length === 0)).toBe(true);
  });

  it('filters cards and counts while keeping hide-empty based on the unfiltered board', () => {
    const tickets = [
      ticket('backlog', { key: 'T-601' }),
      ticket('dev-ready', { key: 'T-602' }),
      ticket('blocked', { key: 'T-603', returnStatus: 'qa-ready', activity: { state: 'blocked', note: 'Stopped.' } }),
    ];
    const lanes = buildBoardLanes(STATUSES, RULES, tickets, {
      matches: (entry) => entry.activity.state === 'blocked',
    });

    expect(lanes.map((lane) => lane.total)).toEqual([0, 1, 0, 0]);
    const intake = lanes[0]!;
    // Backlog still has a raw ticket, so the column stays visible with no matching card.
    expect(intake.columns.map((column) => column.id)).toEqual(['backlog']);
    expect(intake.columns[0]!.tickets).toEqual([]);
    expect(intake.hiddenColumns.map((column) => column.id)).toEqual(['unpack-ready', 'refine-ready']);
    expect(lanes.find((lane) => lane.id === 'build')!.columns.find((column) => column.id === 'qa-ready')!
      .tickets.map((entry) => entry.key)).toEqual(['T-603']);
  });
});

describe('column labels and worker lines', () => {
  it('uses the board name when present and humanizes a missing name', () => {
    expect(statusLabel({ id: 'qa-ready', name: 'QA ready' })).toBe('QA ready');
    expect(statusLabel({ id: 'need-escalate', name: 'need-escalate' })).toBe('Needs escalation');
    expect(humanizeStatusId('plan-merge-conflict')).toBe('Plan merge conflict');
    expect(humanizeStatusId('triage')).toBe('Triage');
  });

  it('takes the worker line from the board rules and omits it when no rule applies', () => {
    expect(workerLineForStatus('dev-ready', RULES)).toBe('Developer works this');
    expect(workerLineForStatus('need-escalate', RULES)).toBe('SeniorDeveloper works this');
    expect(workerLineForStatus('merge-ready', RULES)).toBe('Merges automatically');
    expect(workerLineForStatus('done', RULES)).toBeNull();
  });

  it('tones the known statuses like the design', () => {
    expect(statusTone({ id: 'done' })).toBe('green');
    expect(statusTone({ id: 'need-escalate' })).toBe('amber');
    expect(statusTone({ id: 'merge-conflict' })).toBe('red');
    expect(statusTone({ id: 'backlog', kind: 'initial' })).toBe('neutral');
    expect(statusTone({ id: 'review-ready', kind: null })).toBe('blue');
  });

  it('pluralizes lane counts', () => {
    expect(laneCountLabel(1)).toBe('1 ticket');
    expect(laneCountLabel(3)).toBe('3 tickets');
    expect(BOARD_CARD_LIMIT).toBe(6);
  });
});
