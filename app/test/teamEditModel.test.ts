import { describe, expect, it } from 'vitest';
import {
  emptyMemberForm, addMemberInput, addAgentOption, removeAgentOption, moveAgentOption, validateAgentOptions, memberFormInitial,
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
  it('ordered_add_remove_reorder_default', () => {
    const original = ['primary', 'backup'];
    const added = addAgentOption(original, 'third');
    const moved = moveAgentOption(added, 2, -1);
    const reordered = moveAgentOption(moved, 0, 1);
    const removed = removeAgentOption(reordered, 2);
    expect(added).toEqual(['primary', 'backup', 'third']);
    expect(moved).toEqual(['primary', 'third', 'backup']);
    expect(reordered).toEqual(['third', 'primary', 'backup']);
    expect(removed).toEqual(['third', 'primary']);
    expect(original).toEqual(['primary', 'backup']);
    expect(memberChanges({name: 'a', role: 'r', agents: original, useCatalogAgents: true}, {name: 'a', role: 'r', agents: removed, useCatalogAgents: true})).toEqual({agents: ['third', 'primary']});
  });
  it('option_helpers_handle_boundaries_without_mutation', () => {
    const original = Object.freeze(['a', 'b']);
    for (const result of [addAgentOption(original, ''), addAgentOption(original, '  '), addAgentOption(original, 'a'),
      removeAgentOption(original, -1), removeAgentOption(original, 2),
      moveAgentOption(original, -1, 1), moveAgentOption(original, 0, -1), moveAgentOption(original, 1, 1)]) {
      expect(result).toEqual(['a', 'b']);
      expect(result).not.toBe(original);
    }
    expect(original).toEqual(['a', 'b']);
  });
  it('initial_values_and_conversion_are_explicit', () => {
    expect(emptyMemberForm()).toEqual({name: '', role: '', agents: [], useCatalogAgents: true});
    expect(memberFormInitial(member({agentOptions: [], defaultAgent: 'fallback'})).agents).toEqual(['fallback']);
    const inline = memberFormInitial(member({agentMode: 'inline'}));
    expect(inline.agents).toEqual([]);
    expect(validateMemberForm(inline, 'edit', new Set())).toEqual({});
    expect(validateMemberForm({...inline, useCatalogAgents: true}, 'edit', new Set()).agents).toBe('Choose at least one agent.');
    expect(memberChanges(inline, {...inline, useCatalogAgents: true, agents: ['a']})).toEqual({agents: ['a']});
    expect(memberChanges(inline, {...inline})).toBeNull();
    const input = addMemberInput({name: ' Name ', role: ' QA ', agents: ['a'], useCatalogAgents: true});
    expect(input).toEqual({name: 'Name', role: 'QA', agents: ['a']});
  });
  it('duplicate_and_missing_options_block_save', () => {
    const missing = new Set(['missing']);
    expect(validateAgentOptions([], missing)).toBe('Choose at least one agent.');
    expect(validateAgentOptions(['missing', 'missing'], missing)).toBe('Each agent can appear only once.');
    expect(validateAgentOptions(['missing'], missing)).toBe('Remove or replace missing catalog agents before saving.');
    expect(validateAgentOptions(['a', 'b'], missing)).toBeNull();
  });
  it('single_catalog_is_not_silently_rewritten', () => {
    const initial = memberFormInitial(member());
    expect(memberChanges(initial, {...initial, role: 'QA'})).toEqual({role: 'QA'});
  });
  it('inline_member_preserves_provider_fields', () => {
    const initial = memberFormInitial(member({agentMode: 'inline', provider: 'p', model: 'm', reasoning: 'r'}));
    expect(memberChanges(initial, {...initial, name: 'new', role: 'QA'})).toEqual({name: 'new', role: 'QA'});
  });
  it('preserves_role_identity_and_can_add_tickets', () => {
    const initial = memberFormInitial(member({agentMode: 'ordered_catalog'}));
    expect(memberChanges(initial, {...initial, agents: ['other']})).toEqual({agents: ['other']});
  });
  it('add_and_validate_member', () => {
    const draft = { name: ' ', role: ' QA ', agents: ['a'], useCatalogAgents: true };
    expect(addMemberInput(draft)).toEqual({role: 'QA', agents: ['a']});
    expect(validateMemberForm({...draft, agents: [], role: ''}, 'add', new Set())).toEqual({agents: 'Choose at least one agent.', role: 'Enter a role.'});
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
    expect(nextStartSuffix(true)).toBe(' Saved configuration applies on the next team start; the running member is unchanged.');
    expect(nextStartSuffix(false)).toBe('');
    expect(nextStartSuffix(undefined)).toBe('');
    expect(problemsSuffix([])).toBe('');
    expect(problemsSuffix([{ path: 'a', message: 'b' }])).toBe(' The team still has 1 problem; see the team details.');
  });
});
