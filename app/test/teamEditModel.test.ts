import { describe, expect, it } from 'vitest';
import {
  addMemberInput,
  canEditMember,
  canEditTeam,
  errorFeedback,
  knownRoles,
  memberChanges,
  nextStartSuffix,
  problemsSuffix,
  validateMemberForm,
} from '../src/renderer/teams/teamEditModel';
import { member, team, twoTeams } from './teamsFixtures';

describe('teamEditModel', () => {
  it('member_changes_only_changed_fields', () => {
    const initial = { name: 'dev', role: 'Developer', agent: 'opencode-sonnet' };
    expect(memberChanges(initial, { name: ' dev ', role: 'Reviewer', agent: 'opencode-sonnet' })).toEqual({ role: 'Reviewer' });
    expect(memberChanges(initial, { ...initial })).toBeNull();
    const inline = memberChanges({ name: 'lead', role: 'TeamLead', agent: '' }, { name: 'lead', role: 'QA', agent: '' });
    expect(inline).toEqual({ role: 'QA' });
    expect(inline).not.toHaveProperty('agent');
  });

  it('add_member_input_omits_blank_name', () => {
    expect(addMemberInput({ name: '  ', role: ' QA ', agent: 'codex-gpt' })).toEqual({ role: 'QA', agent: 'codex-gpt' });
    expect(addMemberInput({ name: 'Quinn', role: 'QA', agent: 'codex-gpt' })).toEqual({ name: 'Quinn', role: 'QA', agent: 'codex-gpt' });
  });

  it('validate_member_form_messages', () => {
    expect(validateMemberForm({ name: '', role: '', agent: '' }, 'add')).toEqual({ agent: 'Choose an agent.', role: 'Enter a role.' });
    expect(validateMemberForm({ name: '', role: '', agent: '' }, 'edit')).toEqual({ name: 'Enter a name.', role: 'Enter a role.' });
  });

  it('error_feedback_lists_problems_and_hint', () => {
    const invalid = errorFeedback('t', {
      code: 'TEAM_CONFIG_INVALID', message: 'm', retryable: false,
      data: { problems: [{ path: 'members[2].role', message: "role 'Ghost' is not defined in .agent-studio/roles.json" }, { bad: 1 }] },
    });
    expect(invalid).toMatchObject({
      problems: ["members[2].role: role 'Ghost' is not defined in .agent-studio/roles.json"],
      hint: null,
    });
    const running = errorFeedback('t', { code: 'TEAM_ALREADY_RUNNING', message: 'm', retryable: false });
    expect(running).toMatchObject({ hint: 'Stop the team before deleting it or removing members.' });
    expect(errorFeedback('t', { code: 'X', message: 'm', retryable: false, data: 'x' })).toMatchObject({ problems: [] });
  });

  it('editability_rules', () => {
    expect(canEditTeam(team({ id: null }))).toBe(false);
    expect(canEditTeam(team({ definition: { state: 'missing', problems: [] } }))).toBe(false);
    expect(canEditTeam(team({ definition: { state: 'unreadable', problems: [] } }))).toBe(false);
    expect(canEditTeam(team())).toBe(true);
    expect(canEditTeam(team({ definition: { state: 'problems', problems: [] } }))).toBe(true);
    expect(canEditMember(team(), member({ source: 'runtime' }))).toBe(false);
    expect(canEditMember(team(), member({ memberId: null }))).toBe(false);
    expect(canEditMember(team(), member())).toBe(true);
  });

  it('known_roles_unique_sorted', () => {
    expect(knownRoles(twoTeams())).toEqual(['Developer', 'QA', 'TeamLead']);
    expect(knownRoles(null)).toEqual([]);
  });

  it('suffixes', () => {
    expect(nextStartSuffix(true)).toBe(' Changes apply the next time the team starts.');
    expect(nextStartSuffix(false)).toBe('');
    expect(nextStartSuffix(undefined)).toBe('');
    expect(problemsSuffix([])).toBe('');
    expect(problemsSuffix([{ path: 'a', message: 'b' }])).toBe(' The team still has 1 problem; see the team details.');
  });
});
