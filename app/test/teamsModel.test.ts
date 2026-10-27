import { describe, expect, it } from 'vitest';
import {
  agentUsage,
  orderTeams,
  overviewNotices,
  presenceLabel,
  providerModelText,
  teamKey,
  teamLabel,
  workText,
} from '../src/renderer/teams/teamsModel';
import type { OverviewRuntimeState } from '../src/renderer/api';
import { overviewFixture, team, twoTeams } from './teamsFixtures';

function withState(id: string, state: OverviewRuntimeState) {
  return { team: team({ id, runtime: { state, teamId: null, status: null } }) };
}

describe('teamsModel', () => {
  it('orders_live_teams_first_and_keeps_backend_order', () => {
    const items = [withState('A', 'stopped'), withState('B', 'running'), withState('C', 'not_started'), withState('D', 'starting')];
    expect(orderTeams(items).map((i) => i.team.id)).toEqual(['B', 'D', 'A', 'C']);
  });

  it('team_key_and_label_fall_back', () => {
    const byRuntime = team({ id: null, name: null, runtime: { state: 'running', teamId: 't-9', status: null } });
    expect(teamLabel(byRuntime)).toBe('t-9');
    expect(teamKey(byRuntime, 0)).toBe('runtime:t-9');
    const none = team({ id: null, name: null });
    expect(teamLabel(none)).toBe('Unnamed team');
    expect(teamKey(none, 3)).toBe('index:3');
    expect(teamLabel(team({ id: 'ghost', name: null }))).toBe('ghost');
  });

  it('presence_label_maps_known_and_passes_unknown', () => {
    expect(presenceLabel('busy')).toBe('Working');
    expect(presenceLabel('idle')).toBe('Available');
    expect(presenceLabel('not_in_runtime')).toBe('Not in runtime');
    expect(presenceLabel('weird_new_state')).toBe('weird_new_state');
    expect(presenceLabel('constructor')).toBe('constructor');
  });

  it('provider_model_text_cases', () => {
    expect(providerModelText('opencode', 'claude-sonnet')).toBe('opencode · claude-sonnet');
    expect(providerModelText('codex', null)).toBe('codex · model not set');
    expect(providerModelText(null, 'x')).toBe('Not available');
  });

  it('work_text_cases', () => {
    const ticket = { key: 'T-031', title: 'Teams screen', status: 'dev-ready', workflowRunId: null };
    const assignment = { id: 'a', status: 's', taskId: 't', goal: 'Fix bug', workflowRunId: null };
    expect(workText({ state: 'working', assignment: null, ticket })).toBe('T-031 Teams screen');
    expect(workText({ state: 'working', assignment, ticket: null })).toBe('Fix bug');
    expect(workText({ state: 'working', assignment: null, ticket: null })).toBe('Working');
    expect(workText({ state: 'none' })).toBe('No current work');
    expect(workText({ state: 'unavailable', reason: 'x' })).toBe('Not available');
  });

  it('agent_usage_counts_catalog_members_only', () => {
    expect(agentUsage(twoTeams(), 'opencode-sonnet')).toBe('Used by 1 member in 1 team');
    expect(agentUsage(twoTeams(), 'spare')).toBe('Not used by any team');
    expect(agentUsage(null, 'spare')).toBe('Usage unavailable');
    expect(agentUsage({ ...twoTeams(), truncated: true }, 'opencode-sonnet')).toBe('Used by at least 1 member in 1 team');
  });

  it('overview_notices_in_order', () => {
    const o = overviewFixture([team({ definition: { state: 'unreadable', problems: [] } })], {
      runtimeState: { available: false, error: { code: 'X', message: 'state.db is locked' } },
      roles: { state: 'missing', message: '.agent-studio/roles.json does not exist' },
      truncated: true,
    });
    expect(overviewNotices(o)).toEqual([
      'Live team state unavailable — state.db is locked',
      'Role descriptions unavailable — .agent-studio/roles.json does not exist',
      'Some team definitions could not be read.',
      'Showing the first 1 team. More teams exist in this workspace.',
    ]);
    expect(overviewNotices(overviewFixture([], { partial: true }))).toEqual(['Some team details could not be read.']);
  });
});
