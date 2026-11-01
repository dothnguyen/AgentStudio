import { expect, it } from 'vitest';
import {
  escalationChains,
  memberForRole,
  protectedState,
  roleCoverage,
  roleMember,
  roleRef,
  rolesUsedByRules,
  runningTeams,
  statusLabel,
  statusName,
  statusTone,
  workflowErrorText,
  workflowLabel,
  workspaceLabel,
} from '../src/renderer/teams/routingViewModel';
import { escalationSettingsFixture, member, overviewFixture, routingSettingsFixture, team } from './teamsFixtures';
import { roleItem } from './rolesFixtures';

it('statusLabel_uses_name_id_and_unknown', () => {
  const statuses = ['a', 'b', 'c'].map((id, i) => ({ id, name: ['Alpha', 'b', null][i], kind: null }));
  expect(['a', 'b', 'c', 'zzz'].map(id => statusLabel(statuses, id))).toEqual(['Alpha (a)', 'b', 'c', 'zzz (unknown status)']);
});
it('roleRef_states', () => {
  expect(roleRef(null, null)).toEqual({ kind: 'none' });
  expect(roleRef('a', null)).toEqual({ kind: 'catalog-unavailable', id: 'a' });
  expect(roleRef('a', [roleItem('a', { name: '  ' })])).toEqual({ kind: 'catalog', id: 'a', label: 'a' });
  expect(roleRef('QA', [roleItem('QA', { name: 'Quality' })])).toEqual({ kind: 'catalog', id: 'QA', label: 'Quality' });
  expect(roleRef('a', [])).toEqual({ kind: 'missing', id: 'a' });
});
it('workflowLabel_states', () => {
  const workflows = [{ name: 'x', builtin: false, roles: [], errors: ['bad'] }];
  expect(workflowLabel(workflows, null)).toBe('—'); expect(workflowLabel([], 'x')).toBe('x — not found');
  expect(workflowLabel(workflows, 'x')).toBe('x — unavailable'); expect(workflowLabel([{ ...workflows[0], errors: [] }], 'x')).toBe('x');
  expect(workflowErrorText({ message: 'bad' })).toBe('bad'); expect(workflowErrorText(42)).toBe('42');
});
it('workspaceLabel_values', () => expect([null, '', 'main', 'worktree', 'none', 'custom', 'constructor', 'toString', '__proto__'].map(workspaceLabel)).toEqual(['Not set', 'Not set', 'Main workspace', 'Isolated worktree', 'No workspace', 'custom', 'constructor', 'toString', '__proto__']));
it('protectedState_uses_returned_routes', () => {
  const s = { protectedRoutes: [{ status: 'a', role: 'r', satisfied: true }, { status: 'b', role: 'r', satisfied: false }] };
  expect(['a', 'b', 'c'].map(id => protectedState(s, id))).toEqual(['protected', 'needs-repair', null]);
});
it('escalationChains_follow_returned_ids', () => {
  const s = escalationSettingsFixture();
  expect(escalationChains(s).map(c => [c.count, c.target, c.handlers[0].role])).toEqual([[3, 'need-escalate', 'SeniorDeveloper'], [3, 'need-escalate', 'SeniorDeveloper']]);
  s.rules = s.rules.map(r => ({ ...r, status: r.status === 'need-escalate' ? 'triage' : r.status, role: r.role === 'SeniorDeveloper' ? 'Expert' : r.role, onFailureLimit: r.onFailureLimit && { ...r.onFailureLimit, status: 'triage' } }));
  expect(escalationChains(s).map(c => [c.target, c.handlers[0].role])).toEqual([['triage', 'Expert'], ['triage', 'Expert']]);
  s.rules = s.rules.filter(r => r.status !== 'triage');
  expect(escalationChains(s)[0].handlers).toEqual([]);
});
it('statusName_and_tone_map_the_design_colours', () => {
  const statuses = [
    { id: 'backlog', name: 'Backlog', kind: 'initial' },
    { id: 'ready', name: 'Ready', kind: null },
    { id: 'need-escalate', name: 'Needs escalation', kind: null },
    { id: 'merge-conflict', name: 'Merge conflict', kind: null },
    { id: 'done', name: 'Done', kind: 'done' },
    { id: 'custom', name: null, kind: null },
  ];
  expect(['backlog', 'ready', 'need-escalate', 'merge-conflict', 'done', 'custom', 'zzz'].map(id => statusName(statuses, id))).toEqual(['Backlog', 'Ready', 'Needs escalation', 'Merge conflict', 'Done', 'custom', 'zzz (unknown status)']);
  expect(['backlog', 'ready', 'need-escalate', 'merge-conflict', 'done', 'custom', 'closed'].map(id => statusTone(statuses, id))).toEqual(['grey', 'blue', 'amber', 'red', 'green', 'neutral', 'grey']);
});
it('runningTeams_and_memberForRole_use_only_running_teams', () => {
  const stopped = team({ id: 'stopped', runtime: { state: 'stopped', teamId: 'old', status: 'stopped' }, members: [member({ memberId: 'old', role: 'Developer' })] });
  const running = team({ id: 'running', runtime: { state: 'running', teamId: 'live', status: 'running' }, members: [member({ memberId: 'dev', role: 'Developer' })] });
  const overview = overviewFixture([stopped, running]);
  expect(runningTeams(overview).map(t => t.id)).toEqual(['running']);
  expect(memberForRole(overview, 'Developer')?.memberId).toBe('dev');
  expect(memberForRole(overview, 'QA')).toBeNull();
  expect(memberForRole(null, 'Developer')).toBeNull();
  const stale = team({ id: 'stale', runtime: { state: 'stopped', teamId: 'old', status: 'running' }, members: [member({ memberId: 'stale-dev', role: 'Developer' })] });
  expect(runningTeams(overviewFixture([stale])).map(t => t.id)).toEqual([]);
});
it('roleMember_reports_a_truncated_member_list_as_unknown', () => {
  const truncated = overviewFixture([team({
    runtime: { state: 'running', teamId: 'live', status: 'running' },
    members: [member({ memberId: 'dev', role: 'Developer' })],
    membersTruncated: true,
  })]);
  expect(roleMember(truncated, 'Developer')).toMatchObject({ member: { memberId: 'dev' }, known: true });
  expect(roleMember(truncated, 'TeamLead')).toEqual({ member: null, known: false });
  expect(roleMember(truncated, null)).toEqual({ member: null, known: true });
  const complete = overviewFixture([team({ runtime: { state: 'running', teamId: 'live', status: 'running' }, members: [] })]);
  expect(roleMember(complete, 'TeamLead')).toEqual({ member: null, known: true });
  expect(roleMember(overviewFixture([], { runtimeState: { available: false, error: { code: 'RUNTIME_DOWN', message: 'down' } } }), 'Developer'))
    .toEqual({ member: null, known: false });
});
it('roleCoverage_counts_distinct_rule_roles_and_reports_gaps', () => {
  const settings = routingSettingsFixture();
  settings.rules = [
    ...settings.rules,
    { ...settings.rules[0]!, index: 20, status: 'dev-ready', role: 'Developer' },
    { ...settings.rules[0]!, index: 21, status: 'merge-ready', role: 'QA' },
  ];
  const overview = overviewFixture([team({ runtime: { state: 'running', teamId: 'live', status: 'running' }, members: [member({ memberId: 'dev', role: 'Developer' })] })]);
  expect(rolesUsedByRules(settings)).toEqual(['Developer', 'TeamLead', 'QA']);
  expect(roleCoverage(settings, overview, [roleItem('QA', { name: 'Quality' })])).toEqual({
    total: 3,
    filled: 1,
    gaps: [
      { role: 'TeamLead', label: 'TeamLead', statuses: ['merge-conflict', 'plan-merge-conflict'] },
      { role: 'QA', label: 'Quality', statuses: ['merge-ready'] },
    ],
    running: true,
    known: true,
    truncated: false,
  });
});
it('roleCoverage_never_claims_a_gap_without_a_running_team_or_known_teams', () => {
  const settings = routingSettingsFixture();
  const noTeams = overviewFixture([team({ runtime: { state: 'stopped', teamId: 'old', status: 'stopped' } })]);
  expect(roleCoverage(settings, noTeams, null)).toMatchObject({ running: false, known: true, gaps: [] });
  expect(roleCoverage(settings, null, null)).toMatchObject({ running: false, known: false, gaps: [] });
  const runtimeDown = overviewFixture([team({ runtime: { state: 'running', teamId: 'live', status: 'running' } })], {
    runtimeState: { available: false, error: { code: 'RUNTIME_DOWN', message: 'down' } },
  });
  expect(roleCoverage(settings, runtimeDown, null)).toMatchObject({ running: false, known: false, gaps: [] });
});
it('roleCoverage_never_claims_a_gap_when_a_running_team_is_truncated', () => {
  const settings = routingSettingsFixture();
  const overview = overviewFixture([team({
    runtime: { state: 'running', teamId: 'live', status: 'running' },
    members: [member({ memberId: 'dev', role: 'Developer' })],
    membersTruncated: true,
  })]);
  expect(roleCoverage(settings, overview, null)).toEqual({
    total: 2,
    filled: 1,
    gaps: [],
    running: true,
    known: true,
    truncated: true,
  });
});
it('roleCoverage_and_memberForRole_combine_every_running_team_and_ignore_stopped_ones', () => {
  const settings = routingSettingsFixture();
  const overview = overviewFixture([
    team({ id: 'stopped', runtime: { state: 'stopped', teamId: 'old', status: 'stopped' }, members: [member({ memberId: 'old-lead', role: 'TeamLead' })] }),
    team({ id: 'one', runtime: { state: 'running', teamId: 'live-1', status: 'running' }, members: [member({ memberId: 'dev', role: 'Developer' })] }),
    team({ id: 'two', runtime: { state: 'running', teamId: 'live-2', status: 'running' }, members: [member({ memberId: 'lead', role: 'TeamLead' })] }),
  ]);
  expect(memberForRole(overview, 'Developer')?.memberId).toBe('dev');
  expect(memberForRole(overview, 'TeamLead')?.memberId).toBe('lead');
  expect(roleCoverage(settings, overview, null)).toMatchObject({ total: 2, filled: 2, gaps: [], running: true, known: true });
});
it('roleCoverage_gap_labels_use_the_catalog_name_or_the_stable_role_id', () => {
  const settings = routingSettingsFixture();
  const overview = overviewFixture([team({ runtime: { state: 'running', teamId: 'live', status: 'running' }, members: [member({ memberId: 'dev', role: 'Developer' })] })]);
  expect(roleCoverage(settings, overview, [roleItem('TeamLead', { name: 'Tech lead' })])).toEqual({
    total: 2,
    filled: 1,
    gaps: [{ role: 'TeamLead', label: 'Tech lead', statuses: ['merge-conflict', 'plan-merge-conflict'] }],
    running: true,
    known: true,
    truncated: false,
  });
  expect(roleCoverage(settings, overview, null).gaps).toEqual([
    { role: 'TeamLead', label: 'TeamLead', statuses: ['merge-conflict', 'plan-merge-conflict'] },
  ]);
});
it('statusTone_honours_the_status_kind_before_id_guesses', () => {
  const statuses = [
    { id: 'somewhere', name: null, kind: 'initial' },
    { id: 'done-ish', name: null, kind: 'done' },
    { id: 'archived', name: null, kind: 'closed' },
  ];
  expect(['somewhere', 'done-ish', 'archived'].map(id => statusTone(statuses, id))).toEqual(['grey', 'green', 'grey']);
  expect(['backlog', 'closed', 'some-ready', 'needs-escalation', 'merge-conflict', 'custom'].map(id => statusTone(statuses, id)))
    .toEqual(['grey', 'grey', 'blue', 'amber', 'red', 'neutral']);
});
