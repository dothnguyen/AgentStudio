import { describe, expect, it } from 'vitest';
import {
  emptyMemberForm, addMemberInput, addAgentOption, removeAgentOption, moveAgentOption, validateAgentOptions, memberFormInitial,
  canEditMember,
  canEditTeam,
  errorFeedback,
  findCatalogRole,
  memberRoleChoices,
  roleChoiceLabel,
  memberChanges, ticketPermissionText,
  nextStartSuffix,
  problemsSuffix,
  validateMemberForm,
} from '../src/renderer/teams/teamEditModel';
import { member, team } from './teamsFixtures';

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

  const dup = [{ id: 'qa-a', name: 'QA' }, { id: 'qa-b', name: 'QA' }];
  it('role_choices_keep_backend_order_and_stable_ids', () => {
    const choices = memberRoleChoices(dup, 'qa-b');
    expect(choices.map((c) => c.label)).toEqual(['QA (qa-a)', 'QA (qa-b)']);
    expect(choices.map((c) => c.id)).toEqual(['qa-a', 'qa-b']);
    expect(roleChoiceLabel({ id: 'Dev', name: 'Dev' })).toBe('Dev');
  });
  it('missing_current_role_is_preserved_for_repair', () => {
    const choices = memberRoleChoices(dup, 'retired');
    expect(choices[0]).toEqual({ id: 'retired', label: 'retired — missing from role catalog', state: 'missing' });
    expect(choices).toHaveLength(3);
    expect(memberRoleChoices(dup, '')).toHaveLength(2);
  });
  it('find_catalog_role_matches_exact_id_only', () => {
    const items = [{ id: 'qa-a', name: 'QA' }] as never[];
    expect(findCatalogRole(items, 'qa-a')).not.toBeNull();
    expect(findCatalogRole(items, 'QA')).toBeNull();
    expect(findCatalogRole(items, 'QA-A')).toBeNull();
    expect(findCatalogRole(items, null)).toBeNull();
  });
  it('role_only_change_has_no_member_agent_or_runtime_fields', () => {
    const initial = { name: 'dev', role: 'qa-a', agents: ['a'], useCatalogAgents: true };
    const changes = memberChanges(initial, { ...initial, role: 'qa-b' });
    expect(changes).toEqual({ role: 'qa-b' });
    expect(Object.keys(changes ?? {})).toEqual(['role']);
  });

  it('suffixes', () => {
    expect(nextStartSuffix(true)).toBe(' Saved configuration applies on the next team start; the running member is unchanged.');
    expect(nextStartSuffix(false)).toBe('');
    expect(nextStartSuffix(undefined)).toBe('');
    expect(problemsSuffix([])).toBe('');
    expect(problemsSuffix([{ path: 'a', message: 'b' }])).toBe(' The team still has 1 problem; see the team details.');
  });
});

describe('ticket permission', () => {
  it('preserves known values and omits unknown values', () => {
    expect(memberFormInitial(member(), true).canAddTickets).toBe(true);
    expect(memberFormInitial(member(), null)).not.toHaveProperty('canAddTickets');
    expect(memberFormInitial(member())).not.toHaveProperty('canAddTickets');
    const base = memberFormInitial(member(), false);
    expect(memberChanges(base, {...base, canAddTickets: true})).toEqual({canAddTickets: true});
    expect(memberChanges({...base, canAddTickets: true}, base)).toEqual({canAddTickets: false});
    expect(memberChanges(memberFormInitial(member()), memberFormInitial(member()))).toBeNull();
  });
  it('sends add permission only when enabled', () => {
    const v = {...emptyMemberForm(), role: 'QA', agents: ['a']};
    expect(addMemberInput({...v, canAddTickets: true})).toEqual({role: 'QA', agents: ['a'], canAddTickets: true});
    expect(addMemberInput({...v, canAddTickets: false})).toEqual({role: 'QA', agents: ['a']});
  });
  it('describes all permission states', () => {
    expect(ticketPermissionText({state: 'loading'})).toBe('Checking ticket permission…');
    expect(ticketPermissionText({state: 'ready', canAddTickets: true})).toBe('Can add tickets: Yes');
    expect(ticketPermissionText({state: 'ready', canAddTickets: false})).toBe('Can add tickets: No');
    expect(ticketPermissionText({state: 'ready', canAddTickets: null})).toBe('Can add tickets: Not available for this member');
    expect(ticketPermissionText({state: 'error', error: {code: 'INTERNAL', message: 'oops', retryable: false}})).toBe('Ticket permission could not be loaded (INTERNAL: oops).');
  });
});
