import { expect, it } from 'vitest';
import { escalationChains, protectedState, roleRef, statusLabel, workflowErrorText, workflowLabel, workspaceLabel } from '../src/renderer/teams/routingViewModel';
import { escalationSettingsFixture } from './teamsFixtures';
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
