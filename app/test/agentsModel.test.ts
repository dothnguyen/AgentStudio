import { describe, expect, it } from 'vitest';
import { agentFilterOptions, agentUsage, catalogRows, filterAgentRows, selectedAgentKey } from '../src/renderer/agents/agentsModel';
import { catalogFixture, member, overviewFixture, team } from './teamsFixtures';

const agents = catalogFixture().agents;
const rows = catalogRows([...agents, { id: '', name: ' ', provider: ' ', reasoning: ' ' }, { ...agents[0]!, reasoning: 'high' }]);
describe('agents model', () => {
  it('searches_name_id_and_description_case_insensitively_in_catalog_order', () => {
    expect(filterAgentRows(rows, ' SONNET ', '', '').map(r => r.catalogIndex)).toEqual([0, 4]);
    expect(filterAgentRows(rows, 'TICKETS', '', '')).toHaveLength(2);
    expect(filterAgentRows(rows, 'codex-gpt', '', '')[0]?.catalogIndex).toBe(1);
  });
  it('combines_exact_provider_and_reasoning_filters_and_clearing_restores_all_rows', () => {
    expect(filterAgentRows(rows, '', 'opencode', 'high').map(r => r.catalogIndex)).toEqual([4]);
    expect(filterAgentRows(rows, '', 'OpenCode', '').length).toBe(0);
    expect(filterAgentRows(rows, '', '', '')).toEqual(rows);
  });
  it('derives_filter_values_from_non_empty_catalog_values_in_first_seen_order', () => {
    expect(agentFilterOptions(rows)).toEqual({ providers: ['opencode', 'codex', 'claude'], reasoningLevels: ['high'] });
  });
  it('selection_stays_visible_then_falls_back_to_first_or_null', () => {
    expect(selectedAgentKey(rows, 'catalog:1')).toBe('catalog:1');
    expect(selectedAgentKey(rows.slice(2), 'catalog:1')).toBe('catalog:2');
    expect(selectedAgentKey([], null)).toBeNull();
  });
  it('usage_counts_every_saved_option_once_per_member_and_ignores_active_agent', () => {
    const original = member(); const option = { ...original.agentOptions[0]!, id: 'target' };
    const m = member({ agentOptions: [original.agentOptions[0]!, option, option], runtime: { agentId: 'x', configuredAgents: null, activeAgent: 'live', quotaHolds: {}, pendingAgent: null, lastSwitch: null, assignment: null, availability: '', paneState: null, provider: null, model: null, reasoning: null, stale: false } });
    const data = overviewFixture([team({ members: [m, m] })]);
    expect(agentUsage(data, 'target')).toMatchObject({ memberCount: 2, teamCount: 1, summary: 'Used by 2 members in 1 team' });
    expect(agentUsage(data, 'live').summary).toBe('Not used by any saved team member');
  });
  it('usage_distinguishes_complete_zero_unavailable_and_top_level_truncation', () => {
    expect(agentUsage(null, 'x').summary).toBe('Usage unavailable');
    expect(agentUsage(overviewFixture([]), ' ').state).toBe('unavailable');
    expect(agentUsage(overviewFixture([]), 'x').summary).toBe('Not used by any saved team member');
    expect(agentUsage(overviewFixture([], { truncated: true }), 'x').summary).toBe('Usage incomplete — no saved references are visible in the loaded teams.');
  });
  it('usage_marks_member_truncation_and_uses_missing_label_fallbacks', () => {
    const data = overviewFixture([team({ id: null, name: ' ', membersTruncated: true, members: [member({ memberId: null, name: ' ', role: ' ' })] })]);
    expect(agentUsage(data, 'opencode-sonnet')).toMatchObject({ state: 'truncated', summary: 'Used by at least 1 member in at least 1 team', references: [{ teamLabel: 'Unnamed team', memberLabel: 'Unnamed member', role: null }] });
  });
});

describe('catalog edge cases', () => {
  it('searches only name, id and description, not provider, model or reasoning', () => {
    const input = catalogRows([{ id: 'identifier', name: 'Name', description: 'Description', provider: 'provider-only', model: 'model-only', reasoning: 'reasoning-only' }]);
    for (const query of ['provider-only', 'model-only', 'reasoning-only']) {
      expect(filterAgentRows(input, query, '', '')).toEqual([]);
    }
    expect(filterAgentRows(input, 'description', '', '')).toEqual(input);
  });

  it('uses only saved options even when other member fields identify the agent', () => {
    const data = overviewFixture([team({ members: [member({
      agentOptions: [], agentDefId: 'target', defaultAgent: 'target', provider: 'target', model: 'target', reasoning: 'target',
    })] })]);
    expect(agentUsage(data, 'target')).toEqual({
      state: 'complete', memberCount: 0, teamCount: 0, references: [], summary: 'Not used by any saved team member',
    });
  });

  it('marks visible references as lower bounds when the overview is truncated', () => {
    const data = overviewFixture([team()], { truncated: true });
    expect(agentUsage(data, 'opencode-sonnet')).toMatchObject({
      state: 'truncated', memberCount: 1, teamCount: 1,
      summary: 'Used by at least 1 member in at least 1 team',
    });
  });

  it('ignores whitespace-only search fields and matches reasoning case sensitively', () => {
    const input = catalogRows([{ id: ' ', name: ' ', description: ' ', provider: 'p', reasoning: 'High' }]);
    expect(filterAgentRows(input, 'anything', '', '')).toEqual([]);
    expect(filterAgentRows(input, ' ', '', '')).toEqual(input);
    expect(filterAgentRows(input, '', 'p', 'high')).toEqual([]);
    expect(filterAgentRows(input, '', 'p', 'High')).toEqual(input);
  });

  it('keeps duplicate and blank ids independently selectable without mutating rows', () => {
    const input = [{ id: '', name: 'First', provider: 'p' }, { id: '', name: 'Second', provider: 'p' }, { id: 'same', name: 'Third', provider: 'q' }, { id: 'same', name: 'Fourth', provider: 'q' }];
    const original = structuredClone(input);
    const result = catalogRows(input);
    expect(result.map(row => row.key)).toEqual(['catalog:0', 'catalog:1', 'catalog:2', 'catalog:3']);
    expect(filterAgentRows(result, 'second', 'p', '').map(row => row.key)).toEqual(['catalog:1']);
    expect(selectedAgentKey(result, 'catalog:3')).toBe('catalog:3');
    expect(input).toEqual(original);
    expect(result.map(row => row.agent.name)).toEqual(['First', 'Second', 'Third', 'Fourth']);
  });

  it('preserves reference order and uses each label fallback and exact unavailable shape', () => {
    const option = { ...member().agentOptions[0]!, id: 'target' };
    const data = overviewFixture([
      team({ id: 'team-id', name: ' ', members: [member({ name: ' ', memberId: 'member-id', role: ' ', agentOptions: [option] })] }),
      team({ id: null, name: '', runtime: { state: 'running', teamId: 'runtime-id', status: 'running' }, members: [member({ name: 'Same', memberId: 'a', agentOptions: [option] }), member({ name: 'Same', memberId: 'b', agentOptions: [option] })] }),
    ]);
    expect(agentUsage(data, 'target')).toEqual({ state: 'complete', memberCount: 3, teamCount: 2, summary: 'Used by 3 members in 2 teams', references: [
      { teamId: 'team-id', teamLabel: 'team-id', memberId: 'member-id', memberLabel: 'member-id', role: null },
      { teamId: null, teamLabel: 'runtime-id', memberId: 'a', memberLabel: 'Same', role: 'Developer' },
      { teamId: null, teamLabel: 'runtime-id', memberId: 'b', memberLabel: 'Same', role: 'Developer' },
    ] });
    expect(agentUsage(data, '')).toEqual({ state: 'unavailable', memberCount: null, teamCount: null, references: [], summary: 'Usage unavailable' });
    expect(agentUsage(overviewFixture([team({ membersTruncated: true, members: [] })]), 'target').summary).toBe('Usage incomplete — no saved references are visible in the loaded teams.');
  });
});
