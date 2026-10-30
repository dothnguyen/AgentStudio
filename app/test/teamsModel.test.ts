import { describe, expect, it } from 'vitest';
import { memberIdentity, memberRoleSummary, memberAgentSummary, workSummary, resolveMemberSelection, missingMemberNotice } from "../src/renderer/teams/teamsModel";
import { roleItem } from './rolesFixtures';
import { member } from "./teamsFixtures";
import {
  orderTeams,
  overviewNotices,
  presenceLabel,
  presenceTone,
  providerModelText,
  runtimeTone,
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

  it('presence_tone_maps_runtime_evidence', () => {
    const t = presenceTone;
    expect([t('idle'), t('busy'), t('waiting_input'), t('limit_reached'), t('offline'), t('error')])
      .toEqual(['ok', 'busy', 'warning', 'warning', 'danger', 'danger']);
    expect([t('not_in_runtime'), t('stopped'), t('weird_new_state'), t('constructor')])
      .toEqual(['muted', 'muted', 'muted', 'muted']);
  });

  it('runtime_tone_maps_team_state', () => {
    const t = runtimeTone;
    expect([t('running'), t('starting'), t('error'), t('disconnected'), t('stopped'), t('not_started'), t('unavailable')])
      .toEqual(['ok', 'warning', 'danger', 'danger', 'muted', 'muted', 'muted']);
  });
});

describe('compact member model', () => {
  it('resolves stable member selection and removal notices', () => {
    const dev = member(), qa = member({ memberId: 'qa', name: 'qa' });
    const t = team({ members: [qa, dev] });
    expect(resolveMemberSelection(t, 'a', null)).toEqual({ state: 'none' });
    expect(resolveMemberSelection(t, 'a', { teamKey: 'b', memberId: 'qa' })).toEqual({ state: 'other-team' });
    expect(resolveMemberSelection(t, 'a', { teamKey: 'a', memberId: 'qa' })).toEqual({ state: 'selected', member: qa });
    expect(resolveMemberSelection(t, 'a', { teamKey: 'a', memberId: 'gone' })).toEqual({ state: 'missing', memberId: 'gone' });
    expect(missingMemberNotice('qa', false)).toBe('Member "qa" is no longer in this team. Showing all members.');
    expect(missingMemberNotice('qa', true)).toBe('Member "qa" is not among the returned members (the member list is truncated). Showing the returned members.');
    expect(resolveMemberSelection(team({members: [dev, qa]}), 'a', {teamKey: 'a', memberId: 'qa'})).toEqual({state: 'selected', member: qa});
    expect(resolveMemberSelection(team({members: [qa, dev]}), 'a', {teamKey: 'a', memberId: 'qa'})).toEqual({state: 'selected', member: qa});
    const duplicate = member({memberId: 'qa', name: 'another'});
    expect(resolveMemberSelection(team({members: [qa, duplicate]}), 'a', {teamKey: 'a', memberId: 'qa'})).toEqual({state: 'selected', member: qa});
  });
  it('summarizes identity role agent and work evidence', () => {
    expect(memberIdentity(member())).toEqual({ name: 'dev', id: null, note: null });
    expect(memberIdentity(member({ memberId: null, name: null })).note).toBe('No member id returned');
    expect(memberRoleSummary(member({ role: null, roleState: 'unavailable' }), null)).toEqual({label: 'No role', roleId: null, note: 'Role descriptions unavailable'});
    expect(memberAgentSummary(member({ runtime: null, source: 'runtime' })).text).toBe('No live or saved agent');
    expect(memberAgentSummary(member({runtime: null, agentOptions: []})).text).toBe('No live or saved agent');
    expect(memberAgentSummary(member({runtime: null, agentMode: 'inline', provider: null})).text).toBe('No live or saved agent');
    expect(workSummary({ state: 'unavailable', reason: 'constructor' })).toBe('Not available — constructor');
    expect(workSummary({ state: 'unavailable', reason: 'stopped' })).toBe('Not available — team stopped');
    expect(workSummary({ state: 'none' })).toBe('No current work');
  });
});

describe('roster evidence summaries', () => {
  it('member_identity_cases', () => {
    expect(memberIdentity(member({memberId: 'm-7', name: 'Dev Seven'}))).toEqual({name: 'Dev Seven', id: 'm-7', note: null});
    expect(memberIdentity(member({memberId: null, name: null}))).toEqual({name: 'Unnamed member', id: null, note: 'No member id returned'});
    expect(memberIdentity(member({source: 'runtime'})).note).toBe('Runtime only — not in the saved team definition');
  });
  it('member_role_summary_cases', () => {
    expect(memberRoleSummary(member({role: 'qa-b'}), [roleItem('qa-b', {name: 'QA'})])).toEqual({label: 'QA', roleId: 'qa-b', note: null});
    expect(memberRoleSummary(member(), [roleItem('Developer')]).roleId).toBeNull();
    expect(memberRoleSummary(member({roleState: 'undefined'}), []).note).toBe('Role not defined in roles.json');
    expect(memberRoleSummary(member(), []).note).toBe('Not found in the role catalog');
    expect(memberRoleSummary(member(), null).note).toBeNull();
  });
  it('member_agent_summary_live_saved_and_missing', () => {
    const live = twoTeams().teams[1]!.members[0]!.runtime!;
    expect(memberAgentSummary(member({runtime: live})).text).toBe('Active: opencode-sonnet · opencode · claude-sonnet');
    expect(memberAgentSummary(member({runtime: {...live, stale: true}})).text).toBe('Last live agent: opencode-sonnet (team not running)');
    expect(memberAgentSummary(member({runtime: {...live, activeAgent: null}})).text).toBe('No live agent reported');
    expect(memberAgentSummary(member({runtime: {...live, pendingAgent: 'codex-gpt'}})).note).toBe('Switch to codex-gpt pending');
    expect(memberAgentSummary(member({runtime: null})).text).toBe('Not running · saved default: OpenCode Sonnet');
    const first = member().agentOptions[0]!;
    expect(memberAgentSummary(member({runtime: null, agentOptions: [{...first, state: 'missing'}]})).note).toBe('Saved default is missing from the catalog');
    expect(memberAgentSummary(member({runtime: null, agentMode: 'inline', provider: 'codex', model: null})).text).toBe('Not running · saved inline: codex · model not set');
  });
  it('work_summary_cases', () => {
    const ticket = {key: 'T-031', title: 'Teams screen', status: 'dev', workflowRunId: null};
    const assignment = {id: 'a', goal: 'Fix bug', status: 'working', taskId: null, workflowRunId: null};
    expect(workSummary({state: 'working', ticket, assignment: null})).toBe('T-031 Teams screen');
    expect(workSummary({state: 'working', ticket: {...ticket, title: ''}, assignment: null})).toBe('T-031');
    expect(workSummary({state: 'working', ticket: null, assignment})).toBe('Fix bug');
    expect(workSummary({state: 'working', ticket: null, assignment: {...assignment, goal: ''}})).toBe('Assignment a');
    expect(workSummary({state: 'working', ticket: null, assignment: null})).toBe('Working (no details returned)');
    expect(['not_in_runtime', 'offline', 'constructor', ''].map(reason => workSummary({state: 'unavailable', reason}))).toEqual(['Not available — member is not in the running team', 'Not available — offline', 'Not available — constructor', 'Not available']);
  });
});
