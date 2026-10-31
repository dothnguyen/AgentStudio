import { describe, expect, it } from 'vitest';
import { memberIdentity, memberRoleSummary, memberAgentSummary, workSummary, filterMembers, resolveMemberSelection, missingMemberNotice, memberInitials, memberLiveAgent, memberRowWork } from "../src/renderer/teams/teamsModel";
import { roleItem } from './rolesFixtures';
import {
  availabilityCounts,
  availabilitySummary,
  runtimeDetailText,
  coordinatorText,
  definitionStateText,
  liveStateText,
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
import { RUNNING_TEAM_NOTICE, runningTeamNotice } from '../src/renderer/teams/teamEditModel';
import { catalogFixture, member, overviewFixture, team, twoTeams } from './teamsFixtures';

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

describe('overview helpers', () => {
  it('definition_state_text_covers_every_state', () => {
    const problems = [{ path: 'a', message: 'x' }, { path: 'b', message: 'y' }];
    expect(definitionStateText(team())).toBe('Valid');
    expect(definitionStateText(team({ definition: { state: 'problems', problems } }))).toBe('Has 2 problems');
    expect(definitionStateText(team({ definition: { state: 'problems', problems: [] } }))).toBe('Has 0 problems');
    expect(definitionStateText(team({ definition: { state: 'unreadable', problems: [] } }))).toBe('Unreadable');
    expect(definitionStateText(team({ definition: { state: 'missing', problems: [] } }))).toBe('No definition (runtime only)');
  });

  it('availability_counts_group_only_returned_members', () => {
    const members = ['busy', 'idle', 'busy', 'mystery'].map((presence, i) => member({ memberId: `m${i}`, presence }));
    expect(availabilityCounts(members)).toEqual([
      { presence: 'idle', label: 'Available', tone: 'ok', count: 1 },
      { presence: 'busy', label: 'Working', tone: 'busy', count: 2 },
      { presence: 'mystery', label: 'mystery', tone: 'muted', count: 1 },
    ]);
    expect(availabilityCounts([])).toEqual([]);
  });

  it('coordinator_and_live_state_text', () => {
    expect(coordinatorText(overviewFixture([], { coordinator: { running: true } }))).toEqual({ text: 'Running', tone: 'ok' });
    expect(coordinatorText(overviewFixture([], { coordinator: { running: false } }))).toEqual({ text: 'Not running', tone: 'danger' });
    expect(liveStateText(overviewFixture([]))).toEqual({ text: 'Available', tone: 'ok' });
    expect(liveStateText(overviewFixture([], { runtimeState: { available: false, error: { code: 'X', message: 'db locked' } } })))
      .toEqual({ text: 'Unavailable — db locked', tone: 'danger' });
    expect(liveStateText(overviewFixture([], { runtimeState: { available: false, error: null } })).text)
      .toBe('Unavailable — runtime not reachable');
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
  it('member_initials_cases', () => {
    expect(memberInitials('dev-1')).toBe('D1');
    expect(memberInitials('lead')).toBe('LE');
    expect(memberInitials('qa')).toBe('QA');
    expect(memberInitials('reviewer')).toBe('RE');
    expect(memberInitials('Ada Lovelace')).toBe('AL');
    expect(memberInitials('x')).toBe('X');
    expect(memberInitials('  ')).toBe('?');
    expect(memberInitials('release_bot two')).toBe('RB');
  });
  it('member_initials_keeps_unicode_characters_whole', () => {
    expect(memberInitials('Ünï')).toBe('ÜN');
    expect(memberInitials('😀 smile')).toBe('😀S');
    expect(memberInitials('a.b_c-d')).toBe('AB');
    expect(memberInitials('.hidden')).toBe('HI');
  });
  it('member_live_agent_cases', () => {
    const live = twoTeams().teams[1]!.members[0]!.runtime!;
    expect(memberLiveAgent(member({ runtime: live }), null)).toEqual({ kind: 'active', name: 'OpenCode Sonnet', meta: 'opencode · claude-sonnet', switched: false, note: null });
    expect(memberLiveAgent(member({ runtime: { ...live, activeAgent: 'codex-gpt', provider: 'codex', model: 'gpt-6', reasoning: 'medium' } }), catalogFixture().agents))
      .toEqual({ kind: 'active', name: 'Codex GPT', meta: 'codex · gpt-6 · medium', switched: true, note: null });
    expect(memberLiveAgent(member({ runtime: live }), [{ id: 'opencode-sonnet', name: 'Catalog Name', provider: 'opencode' }]).name).toBe('Catalog Name');
    expect(memberLiveAgent(member({ runtime: { ...live, activeAgent: 'live-agent-q' } }), null).name).toBe('live-agent-q');
    expect(memberLiveAgent(member({ runtime: { ...live, stale: true } }), null))
      .toMatchObject({ kind: 'stale', name: 'Last live agent: OpenCode Sonnet (team not running)', switched: false });
    expect(memberLiveAgent(member({ runtime: { ...live, activeAgent: null } }), null)).toMatchObject({ kind: 'none', name: 'No live agent reported', meta: null });
    expect(memberLiveAgent(member({ runtime: null }), null))
      .toEqual({ kind: 'saved', name: 'Not running · saved default: OpenCode Sonnet', meta: 'opencode · sonnet', switched: false, note: null });
    expect(memberLiveAgent(member({ runtime: null, agentMode: 'inline', provider: 'codex', model: null }), null))
      .toEqual({ kind: 'saved', name: 'Not running · saved inline: codex · model not set', meta: null, switched: false, note: null });
    expect(memberLiveAgent(member({ runtime: live, defaultAgent: null, agentOptions: [] }), null).switched).toBe(false);
    expect(memberLiveAgent(member({ runtime: { ...live, pendingAgent: 'codex-gpt' } }), null).note).toBe('Switch to codex-gpt pending');
    const first = member().agentOptions[0]!;
    expect(memberLiveAgent(member({ runtime: null, agentOptions: [{ ...first, state: 'missing' }] }), null).note).toBe('Saved default is missing from the catalog');
  });
  it('member_row_work_cases', () => {
    expect(memberRowWork({ state: 'none' })).toEqual({ text: 'Idle', muted: true });
    expect(memberRowWork({ state: 'unavailable', reason: 'stopped' })).toEqual({ text: 'Not available — team stopped', muted: true });
    const ticket = { key: 'T-031', title: 'Teams screen', status: 'dev', workflowRunId: null };
    expect(memberRowWork({ state: 'working', ticket, assignment: null })).toEqual({ text: 'T-031 Teams screen', muted: false });
    const delegation = { state: 'working' as const, ticket: { key: 'T-090', title: 'Fix the list', status: 'dev-ready', workflowRunId: null }, assignment: null, delegation: { commands: ['app-deps-install'], state: 'running' as const } };
    expect(memberRowWork(delegation)).toEqual({ text: 'T-090 · Waiting on coordinator: app-deps-install', muted: false });
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

describe('filterMembers', () => {
  const live = twoTeams().teams[1]!.members[0]!.runtime!;
  const members = [
    member({ memberId: 'id-only-zz', name: 'Alpha' }),
    member({ memberId: 'b', name: 'Bravo', role: 'Reviewer' }),
    member({ memberId: 'c', name: 'Charlie', runtime: { ...live, activeAgent: 'live-agent-q', stale: false } }),
    member({ memberId: 'd', name: 'Delta', runtime: { ...live, activeAgent: 'old-agent-q', stale: true } }),
    member({ memberId: 'e', name: 'Echo', runtime: null, agentOptions: [{ id: 'saved-opt', name: 'Saved Default Opt', provider: 'p', model: 'm', reasoning: null, description: null, state: 'ok' }] }),
    member({ memberId: 'f', name: 'Foxtrot', work: { state: 'working', ticket: { key: 'T-900', title: 'Zebra ticket' }, assignment: null } as never }),
    member({ memberId: 'g', name: 'Golf', work: { state: 'working', ticket: null, assignment: { id: 'a1', goal: 'Polish the kiwi' } } as never }),
    member({ memberId: 'h', name: 'Hotel', work: { state: 'unavailable', reason: 'stopped' } }),
  ];
  const ids = (query: string) => filterMembers(members, [roleItem('Developer', { name: 'Builder Role' })], null, query).map((m) => m.memberId);

  it('filters returned members case-insensitively across every displayed text field and preserves backend order', () => {
    expect(ids('ID-ONLY')).toEqual(['id-only-zz']);
    expect(ids('bravo')).toEqual(['b']);
    expect(ids('REVIEWER')).toEqual(['b']);
    expect(ids('builder role')).toContain('id-only-zz');
    expect(ids('live-agent-q')).toEqual(['c']);
    expect(ids('last live agent')).toEqual(['d']);
    expect(ids('not running · saved default')).toContain('e');
    expect(ids('saved default opt')).toEqual(['e']);
    expect(ids('T-900')).toEqual(['f']);
    expect(ids('zebra')).toEqual(['f']);
    expect(ids('KIWI')).toEqual(['g']);
    expect(ids('team stopped')).toEqual(['h']);
    expect(ids('no-such-text')).toEqual([]);
  });

  it('filters_by_status_label_and_does_not_mutate_the_source', () => {
    const mixed = [
      member({ memberId: 'a', name: 'a', presence: 'busy' }),
      member({ memberId: 'b', name: 'b', presence: 'idle' }),
      member({ memberId: 'c', name: 'c', presence: 'busy-ish' }),
      member({ memberId: 'd', name: 'delta-unique', presence: 'busy' }),
    ];
    const before = JSON.stringify(mixed);
    expect(filterMembers(mixed, null, null, 'working').map((m) => m.memberId)).toEqual(['a', 'd']);
    expect(filterMembers(mixed, null, null, 'busy-ish').map((m) => m.memberId)).toEqual(['c']);
    expect(filterMembers(mixed, null, null, 'busy').map((m) => m.memberId)).toEqual(['c']);
    expect(filterMembers(mixed, null, null, 'delta-unique').map((m) => m.memberId)).toEqual(['d']);
    expect(JSON.stringify(mixed)).toBe(before);
  });

  it('treats whitespace query as no filter and never returns the source array', () => {
    expect(filterMembers(members, null, null, '   ')).toEqual(members);
    expect(filterMembers(members, null, null, '   ')).not.toBe(members);
    expect(filterMembers(members, null, null, '')).not.toBe(members);
  });

  it('filters_by_idle_and_switched_text', () => {
    const idle = member({ memberId: 'x', name: 'x', work: { state: 'none' } });
    const working = member({ memberId: 'w', name: 'w', presence: 'busy' });
    expect(filterMembers([idle, working], null, null, 'idle').map((m) => m.memberId)).toEqual(['x']);
    const switched = member({ memberId: 's', name: 's', runtime: { ...live, activeAgent: 'codex-gpt', provider: 'codex', model: 'gpt-6' } });
    expect(filterMembers([idle, switched], null, null, 'switched').map((m) => m.memberId)).toEqual(['s']);
    expect(filterMembers([idle, switched], null, catalogFixture().agents, 'codex gpt').map((m) => m.memberId)).toEqual(['s']);
  });

  it('filters_identity_notes_role_ids_and_live_metadata', () => {
    const roles = [roleItem('dev-role', { name: 'Builder' })];
    const examples = [
      member({ memberId: 'rt', name: 'rt', source: 'runtime' }),
      member({ memberId: null, name: 'noid' }),
      member({ memberId: 'roled', name: 'roled', role: 'dev-role' }),
      member({ memberId: 'live', name: 'live', runtime: { ...live, provider: 'provider-meta', model: 'model-meta' } }),
    ];
    const find = (query: string) => filterMembers(examples, roles, null, query).map((m) => m.memberId);
    expect(find('runtime only — not in the saved team definition')).toEqual(['rt']);
    expect(find('no member id returned')).toEqual([null]);
    expect(find('dev-role')).toEqual(['roled']);
    expect(find('builder')).toEqual(['roled']);
    expect(find('provider-meta · model-meta')).toEqual(['live']);
  });

  it('searches live provider and model, pending and missing-agent notes, and role fallbacks', () => {
    const examples = [
      member({ memberId: 'live', runtime: { ...live, provider: 'provider-unique', model: 'model-unique', pendingAgent: 'pending-unique', stale: false } }),
      member({ memberId: 'missing', runtime: null, agentOptions: [{ id: 'lost', name: 'Lost', provider: null, model: null, reasoning: null, description: null, state: 'missing' }] }),
      member({ memberId: 'norole', role: null }),
      member({ memberId: 'fallback', role: 'uncatalogued-role' }),
    ];
    const find = (query: string) => filterMembers(examples, null, null, query).map(m => m.memberId);
    expect(find('PROVIDER-UNIQUE')).toEqual(['live']);
    expect(find('MODEL-UNIQUE')).toEqual(['live']);
    expect(find('pending-unique pending')).toEqual(['live']);
    expect(find('saved default is missing')).toEqual(['missing']);
    expect(find('no role')).toEqual(['norole']);
    expect(find('UNCATALOGUED-ROLE')).toEqual(['fallback']);
  });
});

describe('delegated commands in member work (P06)', () => {
  const ticket = { key: 'T-090', title: 'Fix the list', status: 'dev-ready', workflowRunId: 'run-1' };
  it('says the member waits on the coordinator while its commands run or queue', () => {
    const work = { state: 'working' as const, ticket, assignment: null,
      delegation: { commands: ['app-deps-install'], state: 'running' as const } };
    expect(workSummary(work)).toBe('T-090 · Waiting on coordinator: app-deps-install');
    expect(workText(work)).toBe('T-090 · Waiting on coordinator: app-deps-install');
    expect(workSummary({ ...work, ticket: null, delegation: { commands: ['a', 'b'], state: 'queued' as const } }))
      .toBe('Waiting on coordinator: a, b');
  });
  it('says when a person must approve first, and keeps the old text without delegation', () => {
    const work = { state: 'working' as const, ticket, assignment: null,
      delegation: { commands: ['app-dev-dependency-add'], state: 'awaiting_approval' as const } };
    expect(workSummary(work)).toBe('T-090 · Waiting for approval: app-dev-dependency-add');
    expect(workSummary({ state: 'working', ticket, assignment: null })).toBe('T-090 Fix the list');
    expect(workSummary({ state: 'working', ticket, assignment: null, delegation: { commands: [], state: 'queued' } }))
      .toBe('T-090 Fix the list');
  });

  it('availability_summary_full_partial_truncated_and_empty', () => {
    const t = (presences: string[], membersTruncated = false) =>
      team({ members: presences.map((presence, i) => member({ memberId: `m${i}`, presence })), membersTruncated });
    expect(availabilitySummary(t(Array(6).fill('idle')))).toEqual({ available: 6, totalText: '6', percent: 100, others: null, barLabel: '6 of 6 members available' });
    expect(availabilitySummary(t(['busy', 'idle']))).toEqual({ available: 1, totalText: '2', percent: 50, others: '1 working', barLabel: '1 of 2 members available' });
    expect(availabilitySummary(t(['idle', 'idle', 'offline']))).toMatchObject({ percent: 67, others: '1 offline' });
    expect(availabilitySummary(t(['busy', 'busy', 'future_state'], true))).toEqual({
      available: 0, totalText: '3+', percent: 0, others: '2 working · 1 future_state', barLabel: '0 of 3+ members available',
    });
    expect(availabilitySummary(t([]))).toEqual({ available: 0, totalText: '0', percent: 0, others: null, barLabel: '0 of 0 members available' });
    expect(availabilitySummary(t([], true)).totalText).toBe('0+');
  });

  it('runtime_detail_text_combines_coordinator_and_live_state', () => {
    expect(runtimeDetailText(overviewFixture([], { coordinator: { running: true } }))).toBe('Coordinator running · live state available');
    expect(runtimeDetailText(overviewFixture([], {
      coordinator: { running: false },
      runtimeState: { available: false, error: { code: 'X', message: 'state db locked' } },
    }))).toBe('Coordinator not running · live state unavailable — state db locked');
    expect(runtimeDetailText(overviewFixture([], {
      coordinator: { running: false },
      runtimeState: { available: false, error: null },
    }))).toBe('Coordinator not running · live state unavailable — runtime not reachable');
  });

  it('running_team_notice_only_for_live_teams', () => {
    const t = (state: 'running' | 'starting' | 'stopped' | 'not_started') => team({ runtime: { state, teamId: null, status: null } });
    expect(runningTeamNotice(t('running'))).toBe(RUNNING_TEAM_NOTICE);
    expect(runningTeamNotice(t('starting'))).toBe(RUNNING_TEAM_NOTICE);
    expect(runningTeamNotice(t('stopped'))).toBeNull();
    expect(runningTeamNotice(t('not_started'))).toBeNull();
  });
});
