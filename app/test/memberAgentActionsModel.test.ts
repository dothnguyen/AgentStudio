import { describe, expect, it } from 'vitest';
import { assignmentConfirmation, formatResetAt, lastSwitchSignature, matchingTerminalSwitch, memberAgentActions } from '../src/renderer/teams/memberAgentActionsModel';
import { member, team, twoTeams } from './teamsFixtures';

const runtime = { ...twoTeams().teams[1]!.members[0]!.runtime!, configuredAgents: ['primary', 'backup'], activeAgent: 'primary', paneState: 'alive', availability: 'idle' };
const catalog = [{ id: 'primary', name: 'Primary', provider: 'p' }, { id: 'backup', name: 'Backup', provider: 'p' }];
const running = team({ runtime: { state: 'running', teamId: 't', status: 'running' } });
const view = (r = runtime, c: typeof catalog | null = catalog, connected = true) => memberAgentActions(running, member({runtime: r}), c, connected, null);
describe('member agent actions', () => {
  it('eligible_and_disabled_switch_states', () => {
    expect(view().options[1]!.canSwitch).toBe(true);
    expect(view().options[0]!.disabledReason).toBe('That agent is already active.');
    expect(view({...runtime, quotaHolds: {backup: null}}).options[1]!.disabledReason).toBe("Agent 'backup' is on quota hold.");
    expect(view({...runtime, pendingAgent: 'backup'}).options[1]!.disabledReason).toBe('A switch is already pending for this member.');
    expect(view({...runtime, paneState: 'dead'}).options[1]!.disabledReason).toBe("The member's pane is not alive.");
    expect(view({...runtime, availability: 'busy'}).options[1]!.canSwitch).toBe(false);
    expect(memberAgentActions(running, member({runtime: null}), catalog, true, null).visible).toBe(false);
  });
  it('all_held_and_unknown_reset_display', () => {
    const v = view({...runtime, configuredAgents: ['primary', 'backup', 'third'], quotaHolds: {backup: null, third: 'invalid'}});
    expect(v.notice).toBe('All alternate agents are on quota hold.');
    expect(v.options.slice(1).map(o => [o.holdText, o.canResume])).toEqual([['Reset time unknown', true], ['Reset time unknown', true]]);
    expect(v.options.slice(1).every(o => !o.canSwitch)).toBe(true);
    expect(formatResetAt('2026-02-30T03:04:00Z')).toBe('Reset time unknown');
    expect(formatResetAt('2026-01-02T24:00:00Z')).toBe('Reset time unknown');
    expect(formatResetAt('2026-01-02T03:04:00')).toBe('Reset time unknown');
    expect(formatResetAt('2026-01-02T03:04:00Z')).toBe('Resets at 2026-01-02 03:04 UTC');
  });
  it('disconnected_stale_missing_and_permission_errors', () => {
    expect(view(runtime, catalog, false).options[1]!.disabledReason).toBe('Backend disconnected; live actions are disabled.');
    expect(view({...runtime, stale: true}).options[1]!.disabledReason).toBe('Live member state is stale; refresh before switching or resuming.');
    expect(view(runtime, null).options[1]!.disabledReason).toBe('Agent catalog unavailable; switching is disabled.');
    expect(view(runtime, [catalog[0]!]).options[1]!.disabledReason).toBe("Agent 'backup' is missing from the catalog.");
    expect(assignmentConfirmation({code: 'PERMISSION_DENIED', message: 'no', retryable: false})).toBeNull();
  });
  it('matching_terminal_switch_ignores_old_result', () => {
    const old = {state: 'completed' as const, requestedAgent: 'backup', assignmentId: null, code: null, message: null, at: '1'};
    const signature = lastSwitchSignature(old);
    expect(matchingTerminalSwitch(member({runtime: {...runtime, lastSwitch: old}}), 'backup', signature)).toBeNull();
    expect(matchingTerminalSwitch(member({runtime: {...runtime, lastSwitch: {...old, state: 'pending', at: '2'}}}), 'backup', signature)).toBeNull();
    expect(matchingTerminalSwitch(member({runtime: {...runtime, lastSwitch: {...old, at: '2'}}}), 'backup', signature)).toBe('completed');
    expect(matchingTerminalSwitch(member({runtime: {...runtime, lastSwitch: {...old, state: 'failed', at: '2'}}}), 'backup', signature)).toBe('failed');
  });
  it('uses_frozen_runtime_options_and_actual_metadata_only', () => {
    const r = {...runtime, configuredAgents: ['primary', 'removed', 'backup'], provider: null, model: null, reasoning: null, quotaHolds: {removed: null, extra: null}};
    const m = member({runtime: r, defaultAgent: 'saved', provider: 'saved-provider', model: 'saved-model'});
    const v = memberAgentActions(running, m, catalog, true, null);
    expect(v.activeText).toBe('primary');
    expect(v.options.map(o => o.id)).toEqual(['primary', 'removed', 'backup', 'extra']);
    expect(v.options[1]).toMatchObject({label: 'removed', canSwitch: false, canResume: true});
    expect(v.options[3]).toMatchObject({label: 'extra', canSwitch: false, canResume: true});
    expect(view({...runtime, configuredAgents: null}).options).toEqual([]);
    const noFrozenOptions = view({...runtime, configuredAgents: null, quotaHolds: {extra: null}});
    expect(noFrozenOptions.options).toMatchObject([{id: 'extra', canSwitch: false, canResume: true, holdText: 'Reset time unknown'}]);
    expect(noFrozenOptions.allHeld).toBe(false);
  });
  it('switch_prerequisites_and_reason_precedence', () => {
    expect(memberAgentActions(running, member({runtime}), catalog, true, {memberId: 'dev', agentId: 'backup', kind: 'resume'}).options[1]!.disabledReason).toBe('Requesting…');
    expect(memberAgentActions(team(), member({runtime}), catalog, true, null).options[1]!.disabledReason).toBe('The team is not running.');
    expect(view({...runtime, availability: 'busy', assignment: null}).options[1]!.disabledReason).toBe('Member must be idle, quota-limited, or have an active assignment before switching.');
    expect(view({...runtime, availability: 'busy', assignment: {id: 'a', status: 'working', taskId: 't'}}).options[1]!.canSwitch).toBe(true);
    expect(view({...runtime, pendingAgent: 'backup', quotaHolds: {backup: null}}).options[1]!.canResume).toBe(false);
    expect(view({...runtime, configuredAgents: ['primary']}).allHeld).toBe(false);
    expect(view({...runtime, stale: true}, catalog, false).options[1]!.disabledReason).toBe('Backend disconnected; live actions are disabled.');
  });
  it('disabled_reason_follows_runtime_prerequisite_precedence', () => {
    const held = {...runtime, stale: true, paneState: 'dead', pendingAgent: 'backup', quotaHolds: {backup: null}};
    const locked = {memberId: 'dev', agentId: 'backup', kind: 'switch' as const};
    const reason = (r: typeof runtime, connected = true, t = running) => memberAgentActions(t, member({runtime: r}), null, connected, locked).options[1]!.disabledReason;
    expect(reason(held, false, team())).toBe('Backend disconnected; live actions are disabled.');
    expect(reason(held, true, team())).toBe('The team is not running.');
    expect(reason(held)).toBe('Live member state is stale; refresh before switching or resuming.');
    expect(reason({...held, stale: false})).toBe("The member's pane is not alive.");
    expect(reason({...held, stale: false, paneState: 'alive'})).toBe('A switch is already pending for this member.');
    expect(reason({...held, stale: false, paneState: 'alive', pendingAgent: null})).toBe('Requesting…');
  });
  it('confirmation_requires_exact_error_and_nonempty_assignment', () => {
    const message = 'Member has an active assignment; confirm cancellation of this assignment to switch.';
    expect(assignmentConfirmation({code: 'BAD_REQUEST', message, retryable: false, data: {assignmentId: 'A'}})).toEqual({assignmentId: 'A'});
    for (const error of [
      {code: 'PERMISSION_DENIED', message, retryable: false, data: {assignmentId: 'A'}},
      {code: 'BAD_REQUEST', message: message + ' ', retryable: false, data: {assignmentId: 'A'}},
      {code: 'BAD_REQUEST', message, retryable: false, data: {assignmentId: ''}},
      {code: 'BAD_REQUEST', message, retryable: false, data: {assignmentId: 42}},
    ]) expect(assignmentConfirmation(error)).toBeNull();
  });
  it('terminal_signature_checks_every_field_and_target', () => {
    const old = {state: 'failed' as const, requestedAgent: 'backup', assignmentId: 'a', code: 'E', message: 'old', at: 'time'};
    const signature = lastSwitchSignature(old);
    for (const change of [{assignmentId: 'b'}, {code: 'F'}, {message: 'new'}, {at: 'later'}]) {
      expect(matchingTerminalSwitch(member({runtime: {...runtime, lastSwitch: {...old, ...change}}}), 'backup', signature)).toBe('failed');
    }
    expect(matchingTerminalSwitch(member({runtime: {...runtime, lastSwitch: old}}), 'primary', null)).toBeNull();
    expect(matchingTerminalSwitch(member(), 'backup', null)).toBeNull();
  });
  it('resume_requires_runtime_hold_and_member_specific_lock', () => {
    const held = {...runtime, quotaHolds: {backup: null}};
    expect(memberAgentActions(running, member({runtime: held}), catalog, true, {memberId: 'dev', agentId: 'primary', kind: 'switch'}).options[1]!.canResume).toBe(false);
    expect(memberAgentActions(running, member({runtime: held}), catalog, true, {memberId: 'other', agentId: 'primary', kind: 'switch'}).options[1]!.canResume).toBe(true);
    expect(view(held, catalog, false).options[1]!.canResume).toBe(false);
    expect(view({...held, stale: true}).options[1]!.canResume).toBe(false);
    expect(memberAgentActions(team(), member({runtime: held}), catalog, true, null).options[1]!.canResume).toBe(false);
    expect(view().options[1]!.canResume).toBe(false);
    expect(formatResetAt('2026-01-02T05:04:00+02:00')).toBe('Resets at 2026-01-02 03:04 UTC');
  });
  it('projects_runtime_assignment_and_held_missing_catalog_option', () => {
    const r = {...runtime, configuredAgents: ['primary', 'gone'], provider: 'actual-provider', model: 'actual-model', reasoning: 'high', assignment: {id: 'assignment-1', status: 'working', taskId: 'task-1'}, quotaHolds: {gone: null}};
    const v = view(r);
    expect(v.activeText).toBe('primary · actual-provider · actual-model · Reasoning: high');
    expect(v.availabilityText).toBe('Available');
    expect(v.assignmentText).toBe('assignment-1 · working · task-1');
    expect(v.options[1]).toMatchObject({label: 'gone', canSwitch: false, canResume: true, holdText: 'Reset time unknown', disabledReason: "Agent 'gone' is missing from the catalog."});
    expect(view({...runtime, assignment: null}).assignmentText).toBe('No active assignment');
  });
  it('projects_pending_and_terminal_results_using_catalog_labels', () => {
    const result = {state: 'failed' as const, requestedAgent: 'backup', assignmentId: null, code: 'PROVIDER_UNAVAILABLE', message: 'offline', at: 'now'};
    const v = view({...runtime, pendingAgent: 'backup', lastSwitch: result});
    expect(v.pendingText).toBe('Switch to Backup pending.');
    expect(view({...runtime, lastSwitch: {...result, state: 'pending'}}).lastResultText).toBe('Switch to Backup pending — PROVIDER_UNAVAILABLE: offline');
    expect(v.lastResultText).toBe('Switch to Backup failed — PROVIDER_UNAVAILABLE: offline');
    expect(view({...runtime, lastSwitch: {...result, state: 'completed'}}).lastResultText).toBe('Switch to Backup completed — PROVIDER_UNAVAILABLE: offline');
    expect(view({...runtime, lastSwitch: {...result, code: null, message: null}}).lastResultText).toBe('Switch to Backup failed');
    expect(view({...runtime, pendingAgent: 'removed'}, null).pendingText).toBe('Switch to removed pending.');
    expect(memberAgentActions(running, member({runtime: null}), catalog, true, null).visible).toBe(false);
  });
  it('unavailable_runtime_and_inline_sources_never_expose_actions', () => {
    expect(memberAgentActions(running, member({runtime: null}), catalog, true, null)).toMatchObject({visible: false, options: [], activeText: ''});
    for (const m of [member({runtime, agentMode: 'inline'}), member({runtime, source: 'inline'})]) {
      const v = memberAgentActions(running, m, catalog, true, null);
      expect(v.visible).toBe(true);
      expect(v.options.every(o => !o.canSwitch)).toBe(true);
    }
  });
  it('confirmation_rejects_missing_and_whitespace_assignment_ids', () => {
    const message = 'Member has an active assignment; confirm cancellation of this assignment to switch.';
    for (const data of [undefined, null, {}, {assignmentId: '  '}, {assignmentId: ['A']}]) {
      expect(assignmentConfirmation({code: 'BAD_REQUEST', message, retryable: false, data})).toBeNull();
    }
  });
  it('dead_pane_notice_is_visible_without_options', () => {
    expect(view({...runtime, configuredAgents: [], quotaHolds: {}, paneState: 'dead'}).notice).toBe("The member's pane is not alive.");
  });
  it('hold_only_catalog_option_is_resume_only', () => {
    const v = view({...runtime, quotaHolds: {extra: null}}, [...catalog, {id: 'extra', name: 'Extra', provider: 'p'}]);
    expect(v.options[2]).toMatchObject({id: 'extra', canSwitch: false, canResume: true});
  });
  it('deduplicates_frozen_and_held_ids_without_changing_order', () => {
    const v = view({...runtime, configuredAgents: ['primary', 'backup', 'primary', 'backup'], quotaHolds: {backup: null, extra: null}});
    expect(v.options.map(option => option.id)).toEqual(['primary', 'backup', 'extra']);
    expect(v.options[1]).toMatchObject({canSwitch: false, canResume: true});
    expect(v.options[2]).toMatchObject({canSwitch: false, canResume: true});
  });

  it('only_own_quota_holds_can_be_resumed_and_all_held_ignores_hold_only_ids', () => {
    const holds = Object.assign(Object.create({backup: null}), {extra: null});
    const v = view({...runtime, quotaHolds: holds});
    expect(v.options.map(o => o.id)).toEqual(['primary', 'backup', 'extra']);
    expect(v.options[1]).toMatchObject({canSwitch: true, canResume: false, holdText: null});
    expect(v.options[2]).toMatchObject({canSwitch: false, canResume: true});
    expect(v.allHeld).toBe(false);
    expect(view({...runtime, quotaHolds: {backup: null, extra: null}}).allHeld).toBe(true);
  });

  it('projects_runtime_summary_for_catalog_inline_and_runtime_only_members', () => {
    const work = {state: 'working' as const, assignment: {id: 'a1', status: 'working', taskId: 't1', goal: 'Fix it', workflowRunId: null}, ticket: {key: 'T-1', title: 'Title', status: 'doing', workflowRunId: null}};
    const r = {...runtime, provider: 'prov', model: 'mod', reasoning: 'high', assignment: {id: 'a1', status: 'working', taskId: 't1'}, stale: true};
    const v = memberAgentActions(running, member({runtime: r, work, provider: 'saved', model: 'saved-model'}), catalog, true, null);
    expect(v).toMatchObject({visible: true, activeText: 'primary · prov · mod · Reasoning: high', availabilityText: 'Available', paneText: 'Pane: alive', staleText: 'Live state is stale.', assignmentText: 'a1 · working · t1', workText: 'T-1 · Title · doing'});
    expect(memberAgentActions(running, member({runtime: {...r, activeAgent: null, paneState: null, stale: false, availability: 'busy'}, work: {...work, ticket: null}}), catalog, true, null)).toMatchObject({activeText: 'Unknown · prov · mod · Reasoning: high', availabilityText: 'busy', paneText: 'Pane state unavailable', staleText: null, workText: 'Fix it'});
    expect(memberAgentActions(running, member({runtime: r, work: {state: 'working', assignment: null, ticket: null}}), catalog, true, null).workText).toBe('Working');
    expect(memberAgentActions(running, member({runtime: r, work: {state: 'none'}}), catalog, true, null).workText).toBeNull();
    expect(memberAgentActions(running, member({runtime: r, work: {state: 'unavailable', reason: 'board down'}}), catalog, true, null).workText).toBe('Current work unavailable — board down');
    for (const extra of [{agentMode: 'inline' as const}, {source: 'runtime' as const}]) {
      const m = memberAgentActions(running, member({runtime: {...r, stale: false, quotaHolds: {backup: null}}, ...extra}), catalog, true, null);
      expect(m.visible).toBe(true); expect(m.activeText).toContain('primary');
      if (extra.agentMode) { expect(m.notice).toBe('Live switching is unavailable for inline members.'); expect(m.options.every(o => !o.canSwitch)).toBe(true); }
    }
  });
  it('uses_only_frozen_options_plus_recorded_holds', () => {
    const m = member({runtime: {...runtime, configuredAgents: ['primary', 'backup', 'backup'], quotaHolds: {extra: null}}, agentOptions: [{id: 'saved', name: null, provider: null, model: null, reasoning: null, description: null, state: 'ok'}], defaultAgent: 'saved'});
    const v = memberAgentActions(running, m, catalog, true, null);
    expect(v.options.map(o => o.id)).toEqual(['primary', 'backup', 'extra']);
    expect(v.options[2]).toMatchObject({canSwitch: false, canResume: true, disabledReason: "Agent 'extra' is missing from the catalog."});
    const withExtra = memberAgentActions(running, m, [...catalog, {id: 'extra', name: 'Extra', provider: 'p'}], true, null);
    expect(withExtra.options[2]!.disabledReason).toBe("Agent 'extra' is not configured for this member.");
    const activeHoldOnly = memberAgentActions(running, member({runtime: {...runtime, activeAgent: 'extra', quotaHolds: {extra: null}}}), [...catalog, {id: 'extra', name: 'Extra', provider: 'p'}], true, null);
    expect(activeHoldOnly.options.find(o => o.id === 'extra')).toMatchObject({canSwitch: false, canResume: true, disabledReason: "Agent 'extra' is not configured for this member."});
    const unknown = memberAgentActions(running, member({runtime: {...runtime, configuredAgents: null, quotaHolds: {backup: null}}, defaultAgent: 'saved'}), catalog, true, null);
    expect(unknown.notice).toBe('Live agent eligibility is unavailable; switching is disabled. Recorded quota holds can still be resumed.');
    expect(unknown.options).toMatchObject([{id: 'backup', canSwitch: false, canResume: true}]);
  });
  it('projects_text_states_for_active_switchable_held_missing_pending_and_ineligible_options', () => {
    const states = (r: typeof runtime, c: typeof catalog | null = catalog) => view(r, c).options.map(o => o.state);
    expect(states(runtime)).toEqual(['active', 'switchable']);
    expect(states({...runtime, quotaHolds: {backup: null}})).toEqual(['active', 'held']);
    expect(states(runtime, [catalog[0]!])).toEqual(['active', 'missing_catalog']);
    expect(states({...runtime, pendingAgent: 'backup'})).toEqual(['active', 'pending']);
    expect(states({...runtime, paneState: 'dead'})).toEqual(['active', 'pane_dead']);
    expect(states({...runtime, availability: 'busy'})).toEqual(['active', 'ineligible']);
    expect(states(runtime, null)).toEqual(['active', 'ineligible']);
    const dead = view({...runtime, paneState: 'dead', quotaHolds: {backup: null}}).options[1]!;
    expect(dead).toMatchObject({canSwitch: false, canResume: false, disabledReason: "The member's pane is not alive."});
    const noCatalog = view({...runtime, quotaHolds: {backup: null}}, null).options[1]!;
    expect(noCatalog).toMatchObject({canSwitch: false, canResume: true, disabledReason: 'Agent catalog unavailable; switching is disabled.'});
    expect(view({...runtime, quotaHolds: {primary: null}}).options[0]!.disabledReason).toBe("Agent 'primary' is on quota hold.");
  });
  it('inline_member_with_null_configured_agents_reports_inline_notice', () => {
    const m = memberAgentActions(running, member({runtime: {...runtime, configuredAgents: null}, agentMode: 'inline'}), catalog, true, null);
    expect(m.notice).toBe('Live switching is unavailable for inline members.');
    expect(m.options.every(o => !o.canSwitch)).toBe(true);
  });
});
