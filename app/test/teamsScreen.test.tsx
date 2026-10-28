// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceShell } from '../src/renderer/shell/WorkspaceShell';
import { TeamsScreen } from '../src/renderer/teams/TeamsScreen';
import { readyApi, workspaceA } from './dashboardFixtures';
import { catalogFixture, fakeManagement, member, overviewFixture, team, twoTeams } from './teamsFixtures';

afterEach(cleanup);

async function renderScreen(opts: Parameters<typeof fakeManagement>[0] = {}) {
  const fake = fakeManagement(opts);
  const result = render(<TeamsScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  return { fake, result };
}

const cells = (row: HTMLElement) => Array.from(row.querySelectorAll('td')).map((td) => td.textContent ?? '');
const cardNames = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('.teams-card-name')).map((n) => n.textContent);
const card = (root: HTMLElement, name: string) =>
  within(root).getByRole('button', { name: new RegExp(`^${name}`) });

describe('TeamsScreen', () => {
  it('saved_options_are_distinct_from_live_agent', async () => {
    const live = twoTeams().teams[1]!.members[0]!.runtime!;
    const saved = {id: 'saved', name: 'Saved choice', provider: 'saved-provider', model: 'saved-model', reasoning: null, description: null, state: 'ok' as const};
    const m = member({agentMode: 'ordered_catalog', agentOptions: [saved], defaultAgent: 'saved', runtime: {...live, activeAgent: 'live-id', provider: 'live-provider', model: 'live-model'}});
    const {result} = await renderScreen({overview: [{ok: true, data: overviewFixture([team({members: [m]})])}]});
    const row = within(result.getByRole('region', {name: 'Dev Team'})).getAllByRole('row')[1]!;
    const values = cells(row);
    expect(values[2]).toBe('Default — Saved choice · saved-provider · saved-model');
    expect(values[3]).toContain('live-id · live-provider · live-model');
    expect(values[2]).not.toContain('live-id');
    expect(values[3]).not.toContain('Saved choice');
  });

  it('saved_options_keep_order_and_live_reasoning_uses_runtime_values', async () => {
    const live = twoTeams().teams[1]!.members[0]!.runtime!;
    const first = {id: 'first', name: 'First', provider: 'saved-provider', model: 'saved-model', reasoning: 'low', description: null, state: 'ok' as const};
    const missing = {id: 'gone', name: null, provider: null, model: null, reasoning: null, description: null, state: 'missing' as const};
    const m = member({agentMode: 'ordered_catalog', agentOptions: [first, missing], defaultAgent: 'first', runtime: {...live, activeAgent: 'live-id', provider: 'live-provider', model: 'live-model', reasoning: 'high'}});
    const {result} = await renderScreen({overview: [{ok: true, data: overviewFixture([team({members: [m]})])}]});
    const row = within(result.getByRole('region', {name: 'Dev Team'})).getAllByRole('row')[1]!;
    const savedCell = row.querySelectorAll('td')[2]!;
    const items = within(savedCell).getAllByRole('listitem');
    expect(items.map(item => item.textContent)).toEqual([
      'Default — First · saved-provider · saved-model · Reasoning: low',
      'gone · Not available · Missing from catalog',
    ]);
    expect(row.querySelectorAll('td')[3]?.textContent).toContain('live-id · live-provider · live-model · Reasoning: high');
  });

  it('renders_teams_and_members_from_overview', async () => {
    const { fake, result } = await renderScreen();
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Teams');
    const list = result.getByRole('region', { name: 'Workspace teams' });
    expect(cardNames(list)).toEqual(['Dev Team', 'Release Team']);
    expect(card(list, 'Dev Team').getAttribute('aria-pressed')).toBe('true');
    const detail = result.getByRole('region', { name: 'Dev Team' });
    expect(detail.textContent).toContain('Runtime: Running');
    expect(detail.textContent).toContain('t-1');
    const rows = within(detail).getAllByRole('row').slice(1);
    const [r1, r2] = rows.map((r) => cells(r));
    expect(r1).toEqual([
      'devAgent: opencode-sonnet',
      'DeveloperImplements scoped tickets.',
      'Default — OpenCode Sonnet · opencode · sonnet',
      expect.stringContaining('opencode-sonnet · opencode · claude-sonnet'),
      'Working',
      'T-031 Teams screen',
      'EditRemove',
    ]);
    expect(r2).toEqual([
      'leadInline member',
      'TeamLeadNo description',
      'Inline — codex · model not set',
      'Not running',
      'Available',
      'No current work',
      'EditRemove',
    ]);
    expect(fake.overview).toHaveBeenCalledTimes(1);
    expect(fake.overview).toHaveBeenCalledWith('ws-a');
    expect(fake.agents).toHaveBeenCalledTimes(1);
    expect(fake.agents).toHaveBeenCalledWith('ws-a');
  });

  it('selecting_a_team_shows_its_members_without_reloading', async () => {
    const { fake, result } = await renderScreen();
    const list = result.getByRole('region', { name: 'Workspace teams' });
    fireEvent.click(card(list, 'Release Team'));
    expect(card(list, 'Release Team').getAttribute('aria-pressed')).toBe('true');
    expect(card(list, 'Dev Team').getAttribute('aria-pressed')).toBe('false');
    const detail = result.getByRole('region', { name: 'Release Team' });
    expect(within(detail).getByRole('heading', { level: 2 }).textContent).toBe('Release Team');
    const row = within(detail).getAllByRole('row')[1]!;
    expect(row.textContent).toContain('qa');
    expect(row.textContent).toContain('Stopped');
    expect(row.textContent).toContain('Not available');
    expect(fake.overview).toHaveBeenCalledTimes(1);
  });

  it('does_not_render_catalog_region_but_still_loads_catalog_for_member_forms', async () => {
    const { result, fake } = await renderScreen();
    expect(result.queryByRole('region', { name: 'Agent catalog' })).toBeNull();
    expect(result.queryByRole('heading', { name: 'Agent catalog' })).toBeNull();
    expect(result.queryByRole('list', { name: 'Agent catalog' })).toBeNull();
    expect(fake.agents).toHaveBeenCalledTimes(1);
    fireEvent.click(result.getByRole('button', { name: 'Add member' }));
    expect(result.getByRole('option', { name: 'OpenCode Sonnet (opencode-sonnet)' })).toBeTruthy();
  });

  it('keeps members visible and catalog choices unavailable when catalog loading fails', async () => {
    const { result } = await renderScreen({ agents: [{ ok: false, error: { code: 'CATALOG_FAIL', message: 'failed', retryable: true } }] });
    const detail = result.getByRole('region', { name: 'Dev Team' });
    expect(within(detail).getAllByRole('row')[1]?.textContent).toContain('dev');
    fireEvent.click(result.getByRole('button', { name: 'Add member' }));
    expect(result.queryByRole('option', { name: 'OpenCode Sonnet (opencode-sonnet)' })).toBeNull();
    expect(within(detail).getAllByRole('row')[1]?.textContent).toContain('dev');
  });

  it('empty_workspace_shows_empty_states_and_no_sample_agents', async () => {
    const { result } = await renderScreen({
      overview: [{ ok: true, data: overviewFixture([]) }],
      agents: [{ ok: true, data: catalogFixture({ agents: [] }) }],
    });
    expect(result.getByText('No teams defined in this workspace.')).toBeTruthy();
    expect(result.queryByRole('table')).toBeNull();
    expect(result.container.querySelector('.teams-card')).toBeNull();
    for (const sample of ['Agent Studio Dev Team', 'Research Team', 'Release Team', 'GPT-6', 'Claude Sonnet', 'OpenCode']) {
      expect(result.container.textContent).not.toContain(sample);
    }
  });

  it('missing_details_and_partial_overview_are_labelled', async () => {
    const data = overviewFixture([
      team({
        id: 'ghost',
        name: null,
        definition: { state: 'unreadable', problems: [{ path: '$', message: 'could not load team definition: TEAM_CONFIG_INVALID' }] },
        runtime: { state: 'unavailable', teamId: null, status: null },
        members: [member({
          memberId: 'm1', name: null, role: null, roleDescription: null, roleState: 'unavailable',
          agentDefId: 'gone', agentDefState: 'missing', provider: null, model: null, presence: 'unavailable',
          work: { state: 'unavailable', reason: 'unavailable' },
        })],
      }),
    ], {
      partial: true,
      runtimeState: { available: false, error: { code: 'RUNTIME_UNAVAILABLE', message: 'state.db is locked' } },
      roles: { state: 'missing', message: '.agent-studio/roles.json does not exist' },
    });
    const { result } = await renderScreen({ overview: [{ ok: true, data }] });
    const list = result.getByRole('region', { name: 'Workspace teams' });
    for (const t of ['ghost', 'Runtime unavailable', 'Definition unreadable']) expect(list.textContent).toContain(t);
    const detail = result.getByRole('region', { name: 'ghost' });
    expect(detail.textContent).toContain('$: could not load team definition: TEAM_CONFIG_INVALID');
    const row = within(detail).getAllByRole('row')[1]!;
    for (const t of ['m1', 'Agent definition gone is missing', 'No role', 'Role descriptions unavailable', 'Not available', 'Unavailable']) {
      expect(row.textContent).toContain(t);
    }
    const notices = within(result.getByRole('list', { name: 'Data notices' })).getAllByRole('listitem');
    expect(notices.map((n) => n.textContent)).toEqual([
      'Live team state unavailable — state.db is locked',
      'Role descriptions unavailable — .agent-studio/roles.json does not exist',
      'Some team definitions could not be read.',
    ]);
  });

  it('long_labels_and_truncation_render_in_full', async () => {
    const long = 'Very long team name '.repeat(10).trim();
    const members = Array.from({ length: 16 }, (_, i) => member({ memberId: `m${i}`, name: `m${i}` }));
    const desc = 'd'.repeat(4000);
    const catalog = catalogFixture();
    catalog.agents[0]!.description = desc;
    const { result } = await renderScreen({
      overview: [{ ok: true, data: overviewFixture([team({ name: long, members, membersTruncated: true })], { truncated: true }) }],
      agents: [{ ok: true, data: catalog }],
    });
    const hits = result.getAllByText(long);
    expect(hits).toHaveLength(2);
    for (const h of hits) expect(h.textContent).toBe(long);
    expect(result.getByText('16+ members', { selector: '.teams-card-facts' })).toBeTruthy();
    expect(result.getByText('Showing the first 16 members.')).toBeTruthy();
    expect(result.getByText('Showing the first 1 team. More teams exist in this workspace.')).toBeTruthy();
  });

  it('loading_states_are_announced', async () => {
    const never = new Promise<never>(() => {});
    const { result } = await renderScreen({ overview: [never], agents: [never] });
    const texts = result.getAllByRole('status').map((s) => s.textContent);
    expect(texts).toContain('Loading teams…');
    expect(result.queryByRole('table')).toBeNull();
  });

  it('overview_error_shows_remediation_and_retries_only_overview', async () => {
    const { fake, result } = await renderScreen({
      overview: [
        { ok: false, error: { code: 'INTERNAL', message: 'boom', retryable: true, remediation: 'Restart the backend.' } },
        { ok: true, data: twoTeams() },
      ],
    });
    const list = result.getByRole('region', { name: 'Workspace teams' });
    const alert = within(list).getByRole('alert');
    expect(alert.textContent).toContain('INTERNAL: boom');
    expect(alert.textContent).toContain('Restart the backend.');
    fireEvent.click(within(list).getByRole('button', { name: 'Retry' }));
    await act(async () => {});
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(fake.agents).toHaveBeenCalledTimes(1);
    expect(card(list, 'Dev Team')).toBeTruthy();
  });

  it('refresh_reloads_both_and_keeps_selection', async () => {
    const { fake, result } = await renderScreen();
    const list = result.getByRole('region', { name: 'Workspace teams' });
    fireEvent.click(card(list, 'Release Team'));
    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    await act(async () => {});
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(fake.agents).toHaveBeenCalledTimes(2);
    expect(card(list, 'Release Team').getAttribute('aria-pressed')).toBe('true');
  });

  it('rejected_overview_shows_internal_error', async () => {
    const { result } = await renderScreen({ overview: [Promise.reject(new Error('ipc down'))] });
    expect(within(result.getByRole('region', { name: 'Workspace teams' })).getByRole('alert').textContent)
      .toContain('INTERNAL: ipc down');
  });

  it('markup_like_names_stay_text', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const catalog = catalogFixture();
    catalog.agents[0]!.name = evil;
    const { result } = await renderScreen({
      overview: [{ ok: true, data: overviewFixture([team({ name: evil })]) }],
      agents: [{ ok: true, data: catalog }],
    });
    expect(result.getAllByText(evil).length).toBeGreaterThanOrEqual(2);
    expect(result.container.querySelector('img, script')).toBeNull();
  });

  it('controls_are_native_buttons', async () => {
    const { result } = await renderScreen();
    for (const b of result.container.querySelectorAll('button')) {
      expect(b.getAttribute('type')).toBe('button');
      expect(b.hasAttribute('tabindex')).toBe(false);
    }
    expect(result.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    for (const name of ['Workspace teams', 'Dev Team']) {
      expect(result.getByRole('region', { name })).toBeTruthy();
    }
  });

  it('home_view_teams_opens_populated_teams_screen', async () => {
    const fake = fakeManagement();
    const result = render(
      <WorkspaceShell
        workspace={workspaceA}
        dashboard={readyApi('x').api}
        management={fake.api}
        connection={{ state: 'connected', error: null, distro: null, command: 'serve' }}
        onSwitchWorkspace={vi.fn()}
      />,
    );
    await act(async () => {});
    fireEvent.click(within(result.getByRole('region', { name: 'Team status' })).getByRole('button', { name: /View teams/ }));
    await act(async () => {});
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Teams');
    expect(result.getByRole('button', { name: 'Teams' }).getAttribute('aria-current')).toBe('page');
    expect(card(result.getByRole('region', { name: 'Workspace teams' }), 'Dev Team')).toBeTruthy();
    expect(fake.overview).toHaveBeenCalledWith('ws-a');
  });
});

describe('live member actions', () => {
  const live = { ...twoTeams().teams[1]!.members[0]!.runtime!, configuredAgents: ['opencode-sonnet', 'codex-gpt'], activeAgent: 'opencode-sonnet', paneState: 'alive', availability: 'idle' };
  const data = (runtime = live) => overviewFixture([team({ runtime: { state: 'running', teamId: 't', status: 'running' }, members: [member({runtime})] })]);
  const confirmation = (id: string) => ({ok: false as const, error: {code: 'BAD_REQUEST', message: 'Member has an active assignment; confirm cancellation of this assignment to switch.', retryable: false, data: {assignmentId: id}}});
  it('exact_assignment_confirmation_and_decline', async () => {
    const call = vi.fn().mockResolvedValue(confirmation('assignment-A'));
    const {result} = await renderScreen({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    const trigger = result.getByRole('button', {name: 'Switch'});
    fireEvent.click(trigger); await act(async () => {});
    const dialog = result.getByRole('dialog');
    expect(dialog.textContent).toContain('assignment-A'); expect(dialog.textContent).toContain('dev'); expect(dialog.textContent).toContain('Codex GPT');
    fireEvent.click(within(dialog).getByText('Cancel')); expect(call).toHaveBeenCalledTimes(1); expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger); await act(async () => {});
    fireEvent.click(result.getByText('Confirm cancellation', {selector: 'button'})); await act(async () => {});
    expect(call).toHaveBeenLastCalledWith('ws-a', 'dev-team', 'dev', 'codex-gpt', {cancelActive: true, assignmentId: 'assignment-A'});
  });
  it('stale_confirmation_requires_new_consent', async () => {
    const call = vi.fn().mockResolvedValueOnce(confirmation('A')).mockResolvedValueOnce(confirmation('B')).mockResolvedValue(confirmation('B'));
    const {result} = await renderScreen({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    fireEvent.click(result.getByRole('button', {name: 'Switch'})); await act(async () => {});
    fireEvent.click(result.getByRole('button', {name: 'Confirm cancellation'})); await act(async () => {});
    expect(call).toHaveBeenCalledTimes(2); expect(result.getByRole('dialog').textContent).toContain('B'); expect(result.getByRole('dialog').textContent).toContain('fresh confirmation');
    fireEvent.click(result.getByRole('button', {name: 'Confirm cancellation'})); await act(async () => {});
    expect(call).toHaveBeenLastCalledWith('ws-a', 'dev-team', 'dev', 'codex-gpt', {cancelActive: true, assignmentId: 'B'});
  });
  it('all_held_and_unknown_reset_display', async () => {
    const {result} = await renderScreen({overview: [{ok: true, data: data({...live, quotaHolds: {'codex-gpt': null, missing: 'bad'}})}]});
    expect(result.getAllByText(/Reset time unknown/)).toHaveLength(2);
    expect(result.getAllByRole('button', {name: 'Resume'})).toHaveLength(2);
    expect(result.getByText('All alternate agents are on quota hold.')).toBeTruthy();
  });
  it('duplicate_switch_blocked', async () => {
    const call = vi.fn(() => new Promise(() => {}));
    const {result} = await renderScreen({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    const trigger = result.getByRole('button', {name: 'Switch'});
    fireEvent.click(trigger); fireEvent.click(trigger);
    expect(call).toHaveBeenCalledTimes(1); expect(result.getAllByText('Requesting…').length).toBeGreaterThan(0);
    expect(call).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'codex-gpt');
  });
  it('inactive_resume_does_not_switch_or_interrupt', async () => {
    const held = {...live, quotaHolds: {'codex-gpt': null}, assignment: {id: 'job', status: 'working', taskId: 'task'}};
    const resume = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', option: 'codex-gpt', cleared: true, activeAgent: 'opencode-sonnet'}});
    const switchCall = vi.fn();
    const {result} = await renderScreen({overview: [{ok: true, data: data(held)}, {ok: true, data: data({...held, quotaHolds: {}})}], calls: {resumeMemberAgent: resume, switchMemberAgent: switchCall}});
    fireEvent.click(result.getByRole('button', {name: 'Resume'})); await act(async () => {});
    expect(result.getByText('Quota hold cleared for inactive option Codex GPT; quota was not verified. The live agent and assignment were not changed.')).toBeTruthy();
    expect(result.container.textContent).toContain('job · working · task'); expect(switchCall).not.toHaveBeenCalled();
  });
  it('keyboard_accessible_dialog_focus_return', async () => {
    const call = vi.fn().mockResolvedValue(confirmation('A'));
    const {result} = await renderScreen({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    const trigger = result.getByRole('button', {name: 'Switch'}); trigger.focus(); fireEvent.click(trigger); await act(async () => {});
    const dialog = result.getByRole('dialog'); const confirm = within(dialog).getByRole('button', {name: 'Confirm cancellation'}); const cancel = within(dialog).getByRole('button', {name: 'Cancel'});
    expect(dialog.getAttribute('aria-modal')).toBe('true'); expect(dialog.getAttribute('aria-labelledby')).toBeTruthy(); expect(dialog.getAttribute('aria-describedby')).toBeTruthy(); expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(confirm, {key: 'Tab', shiftKey: true}); expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, {key: 'Tab'}); expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(confirm, {key: 'Escape'}); expect(document.activeElement).toBe(trigger); expect(call).toHaveBeenCalledTimes(1);
  });

  it('keeps_focus_in_confirmation_while_switch_is_pending', async () => {
    const call = vi.fn().mockResolvedValueOnce(confirmation('A')).mockImplementationOnce(() => new Promise(() => {}));
    const {result} = await renderScreen({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    fireEvent.click(result.getByRole('button', {name: 'Switch'})); await act(async () => {});
    const dialog = result.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', {name: 'Confirm cancellation'}) as HTMLButtonElement;
    const cancel = within(dialog).getByRole('button', {name: 'Cancel'});
    fireEvent.click(confirm); await act(async () => {});
    expect(confirm.disabled).toBe(true);
    cancel.focus();
    expect(fireEvent.keyDown(cancel, {key: 'Tab', shiftKey: true})).toBe(false);
    expect(document.activeElement).toBe(cancel);
    expect(fireEvent.keyDown(cancel, {key: 'Tab'})).toBe(false);
    expect(document.activeElement).toBe(cancel);
  });

  it('eligible_and_disabled_switch_states', async () => {
    const call = vi.fn(() => new Promise(() => {}));
    const {result} = await renderScreen({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    const button = result.getByRole('button', {name: 'Switch'}) as HTMLButtonElement;
    expect(button.disabled).toBe(false); fireEvent.click(button);
    expect(call).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'codex-gpt'); expect(button.disabled).toBe(true);
  });
  it('active_resume_makes_available_when_backend_reports_it', async () => {
    const held = {...live, availability: 'limit_reached', quotaHolds: {'opencode-sonnet': null}};
    const resume = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', option: 'opencode-sonnet', cleared: true, activeAgent: 'opencode-sonnet'}});
    const {result} = await renderScreen({overview: [{ok: true, data: data(held)}, {ok: true, data: data({...held, availability: 'idle', quotaHolds: {}})}], calls: {resumeMemberAgent: resume}});
    fireEvent.click(result.getByRole('button', {name: 'Resume'})); await act(async () => {});
    expect(result.getByText('Quota hold cleared for active option OpenCode Sonnet; quota was not verified. Availability is shown from refreshed backend state.')).toBeTruthy();
    expect(result.getAllByText('Available').length).toBeGreaterThan(0);
  });
  it('disconnected_stale_missing_and_permission_errors', async () => {
    const call = vi.fn().mockResolvedValue({ok: false, error: {code: 'PERMISSION_DENIED', message: 'Denied exactly', remediation: 'Ask an administrator.', retryable: false}});
    const {result} = await renderScreen({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    fireEvent.click(result.getByRole('button', {name: 'Switch'})); await act(async () => {});
    expect(result.container.textContent).toContain('PERMISSION_DENIED: Denied exactly'); expect(result.getByText('Ask an administrator.')).toBeTruthy();
    result.unmount();
    const fake = fakeManagement({overview: [{ok: true, data: data()}]});
    const disconnected = render(<TeamsScreen workspace={workspaceA} management={fake.api} connection={{state: 'lost', error: null, distro: null, command: 'serve'}} />);
    await act(async () => {});
    expect((disconnected.getByRole('button', {name: 'Switch'}) as HTMLButtonElement).disabled).toBe(true);
    expect(disconnected.container.textContent).toContain('Backend disconnected; live actions are disabled.');
    disconnected.unmount();
    const unavailable = await renderScreen({overview: [{ok: true, data: data()}], agents: [{ok: false, error: {code: 'ERROR', message: 'Unavailable', retryable: false}}]});
    expect((unavailable.result.getByRole('button', {name: 'Switch'}) as HTMLButtonElement).disabled).toBe(true);
    expect(unavailable.result.container.textContent).toContain('Agent catalog unavailable; switching is disabled.');
  });
  it('actions_are_scoped_to_team_and_member', async () => {
    const other = team({id: 'other-team', name: 'Other Team', runtime: {state: 'running', teamId: 'other', status: 'running'}, members: [member({runtime: live})]});
    const first = data().teams[0]!;
    const call = vi.fn(() => new Promise(() => {}));
    const {result} = await renderScreen({overview: [{ok: true, data: overviewFixture([first, other])}], calls: {switchMemberAgent: call}});
    fireEvent.click(result.getByRole('button', {name: 'Switch'}));
    fireEvent.click(card(result.getByRole('region', {name: 'Workspace teams'}), 'Other Team'));
    const button = result.getByRole('button', {name: 'Switch'}) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('concurrent_switches_poll_independently', async () => {
    const initial = overviewFixture([team({runtime: {state: 'running', teamId: 't', status: 'running'}, members: [member({runtime: live}), member({memberId: 'qa', name: 'qa', runtime: live})]})]);
    const completed = {...live, lastSwitch: {state: 'completed' as const, requestedAgent: 'codex-gpt', assignmentId: null, code: null, message: null, at: 'new'}};
    const done = overviewFixture([team({runtime: {state: 'running', teamId: 't', status: 'running'}, members: [member({runtime: completed}), member({memberId: 'qa', name: 'qa', runtime: completed})]})]);
    let resolveRead!: (value: {ok: true; data: typeof done}) => void;
    const read = new Promise<{ok: true; data: typeof done}>(resolve => { resolveRead = resolve; });
    const call = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', activeAgent: 'codex-gpt', provider: 'p'}});
    const {result, fake} = await renderScreen({overview: [{ok: true, data: initial}, read, {ok: true, data: done}], calls: {switchMemberAgent: call}});
    vi.useFakeTimers();
    try {
      for (const button of result.getAllByRole('button', {name: 'Switch'})) fireEvent.click(button);
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(fake.overview).toHaveBeenCalledTimes(2);
      await act(async () => { resolveRead({ok: true, data: done}); });
      expect(fake.overview).toHaveBeenCalledTimes(3);
      expect(result.queryByText(/Settings refresh was superseded/)).toBeNull();
      expect(result.getAllByText('Switch to Codex GPT completed.')).toHaveLength(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(fake.overview).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
  it('confirmed_error_preserves_assignment_data', async () => {
    const call = vi.fn().mockResolvedValue(confirmation('assignment-A'));
    const {result} = await renderScreen({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    fireEvent.click(result.getByRole('button', {name: 'Switch'})); await act(async () => {});
    fireEvent.click(result.getByRole('button', {name: 'Confirm cancellation'})); await act(async () => {});
    expect(result.getByRole('alert').textContent).toContain('assignment-A');
  });
  it('pending_completed_and_failed_results', async () => {
    const old = {state: 'completed' as const, requestedAgent: 'codex-gpt', assignmentId: null, code: null, message: null, at: 'old'};
    const pending = {...live, pendingAgent: 'codex-gpt', lastSwitch: {...old, state: 'pending' as const, at: 'new'}};
    const done = {...live, lastSwitch: {...old, at: 'new'}};
    const call = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', activeAgent: 'codex-gpt', provider: 'p'}});
    const {result, fake} = await renderScreen({overview: [{ok: true, data: data({...live, lastSwitch: old})}, {ok: true, data: data({...live, lastSwitch: old})}, {ok: true, data: data(pending)}, {ok: true, data: data(done)}], calls: {switchMemberAgent: call}});
    vi.useFakeTimers();
    try {
      fireEvent.click(result.getByRole('button', {name: 'Switch'})); await act(async () => {});
      expect(fake.overview).toHaveBeenCalledTimes(1);
      expect(result.queryByText('Switch accepted; completion is still pending. Refresh to check again.')).toBeNull();
      expect(result.queryByText('Switch to Codex GPT pending.')).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(fake.overview).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(fake.overview).toHaveBeenCalledTimes(3);
      expect(result.getByText('Switch to Codex GPT pending.')).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(fake.overview).toHaveBeenCalledTimes(4); expect(result.getByText('Switch to Codex GPT completed.')).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(fake.overview).toHaveBeenCalledTimes(4);
    } finally { vi.useRealTimers(); }
  });

  it('failed_projection_stops_polling_and_preserves_backend_details', async () => {
    const failed = {...live, lastSwitch: {state: 'failed' as const, requestedAgent: 'codex-gpt', assignmentId: null, code: 'PROVIDER_UNAVAILABLE', message: 'Provider unavailable', at: 'new'}};
    const call = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', pendingAgent: 'codex-gpt', assignmentId: 'a', cancellation: 'requested'}});
    const {result, fake} = await renderScreen({overview: [{ok: true, data: data()}, {ok: true, data: data(failed)}], calls: {switchMemberAgent: call}});
    vi.useFakeTimers();
    try {
      fireEvent.click(result.getByRole('button', {name: 'Switch'})); await act(async () => {});
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(fake.overview).toHaveBeenCalledTimes(2);
      expect(result.getByText('Switch to Codex GPT failed — PROVIDER_UNAVAILABLE: Provider unavailable')).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });
  it('poll_timeout_retains_pending_projection_and_blocks_another_switch', async () => {
    const pending = {...live, pendingAgent: 'codex-gpt', lastSwitch: {state: 'pending' as const, requestedAgent: 'codex-gpt', assignmentId: 'a', code: null, message: null, at: 'new'}};
    const call = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', pendingAgent: 'codex-gpt', assignmentId: 'a', cancellation: 'requested'}});
    const {result, fake} = await renderScreen({overview: [{ok: true, data: data()}, {ok: true, data: data(pending)}], calls: {switchMemberAgent: call}});
    vi.useFakeTimers();
    try {
      fireEvent.click(result.getByRole('button', {name: 'Switch'})); await act(async () => {});
      for (let i = 0; i < 5; i++) await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(fake.overview).toHaveBeenCalledTimes(6);
      expect(result.getByText('Switch to Codex GPT pending.')).toBeTruthy();
      expect(result.getByText('Switch accepted; completion is still pending. Refresh to check again.')).toBeTruthy();
      const button = result.getByRole('button', {name: 'Switch'}) as HTMLButtonElement;
      expect(button.disabled).toBe(true); fireEvent.click(button); expect(call).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('poll_refresh_error_preserves_backend_details_and_stops_reads', async () => {
    const pending = {...live, pendingAgent: 'codex-gpt'};
    const call = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', pendingAgent: 'codex-gpt', assignmentId: 'a', cancellation: 'requested'}});
    const error = {code: 'READ_FAILED', message: 'State is unavailable.', remediation: 'Retry the read.', retryable: true};
    const {result, fake} = await renderScreen({overview: [{ok: true, data: data()}, {ok: true, data: data(pending)}, {ok: false, error}], calls: {switchMemberAgent: call}});
    vi.useFakeTimers();
    try {
      fireEvent.click(result.getByRole('button', {name: 'Switch'}));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(result.getByText('Switch to Codex GPT pending.')).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(fake.overview).toHaveBeenCalledTimes(3);
      expect(result.getAllByRole('alert')[0]!.textContent).toContain('READ_FAILED: State is unavailable.');
      expect(result.getAllByRole('alert')[0]!.textContent).toContain('Retry the read.');
      expect(result.getByText('Switch to Codex GPT pending.')).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(fake.overview).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
  it('resume_without_clearing_reports_no_quota_verification', async () => {
    const held = {...live, quotaHolds: {'codex-gpt': null}};
    const resume = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', option: 'codex-gpt', cleared: false, activeAgent: 'opencode-sonnet'}});
    const {result} = await renderScreen({overview: [{ok: true, data: data(held)}], calls: {resumeMemberAgent: resume}});
    fireEvent.click(result.getByRole('button', {name: 'Resume'})); await act(async () => {});
    expect(result.getByText('No recorded quota hold was cleared for Codex GPT; quota was not verified.')).toBeTruthy();
    expect(result.getByRole('button', {name: 'Resume'})).toBeTruthy();
  });
  it('resume_waits_for_backend_refresh_and_locks_other_member_actions', async () => {
    const held = {...live, availability: 'limit_reached', quotaHolds: {'opencode-sonnet': null}, assignment: {id: 'job', status: 'working', taskId: 'task'}};
    let resolveRefresh!: (value: {ok: true; data: ReturnType<typeof data>}) => void;
    const refresh = new Promise<{ok: true; data: ReturnType<typeof data>}>(resolve => { resolveRefresh = resolve; });
    const resume = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', option: 'opencode-sonnet', cleared: true, activeAgent: 'opencode-sonnet'}});
    const switchCall = vi.fn();
    const {result} = await renderScreen({overview: [{ok: true, data: data(held)}, refresh], calls: {resumeMemberAgent: resume, switchMemberAgent: switchCall}});
    fireEvent.click(result.getByRole('button', {name: 'Resume'})); await act(async () => {});
    expect(result.container.textContent).toContain('limit_reached');
    expect(result.container.textContent).toContain('job · working · task');
    expect((result.getByRole('button', {name: 'Switch'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(result.getByRole('button', {name: 'Switch'}));
    expect(switchCall).not.toHaveBeenCalled();
    expect(result.queryByText(/Quota hold cleared for active option/)).toBeNull();
    await act(async () => { resolveRefresh({ok: true, data: data({...held, availability: 'idle', quotaHolds: {}})}); });
    expect(result.getByText('Quota hold cleared for active option OpenCode Sonnet; quota was not verified. Availability is shown from refreshed backend state.')).toBeTruthy();
  });
  it('backend_error_data_is_rendered_as_text', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const call = vi.fn().mockResolvedValue({ok: false, error: {code: 'PERMISSION_DENIED', message: payload, remediation: payload, data: {assignmentId: payload}, retryable: false}});
    const {result} = await renderScreen({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    fireEvent.click(result.getByRole('button', {name: 'Switch'})); await act(async () => {});
    expect(result.getByRole('alert').textContent).toContain(payload);
    expect(result.getByRole('alert').querySelector('img')).toBeNull();
  });
  it('provider_unavailable_is_rendered_verbatim', async () => {
    const call = vi.fn().mockResolvedValue({ok: false, error: {code: 'PROVIDER_UNAVAILABLE', message: "Provider 'codex' is not ready: offline", remediation: 'Start the provider.', retryable: false}});
    const {result} = await renderScreen({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    fireEvent.click(result.getByRole('button', {name: 'Switch'})); await act(async () => {});
    expect(result.container.textContent).toContain("PROVIDER_UNAVAILABLE: Provider 'codex' is not ready: offline");
    expect(result.getByText('Start the provider.')).toBeTruthy();
  });
  it('backend_switch_errors_are_shown_without_rewriting', async () => {
    const errors = [
      ['BAD_REQUEST', 'A switch is already pending for this member.'],
      ['BAD_REQUEST', "Agent 'codex-gpt' is on quota hold."],
      ['BAD_REQUEST', 'That agent is already active; use board resume when its quota resets.'],
      ['BAD_REQUEST', "The member's pane is not alive."],
      ['BAD_REQUEST', 'Member must be idle or quota-limited before switching.'],
      ['BAD_REQUEST', "Agent 'codex-gpt' is not configured for member 'dev'."],
      ['TEAM_CONFIG_INVALID', "Agent 'codex-gpt' is missing from the catalog."],
      ['TEAM_NOT_RUNNING', "Team 'dev-team' is not running."],
      ['MEMBER_NOT_FOUND', "No running member 'dev' in team 'dev-team'."],
    ];
    for (const [code, message] of errors) {
      const call = vi.fn().mockResolvedValue({ok: false, error: {code, message, remediation: 'Retry exactly as directed.', retryable: false}});
      const {result} = await renderScreen({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
      fireEvent.click(result.getByRole('button', {name: 'Switch'}));
      await act(async () => {});
      expect(result.getByRole('alert').textContent).toContain(`${code}: ${message}`);
      expect(result.getByRole('alert').textContent).toContain('Retry exactly as directed.');
      expect(result.queryByRole('dialog')).toBeNull();
      result.unmount();
    }
  });
  it('resume_error_preserves_backend_message_and_hold', async () => {
    const held = {...live, quotaHolds: {'codex-gpt': null}};
    const resume = vi.fn().mockResolvedValue({ok: false, error: {code: 'INTERNAL', message: "The member's quota holds are invalid; no hold was cleared.", remediation: 'Inspect holds.', retryable: false}});
    const {result} = await renderScreen({overview: [{ok: true, data: data(held)}], calls: {resumeMemberAgent: resume}});
    fireEvent.click(result.getByRole('button', {name: 'Resume'}));
    await act(async () => {});
    expect(result.getByRole('alert').textContent).toContain("INTERNAL: The member's quota holds are invalid; no hold was cleared.");
    expect(result.getByRole('alert').textContent).toContain('Inspect holds.');
    expect(result.getByRole('button', {name: 'Resume'})).toBeTruthy();
  });
  it('changed_assignment_refocuses_confirmation', async () => {
    const call = vi.fn().mockResolvedValueOnce(confirmation('A')).mockResolvedValueOnce(confirmation('B'));
    const {result} = await renderScreen({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    fireEvent.click(result.getByRole('button', {name: 'Switch'})); await act(async () => {});
    fireEvent.click(result.getByRole('button', {name: 'Confirm cancellation'})); await act(async () => {});
    expect(document.activeElement).toBe(result.getByRole('button', {name: 'Confirm cancellation'}));
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('disabled_states_and_missing_catalog_are_visible', async () => {
    for (const [runtime, reason] of [
      [{...live, stale: true}, 'Live member state is stale; refresh before switching or resuming.'],
      [{...live, paneState: 'dead'}, "The member's pane is not alive."],
      [{...live, pendingAgent: 'codex-gpt'}, 'A switch is already pending for this member.'],
      [{...live, quotaHolds: {'codex-gpt': null}}, "Agent 'codex-gpt' is on quota hold."],
    ] as const) {
      const {result} = await renderScreen({overview: [{ok: true, data: data(runtime)}]});
      expect((result.getByRole('button', {name: 'Switch'}) as HTMLButtonElement).disabled).toBe(true);
      expect(result.getAllByText(reason).length).toBeGreaterThan(0);
      result.unmount();
    }
    const {result} = await renderScreen({overview: [{ok: true, data: data()}], agents: [{ok: true, data: catalogFixture({agents: []})}]});
    expect((result.getByRole('button', {name: 'Switch'}) as HTMLButtonElement).disabled).toBe(true);
    expect(result.getByText("Agent 'codex-gpt' is missing from the catalog.")).toBeTruthy();
  });
  it('inline_member_has_no_live_actions', async () => {
    const inline = member({agentMode: 'inline', source: 'inline', runtime: live});
    const {result} = await renderScreen({overview: [{ok: true, data: overviewFixture([team({runtime: {state: 'running', teamId: 't', status: 'running'}, members: [inline]})])}]});
    expect(result.queryByRole('button', {name: 'Switch'})).toBeNull();
    expect(result.queryByRole('button', {name: 'Resume'})).toBeNull();
  });
  it('refresh_failure_after_switch_preserves_backend_error', async () => {
    const call = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', activeAgent: 'codex-gpt', provider: 'p'}});
    const {result, fake} = await renderScreen({overview: [{ok: true, data: data()}, {ok: false, error: {code: 'REFRESH_ERROR', message: 'Read failed', remediation: 'Retry the read.', retryable: true}}], calls: {switchMemberAgent: call}});
    vi.useFakeTimers();
    try {
      fireEvent.click(result.getByRole('button', {name: 'Switch'})); await act(async () => {});
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(fake.overview).toHaveBeenCalledTimes(2);
      expect(result.container.textContent).toContain('REFRESH_ERROR: Read failed');
      expect(result.getAllByText('Retry the read.').length).toBeGreaterThan(0);
    } finally { vi.useRealTimers(); }
  });

  it('unmount_cancels_outstanding_switch_poll_timer', async () => {
    const call = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', activeAgent: 'codex-gpt', provider: 'p'}});
    const {result, fake} = await renderScreen({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    vi.useFakeTimers();
    try {
      fireEvent.click(result.getByRole('button', {name: 'Switch'}));
      await act(async () => {});
      result.unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(fake.overview).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('workspace_change_cancels_outstanding_switch_poll_timer', async () => {
    const call = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', activeAgent: 'codex-gpt', provider: 'p'}});
    const {result, fake} = await renderScreen({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    vi.useFakeTimers();
    try {
      fireEvent.click(result.getByRole('button', {name: 'Switch'}));
      await act(async () => {});
      result.rerender(<TeamsScreen workspace={{...workspaceA, id: 'ws-b'}} management={fake.api} />);
      await act(async () => {});
      expect(fake.overview).toHaveBeenCalledTimes(2);
      expect(fake.overview).toHaveBeenLastCalledWith('ws-b');
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(fake.overview).toHaveBeenCalledTimes(2);
      expect(result.queryByText('Switch accepted; completion is still pending. Refresh to check again.')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('held_missing_catalog_option_can_be_resumed', async () => {
    const held = {...live, configuredAgents: ['opencode-sonnet', 'missing'], quotaHolds: {missing: null}};
    const resume = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', option: 'missing', cleared: true, activeAgent: 'opencode-sonnet'}});
    const {result} = await renderScreen({overview: [{ok: true, data: data(held)}, {ok: true, data: data({...held, quotaHolds: {}})}], calls: {resumeMemberAgent: resume}});
    expect(result.getByText("Agent 'missing' is missing from the catalog.")).toBeTruthy();
    fireEvent.click(result.getByRole('button', {name: 'Resume'}));
    await act(async () => {});
    expect(resume).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'missing');
    expect(result.getByText('Quota hold cleared for inactive option missing; quota was not verified. The live agent and assignment were not changed.')).toBeTruthy();
  });

  it('live_actions_use_frozen_options_and_runtime_metadata', async () => {
    const runtime = {...live, configuredAgents: ['opencode-sonnet', 'removed', 'codex-gpt'], provider: 'actual-provider', model: 'actual-model', reasoning: 'high', quotaHolds: {removed: null, extra: null}};
    const saved = member({runtime, defaultAgent: 'saved-only', provider: 'saved-provider', model: 'saved-model'});
    const {result} = await renderScreen({overview: [{ok: true, data: overviewFixture([team({runtime: {state: 'running', teamId: 't', status: 'running'}, members: [saved]})])}]});
    const actions = within(result.getByRole('region', {name: 'Live agent actions for dev'}));
    expect(actions.getByText('opencode-sonnet · actual-provider · actual-model · Reasoning: high')).toBeTruthy();
    expect(actions.queryByText(/saved-provider|saved-model|saved-only/)).toBeNull();
    const rows = actions.getAllByRole('listitem');
    expect(rows.map(row => row.textContent)).toEqual([
      expect.stringContaining('OpenCode Sonnet · Active'),
      expect.stringContaining('removed · Reset time unknown'),
      expect.stringContaining('Codex GPT'),
      expect.stringContaining('extra · Reset time unknown'),
    ]);
    expect(within(rows[1]!).getByRole('button', {name: 'Resume'})).toBeTruthy();
    expect(within(rows[3]!).getByRole('button', {name: 'Resume'})).toBeTruthy();
    expect(within(rows[3]!).queryByRole('button', {name: 'Switch'})).toBeNull();
  });

  it('pending_switch_still_allows_resume_of_an_inactive_hold', async () => {
    const held = {...live, pendingAgent: 'codex-gpt', quotaHolds: {'codex-gpt': null}};
    const resume = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', option: 'codex-gpt', cleared: false, activeAgent: 'opencode-sonnet'}});
    const {result} = await renderScreen({overview: [{ok: true, data: data(held)}], calls: {resumeMemberAgent: resume}});
    expect((result.getByRole('button', {name: 'Switch'}) as HTMLButtonElement).disabled).toBe(true);
    const button = result.getByRole('button', {name: 'Resume'}) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button); await act(async () => {});
    expect(resume).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'codex-gpt');
    expect(result.getByText('Switch to Codex GPT pending.')).toBeTruthy();
  });

});
