import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { activityIcon, availabilityIcon, boardStatusIcon } from '../src/renderer/dashboard/dashboardIcons';

const spec = (name: string, tone: string | null = null) => ({ name, tone });
const board = (status: string, kind: 'initial' | 'done' | 'closed' | null) => boardStatusIcon({ status, kind });
const act = (name: string, kind: string) => activityIcon({ name, kind: kind as never });

describe('dashboard icon mappers', () => {
  it('board_status_icon_maps_kinds_first', () => {
    expect(board('backlog', 'initial')).toEqual(spec('document'));
    expect(board('done', 'done')).toEqual(spec('check-circle', 'success'));
    expect(board('close', 'closed')).toEqual(spec('lock'));
    expect(board('review-ready', 'done')).toEqual(spec('check-circle', 'success'));
  });

  it('board_status_icon_maps_status_keywords', () => {
    expect(board('unpack-ready', null)).toEqual(spec('box'));
    for (const s of ['refine-ready', 'merge-ready', 'plan-merge-conflict']) expect(board(s, null)).toEqual(spec('git-branch'));
    expect(board('dev-ready', null)).toEqual(spec('code'));
    expect(board('qa-ready', null)).toEqual(spec('search'));
    for (const s of ['review-ready', 'In-Review']) expect(board(s, null)).toEqual(spec('teams'));
  });

  it('board_status_icon_falls_back_to_item', () => {
    expect(board('future-status', null)).toEqual(spec('item'));
    expect(boardStatusIcon({ status: 'x', kind: 'future-kind' as never })).toEqual(spec('item'));
  });

  it('activity_icon_maps_names_first', () => {
    expect(act('ticket.merged', 'ticket')).toEqual(spec('git-branch'));
    expect(act('ticket.moved', 'ticket')).toEqual(spec('arrow-right'));
    expect(act('workflow.transition', 'workflow')).toEqual(spec('arrow-right'));
    expect(act('task.finished', 'assignment')).toEqual(spec('check-circle', 'success'));
    expect(act('run.completed', 'workflow')).toEqual(spec('check-circle', 'success'));
  });

  it('activity_icon_falls_back_to_kind', () => {
    expect(act('ticket.outcome_applied', 'ticket')).toEqual(spec('ticket'));
    expect(act('team.running', 'team')).toEqual(spec('teams'));
    expect(act('assignment.succeeded', 'assignment')).toEqual(spec('check'));
    expect(act('workflow_run.paused', 'workflow')).toEqual(spec('gear'));
    expect(act('unknown', 'future')).toEqual(spec('item'));
  });

  it('availability_icon_maps_states', () => {
    expect(availabilityIcon('busy')).toEqual(spec('clock', 'warning'));
    expect(availabilityIcon('error')).toEqual(spec('warning', 'danger'));
    expect(availabilityIcon('limit_reached')).toEqual(spec('warning', 'danger'));
    for (const s of ['idle', 'waiting_input', 'starting', 'offline'] as const) expect(availabilityIcon(s)).toBeNull();
  });

  it('icon_mappers_contain_no_software_board_status_literals', () => {
    const text = readFileSync(resolve(__dirname, '../src/renderer/dashboard/dashboardIcons.ts'), 'utf8');
    for (const word of ['backlog', 'unpack', 'refine', 'dev', 'qa', 'review', 'merge']) {
      expect(text.includes(`${word}-ready`)).toBe(false);
    }
    expect(text.includes('backlog')).toBe(false);
  });
});
