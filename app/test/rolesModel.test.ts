import { describe, expect, it } from 'vitest';
import { assignedMemberLabels, filterRoleRows, roleDisplayLabel, roleInitials, roleIssueSummary, roleRunningAssignments, roleRuntimeState, requestedRoleSelection, roleRows, roleUsageSummary, selectedRoleId } from '../src/renderer/roles/rolesModel';
import { MEMBERS, roleItem, rolesFixture, usageOf } from './rolesFixtures';

describe('rolesModel', () => {
  it('searches_id_name_description_case_insensitively_in_file_order', () => {
    const rows = roleRows(rolesFixture().items);
    expect(rows.map(r => r.key)).toEqual(rows.map(r => `role:${r.role.id}`));
    expect(filterRoleRows(rows, '  ').length).toBe(rows.length);
    expect(filterRoleRows(rows, ' REVIEW ').map(r => r.role.id)).toEqual(['Reviewer']);
    expect(filterRoleRows(rows, 'implements').map(r => r.role.id)).toEqual(['Developer']);
    expect(filterRoleRows(rows, 'r').map(r => r.catalogIndex)).toEqual([0, 1, 2, 3, 4]);
    // Instructions, skills and usage are not searched.
    expect(filterRoleRows(rows, 'python-testing')).toEqual([]);
    expect(filterRoleRows(rows, 'Write tests')).toEqual([]);
    expect(filterRoleRows(rows, 'Core')).toEqual([]);
  });

  it('selection_persists_while_visible_then_falls_back_to_first_or_null', () => {
    const rows = roleRows(rolesFixture().items);
    expect(selectedRoleId(rows, 'Writer')).toBe('Writer');
    expect(selectedRoleId(rows, 'gone')).toBe('Developer');
    expect(selectedRoleId(rows, null)).toBe('Developer');
    const filtered = filterRoleRows(rows, 'review');
    expect(selectedRoleId(filtered, 'Writer')).toBe('Reviewer');
    expect(selectedRoleId([], 'Writer')).toBeNull();
  });

  it('builds_display_labels_initials_and_exact_issue_counts', () => {
    expect(roleDisplayLabel(roleItem('a', { name: '  Code Reviewer ' }))).toBe('Code Reviewer');
    expect(roleDisplayLabel(roleItem('plan', { name: '  ' }))).toBe('plan');
    expect(roleInitials(roleItem('a', { name: 'code reviewer extra' }))).toBe('CR');
    expect(roleInitials(roleItem('a', { name: 'solo' }))).toBe('S');
    expect(roleInitials(roleItem('a', { name: '😀 émile' }))).toBe('😀É');
    expect(roleInitials(roleItem('  ', { name: ' ' }))).toBe('?');
    expect(roleIssueSummary(roleItem('a'))).toBe('No warnings');
    expect(roleIssueSummary(roleItem('a', { warnings: ['w'] }))).toBe('1 warning');
    const many = roleItem('a', {
      warnings: ['w'], problems: [{ path: 'p', message: 'm' }],
      usage: usageOf({ problems: [{ source: 'x', path: '', message: 'm' }] }),
      instructions: { state: 'missing', path: null, text: null, sha256: null, bytes: null },
      skills: [{ id: 's', state: 'missing' }],
    });
    expect(roleIssueSummary(many)).toBe('3 warnings');
  });

  it('labels_duplicate_member_names_without_deduplicating_or_inventing_state', () => {
    const labels = assignedMemberLabels(roleItem('a', { usage: usageOf({}, MEMBERS) }));
    expect(labels.map(l => l.key)).toEqual(['core:dev-1', 'core:dev-2', 'ops:dev-3', '3:3']);
    expect(labels.map(l => [l.team, l.member])).toEqual([['Core', 'Dev'], ['Core', 'Dev'], ['Ops', 'Dev'], ['Unknown team', 'Unnamed member']]);
    expect(labels.map(l => l.states)).toEqual([['Saved', 'Live'], ['Saved'], ['Live'], ['Saved']]);
    expect(labels[0].runtime).toBe('available, assignment running');
    expect(labels[1].runtime).toBeNull();
    expect(labels.map(l => l.memberId)).toEqual(['dev-1', 'dev-2', 'dev-3', null]);
    const idOnly = assignedMemberLabels(roleItem('a', { usage: usageOf({}, [{ teamDefId: 't', teamName: null, memberId: 'm', memberName: null, saved: true, live: null }]) }));
    expect([idOnly[0].team, idOnly[0].member]).toEqual(['t', 'm']);
  });

  it('summarises_members_running_assignments_and_incomplete_usage_truthfully', () => {
    const used = roleItem('a', { usage: usageOf({}, MEMBERS) });
    expect(roleRunningAssignments(used)).toBe(1);
    expect(roleUsageSummary(used)).toEqual({ members: '4 members', running: '1 running', incomplete: false });

    const active = roleItem('a', { usage: usageOf({}, [
      { teamDefId: 't', teamName: 'T', memberId: 'm1', memberName: 'M', saved: true, live: null },
      { teamDefId: 't', teamName: 'T', memberId: 'm2', memberName: 'M', saved: null, live: { assignment: { id: 'x', status: 'queued' } } },
    ]) });
    expect(roleRunningAssignments(active)).toBe(1);
    expect(roleUsageSummary(active)).toEqual({ members: '2 members', running: '1 running', incomplete: false });

    // The backend may put the assignment on the member or inside its live record; finished statuses do not count.
    const direct = roleItem('a', { usage: usageOf({}, [
      { teamDefId: 't', teamName: 'T', memberId: 'm1', memberName: 'M', saved: true, live: false, assignment: { id: 'y', status: 'waiting_input' } },
      { teamDefId: 't', teamName: 'T', memberId: 'm2', memberName: 'M', saved: true, live: false, assignmentStatus: 'reconciling' },
      { teamDefId: 't', teamName: 'T', memberId: 'm3', memberName: 'M', saved: true, live: false, assignmentStatus: 'done' },
    ]) });
    expect(roleRunningAssignments(direct)).toBe(2);

    expect(roleUsageSummary(roleItem('a'))).toEqual({ members: 'Unused', running: 'No running assignments', incomplete: false });

    const partial = roleItem('a', { usage: usageOf({ partial: true, liveRuntime: { state: 'unavailable', error: null } }) });
    expect(roleUsageSummary(partial)).toEqual({ members: 'Usage incomplete', running: null, incomplete: true });
    const disconnected = roleItem('a', { usage: usageOf({ liveRuntime: { state: 'disconnected', error: null } }, MEMBERS.slice(0, 1)) });
    expect(roleUsageSummary(disconnected)).toEqual({ members: '1 member', running: 'Usage incomplete', incomplete: true });
  });

  it('treats_an_unknown_runtime_state_as_incomplete_usage', () => {
    const unknown = roleItem('a', { usage: usageOf({ liveRuntime: { state: 'booting', error: null } }, MEMBERS.slice(0, 1)) });
    expect(roleRuntimeState(unknown)).toBe('unknown');
    expect(roleUsageSummary(unknown)).toEqual({ members: '1 member', running: 'Usage incomplete', incomplete: true });
    const noRuntime = roleItem('a', { usage: usageOf({ liveRuntime: null }, MEMBERS.slice(0, 1)) });
    expect(roleRuntimeState(noRuntime)).toBe('unknown');
    expect(roleUsageSummary(noRuntime)).toEqual({ members: '1 member', running: 'Usage incomplete', incomplete: true });
  });

  it('requested_role_selection_is_exact_id_only', () => {
    const items = [roleItem('qa-a', { name: 'QA' }), roleItem('qa-b', { name: 'QA' })];
    expect(requestedRoleSelection(items, 'qa-b')).toBe('qa-b');
    expect(requestedRoleSelection(items, 'QA')).toBe('qa-a');
    expect(requestedRoleSelection(items, 'retired')).toBe('qa-a');
    expect(requestedRoleSelection(items, null)).toBe('qa-a');
    expect(requestedRoleSelection([], 'qa-b')).toBeNull();
  });
});
