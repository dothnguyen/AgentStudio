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
    expect(memberAgentActions(running, member({runtime, agentMode: 'inline'}), catalog, true, null).visible).toBe(false);
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
    expect(view({...runtime, pendingAgent: 'backup', quotaHolds: {backup: null}}).options[1]!.canResume).toBe(true);
    expect(view({...runtime, configuredAgents: ['primary']}).allHeld).toBe(false);
    expect(view({...runtime, stale: true}, catalog, false).options[1]!.disabledReason).toBe('Backend disconnected; live actions are disabled.');
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
    expect(v.lastResultText).toBe('Switch to Backup failed — PROVIDER_UNAVAILABLE: offline');
    expect(view({...runtime, lastSwitch: {...result, state: 'completed'}}).lastResultText).toBe('Switch to Backup completed.');
    expect(view({...runtime, lastSwitch: {...result, code: null, message: null}}).lastResultText).toBe('Switch to Backup failed');
    expect(view({...runtime, pendingAgent: 'removed'}, null).pendingText).toBe('Switch to removed pending.');
    expect(memberAgentActions(running, member({runtime: null}), catalog, true, null).visible).toBe(false);
  });
});
