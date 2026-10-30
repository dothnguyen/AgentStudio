// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { WorkspaceShell } from '../src/renderer/shell/WorkspaceShell';
import { TeamsScreen } from '../src/renderer/teams/TeamsScreen';
import { roleItem, rolesFixture } from './rolesFixtures';
import { readyApi, workspaceA } from './dashboardFixtures';
import { catalogFixture, fakeManagement, member, overviewFixture, team, twoTeams, openMember, showMembers, memberRow, field } from './teamsFixtures';

afterEach(cleanup);

async function renderScreen(opts: Parameters<typeof fakeManagement>[0] = {}) {
  const fake = fakeManagement(opts);
  const result = render(<TeamsScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  return { fake, result };
}

const tab = (r: { getByRole: (role: string, o: { name: string }) => HTMLElement }, name: string) => r.getByRole('tab', { name });
async function openTab(r: { getByRole: (role: string, o: { name: string }) => HTMLElement }, name: string) {
  fireEvent.click(tab(r, name));
  await act(async () => {});
}
async function renderMembers(opts: Parameters<typeof fakeManagement>[0] = {}) {
  const out = await renderScreen(opts);
  await openTab(out.result, 'Members');
  return out;
}

const cardNames = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('.teams-card-name')).map((n) => n.textContent);
const card = (root: HTMLElement, name: string) =>
  within(root).getByRole('button', { name: new RegExp(`^${name}`) });

describe('TeamsScreen', () => {
  it('defined_member_shows_role_metadata_and_deep_link', async () => {
    const onViewRole = vi.fn();
    const fake = fakeManagement({
      overview: [{ ok: true, data: overviewFixture([team({ members: [member({ role: 'qa-b' })] })]) }],
      roles: [{ ok: true, data: rolesFixture({ items: [roleItem('qa-a', { name: 'QA' }), roleItem('qa-b', { name: 'QA', description: 'Second QA' })] }) }],
    });
    const result = render(<TeamsScreen workspace={workspaceA} management={fake.api} onViewRole={onViewRole} />);
    await act(async () => {});
    await openTab(result, 'Members');
    openMember('dev');
    const row = result.getByRole('region', { name: 'dev' });
    expect(row.textContent).toContain('qa-b');
    expect(row.textContent).toContain('Second QA');
    expect(result.getByText(/Changes to name, role, ticket permission/)).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'View QA in Roles' }));
    expect(onViewRole).toHaveBeenCalledWith('qa-b');
    expect(onViewRole).toHaveBeenCalledTimes(1);
  });

  it('undefined_or_unavailable_role_has_diagnostic_without_link', async () => {
    const overview = overviewFixture([team({ members: [member({ role: 'retired' }), member({ memberId: 'x', name: 'x', role: 'Developer', roleState: 'undefined' })] })]);
    const missing = await renderMembers({ overview: [{ ok: true, data: overview }] });
    expect(missing.result.queryByRole('button', { name: /in Roles/ })).toBeNull();
    missing.result.unmount();
    const failed = await renderMembers({ roles: [{ ok: false, error: { code: 'INTERNAL', message: 'roles down', retryable: false } }] });
    expect(failed.result.queryByRole('button', { name: /in Roles/ })).toBeNull();
    expect(failed.result.getByRole('button', { name: 'Retry loading roles' })).toBeTruthy();
    const row = openMember('dev');
    expect(row.textContent).toContain('Developer');
    expect(row.textContent).toContain('OpenCode Sonnet');
    expect(failed.result.getByRole('button', { name: 'Edit dev' })).toBeTruthy();
  });

  it('saved_options_are_distinct_from_live_agent', async () => {
    const live = twoTeams().teams[1]!.members[0]!.runtime!;
    const saved = {id: 'saved', name: 'Saved choice', provider: 'saved-provider', model: 'saved-model', reasoning: null, description: null, state: 'ok' as const};
    const m = member({agentMode: 'ordered_catalog', agentOptions: [saved], defaultAgent: 'saved', runtime: {...live, activeAgent: 'live-id', provider: 'live-provider', model: 'live-model'}});
    const {result} = await renderMembers({overview: [{ok: true, data: overviewFixture([team({members: [m]})])}]});
    const row = openMember('dev');
    const savedText = within(row).getByRole('list', {name: 'Saved agent options'}).textContent;
    expect(savedText).toBe('Default — Saved choice · saved-provider · saved-model');
    expect(row.textContent).toContain('Active agent: live-id · live-provider · live-model');
    expect(savedText).not.toContain('live-id');
  });

  it('saved_options_keep_order_and_live_reasoning_uses_runtime_values', async () => {
    const live = twoTeams().teams[1]!.members[0]!.runtime!;
    const first = {id: 'first', name: 'First', provider: 'saved-provider', model: 'saved-model', reasoning: 'low', description: null, state: 'ok' as const};
    const missing = {id: 'gone', name: null, provider: null, model: null, reasoning: null, description: null, state: 'missing' as const};
    const m = member({agentMode: 'ordered_catalog', agentOptions: [first, missing], defaultAgent: 'first', runtime: {...live, activeAgent: 'live-id', provider: 'live-provider', model: 'live-model', reasoning: 'high'}});
    const {result} = await renderMembers({overview: [{ok: true, data: overviewFixture([team({members: [m]})])}]});
    const row = openMember('dev');
    const savedCell = within(row).getByRole('list', {name: 'Saved agent options'});
    const items = within(savedCell).getAllByRole('listitem');
    expect(items.map(item => item.textContent)).toEqual([
      'Default — First · saved-provider · saved-model · Reasoning: low',
      'gone · Not available · Missing from catalog',
    ]);
    expect(row.textContent).toContain('live-id · live-provider · live-model · Reasoning: high');
  });

  it('renders_teams_and_members_from_overview', async () => {
    const { fake, result } = await renderScreen();
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Teams');
    const list = result.getByRole('region', { name: 'Workspace teams' });
    expect(cardNames(list)).toEqual(['Dev Team', 'Release Team']);
    expect(card(list, 'Dev Team').getAttribute('aria-pressed')).toBe('true');
    const detail = result.getByRole('region', { name: 'Dev Team' });
    expect(detail.textContent).toContain('Running');
    expect(detail.textContent).toContain('t-1');
    await openTab(result, 'Members');
    const r1 = openMember('dev').textContent;
    expect(r1).toContain('Default — OpenCode Sonnet · opencode · sonnet');
    expect(r1).toContain('T-031 Teams screen');
    fireEvent.click(result.getByRole('button', { name: 'Back to members' }));
    const r2 = openMember('lead').textContent;
    expect(r2).toContain('Inline agent — codex · model not set');
    expect(r2).toContain('No current work');
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
    await openTab(result, 'Members');
    const detail = result.getByRole('region', { name: 'Release Team' });
    expect(within(detail).getByRole('heading', { level: 2 }).textContent).toBe('Release Team');
    const row = openMember('qa');
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
    await openTab(result, 'Members');
    fireEvent.click(result.getByRole('button', { name: 'Add member' }));
    expect(result.getByRole('option', { name: 'OpenCode Sonnet (opencode-sonnet)' })).toBeTruthy();
  });

  it('keeps members visible and catalog choices unavailable when catalog loading fails', async () => {
    const { result } = await renderScreen({ agents: [{ ok: false, error: { code: 'CATALOG_FAIL', message: 'failed', retryable: true } }] });
    await openTab(result, 'Members');
    const detail = result.getByRole('region', { name: 'Dev Team' });
    expect(memberRow('dev').textContent).toContain('dev');
    fireEvent.click(result.getByRole('button', { name: 'Add member' }));
    expect(result.queryByRole('option', { name: 'OpenCode Sonnet (opencode-sonnet)' })).toBeNull();
    expect(memberRow('dev').textContent).toContain('dev');
  });

  it('empty_workspace_shows_empty_states_and_no_sample_agents', async () => {
    const { result } = await renderScreen({
      overview: [{ ok: true, data: overviewFixture([]) }],
      agents: [{ ok: true, data: catalogFixture({ agents: [] }) }],
    });
    expect(result.getByText('No teams defined in this workspace.')).toBeTruthy();
    expect(result.queryByRole('table')).toBeNull();
    expect(result.queryByRole('tablist')).toBeNull();
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
    await openTab(result, 'Members');
    const row = openMember('m1');
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
    expect(hits).toHaveLength(3);
    for (const h of hits) expect(h.textContent).toBe(long);
    expect(result.getByText('16+ members', { selector: '.teams-card-facts' })).toBeTruthy();
    await openTab(result, 'Members');
    expect(result.getByText('Showing the first 16 members.')).toBeTruthy();
    expect(result.getByText('Showing the first 1 team. More teams exist in this workspace.')).toBeTruthy();
  });

  it('loading_states_are_announced', async () => {
    const never = new Promise<never>(() => {});
    const { result } = await renderScreen({ overview: [never], agents: [never] });
    const texts = result.getAllByRole('status').map((s) => s.textContent);
    expect(texts).toContain('Loading teams…');
    expect(result.queryByRole('tablist')).toBeNull();
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
      if (b.matches('[role="tab"], .teams-card')) expect(['0', '-1']).toContain(b.getAttribute('tabindex'));
      else expect(b.hasAttribute('tabindex')).toBe(false);
    }
    for (const sel of ['[role="tab"]', '.teams-card']) {
      expect(Array.from(result.container.querySelectorAll(sel)).filter((b) => b.getAttribute('tabindex') === '0')).toHaveLength(1);
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
    expect(result.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
    expect(result.getByRole('button', { name: 'Teams' }).getAttribute('aria-current')).toBe('page');
    expect(card(result.getByRole('region', { name: 'Workspace teams' }), 'Dev Team')).toBeTruthy();
    expect(fake.overview).toHaveBeenCalledWith('ws-a');
  });
});

describe('live member actions', () => {
  const renderLive = async (opts: Parameters<typeof fakeManagement>[0] = {}) => { const out = await renderMembers(opts); openMember('dev'); return out; };
  const live = { ...twoTeams().teams[1]!.members[0]!.runtime!, configuredAgents: ['opencode-sonnet', 'codex-gpt'], activeAgent: 'opencode-sonnet', paneState: 'alive', availability: 'idle' };
  const data = (runtime = live) => overviewFixture([team({ runtime: { state: 'running', teamId: 't', status: 'running' }, members: [member({runtime})] })]);
  const confirmation = (id: string) => ({ok: false as const, error: {code: 'BAD_REQUEST', message: 'Member has an active assignment; confirm cancellation of this assignment to switch.', retryable: false, data: {assignmentId: id}}});
  it('member_detail_separates_saved_and_frozen_evidence_from_compact_list', async () => {
    const runtime = {...live, assignment: {id: 'assignment-1', status: 'working', taskId: 'task-1'}, pendingAgent: 'codex-gpt', lastSwitch: {state: 'failed' as const, requestedAgent: 'codex-gpt', assignmentId: 'assignment-1', code: 'PROVIDER_UNAVAILABLE', message: 'offline', at: 'now'}};
    const {result} = await renderMembers({overview: [{ok: true, data: data(runtime)}]});
    expect(result.queryByRole('button', {name: 'Switch'})).toBeNull();
    expect(result.queryByRole('button', {name: 'Resume'})).toBeNull();
    const detail = openMember('dev');
    expect(detail.textContent).toContain('Agent options — next team start');
    expect(detail.textContent).toContain('Live agent options — frozen at team start');
    expect(detail.textContent).toContain('assignment-1 · working · task-1');
    expect(detail.textContent).toContain('Switch to Codex GPT pending.');
    expect(detail.textContent).toContain('PROVIDER_UNAVAILABLE: offline');
  });
  it('no_runtime_inline_and_single_option_have_no_invalid_switch', async () => {
    for (const m of [member({runtime: null}), member({runtime: live, agentMode: 'inline'}), member({runtime: {...live, configuredAgents: ['opencode-sonnet']}})]) {
      const {result} = await renderMembers({overview: [{ok: true, data: overviewFixture([team({runtime: {state: 'running', teamId: 't', status: 'running'}, members: [m]})])}]});
      const detail = openMember('dev');
      expect(within(detail).queryByRole('button', {name: 'Switch'})).toBeNull();
      if (!m.runtime || m.agentMode === 'inline') expect(detail.textContent).toContain('Live controls are unavailable because this member has no running runtime record.');
      else expect(detail.textContent).toContain('Active agent:');
      result.unmount();
    }
  });

});

describe('focused navigation', () => {
  const selectedTabs = (r: ReturnType<typeof render>) => r.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent);
  const list = (r: ReturnType<typeof render>) => r.getByRole('region', { name: 'Workspace teams' });
  const reordered = () => {
    const data = twoTeams();
    const byName = (n: string) => data.teams.find((t) => t.name === n)!;
    byName('Dev Team').runtime = { state: 'stopped', teamId: 't-1', status: 'stopped' };
    byName('Release Team').runtime = { state: 'running', teamId: 't-2', status: 'running' };
    return data;
  };

  it('initial_selection_is_first_ordered_team_on_overview', async () => {
    const { result } = await renderScreen();
    expect(card(list(result), 'Dev Team').getAttribute('aria-pressed')).toBe('true');
    const tablist = result.getByRole('tablist', { name: 'Dev Team views' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Overview', 'Members', 'Routing']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    const panels = result.getAllByRole('tabpanel');
    expect(panels).toHaveLength(1);
    expect(panels[0]!.id).toBe('teams-panel-overview');
    expect(panels[0]!.getAttribute('aria-labelledby')).toBe('teams-tab-overview');
    expect(panels[0]!.textContent).toContain('Running');
    expect(panels[0]!.textContent).toContain('Board control');
    expect(result.queryByRole('table')).toBeNull();
    expect(result.queryByRole('region', { name: 'Workspace board routing' })).toBeNull();
  });

  it('members_and_routing_tabs_show_exactly_one_panel', async () => {
    const { result } = await renderScreen();
    await openTab(result, 'Members');
    expect(result.getAllByRole('tabpanel')).toHaveLength(1);
    expect(within(result.getByRole('tabpanel')).getByRole('list', { name: /^Members of / })).toBeTruthy();
    expect(within(result.getByRole('tabpanel')).queryByRole('heading', { name: 'Board control' })).toBeNull();
    await openTab(result, 'Routing');
    expect(result.getAllByRole('tabpanel')).toHaveLength(1);
    expect(within(result.getByRole('tabpanel')).getByRole('region', { name: 'Workspace board routing' })).toBeTruthy();
    expect(result.queryByRole('table')).toBeNull();
  });

  it('tab_keyboard_moves_focus_selection_and_wraps', async () => {
    const { result } = await renderScreen();
    tab(result, 'Overview').focus();
    const steps: Array<[string, string]> = [
      ['ArrowRight', 'Members'], ['ArrowRight', 'Routing'], ['ArrowRight', 'Overview'],
      ['ArrowLeft', 'Routing'], ['Home', 'Overview'], ['End', 'Routing'],
    ];
    for (const [key, name] of steps) {
      fireEvent.keyDown(document.activeElement!, { key });
      expect(document.activeElement).toBe(tab(result, name));
      expect(selectedTabs(result)).toEqual([name]);
      expect(result.getAllByRole('tab').filter((t) => t.tabIndex === 0)).toHaveLength(1);
      const selected = tab(result, name);
      expect(result.getByRole('tabpanel').id).toBe(selected.getAttribute('aria-controls'));
    }
    expect(fireEvent.keyDown(tab(result, 'Routing'), { key: 'ArrowDown' })).toBe(true);
    expect(selectedTabs(result)).toEqual(['Routing']);
  });

  it('team_chooser_roving_focus_and_keyboard', async () => {
    const { result } = await renderScreen();
    const root = list(result);
    expect(root.querySelector('ul')!.getAttribute('aria-label')).toBe('Choose a team');
    expect(card(root, 'Dev Team').tabIndex).toBe(0);
    expect(card(root, 'Release Team').tabIndex).toBe(-1);
    card(root, 'Dev Team').focus();
    const steps: Array<[string, string]> = [
      ['ArrowDown', 'Release Team'], ['ArrowDown', 'Dev Team'], ['ArrowUp', 'Release Team'], ['Home', 'Dev Team'], ['End', 'Release Team'],
    ];
    for (const [key, name] of steps) {
      fireEvent.keyDown(document.activeElement!, { key });
      expect(card(root, name).getAttribute('aria-pressed')).toBe('true');
      expect(document.activeElement).toBe(card(root, name));
      expect(card(root, name).tabIndex).toBe(0);
      expect(result.getByRole('region', { name })).toBeTruthy();
    }
    expect(fireEvent.keyDown(card(root, 'Release Team'), { key: 'ArrowRight' })).toBe(true);
    expect(card(root, 'Release Team').getAttribute('aria-pressed')).toBe('true');
  });

  it('selecting_a_new_team_returns_to_overview', async () => {
    const { result } = await renderScreen();
    await openTab(result, 'Members');
    fireEvent.click(card(list(result), 'Release Team'));
    expect(card(list(result), 'Release Team').getAttribute('aria-pressed')).toBe('true');
    expect(selectedTabs(result)).toEqual(['Overview']);
    await openTab(result, 'Members');
    fireEvent.click(card(list(result), 'Release Team'));
    expect(selectedTabs(result)).toEqual(['Members']);
  });

  it('refresh_reorder_preserves_selection_and_view', async () => {
    const { result } = await renderScreen({ overview: [{ ok: true, data: twoTeams() }, { ok: true, data: reordered() }] });
    fireEvent.click(card(list(result), 'Release Team'));
    await openTab(result, 'Members');
    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    await act(async () => {});
    expect(cardNames(list(result))).toEqual(['Release Team', 'Dev Team']);
    expect(card(list(result), 'Release Team').getAttribute('aria-pressed')).toBe('true');
    expect(selectedTabs(result)).toEqual(['Members']);
    expect(within(result.getByRole('region', { name: 'Release Team' })).getByRole('list', { name: /^Members of / })).toBeTruthy();
  });

  it('refresh_removal_falls_back_to_first_team_overview', async () => {
    const { result } = await renderScreen({ overview: [{ ok: true, data: twoTeams() }, { ok: true, data: overviewFixture([twoTeams().teams[1]!]) }] });
    fireEvent.click(card(list(result), 'Release Team'));
    await openTab(result, 'Members');
    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    await act(async () => {});
    expect(cardNames(list(result))).toEqual(['Dev Team']);
    expect(card(list(result), 'Dev Team').getAttribute('aria-pressed')).toBe('true');
    expect(selectedTabs(result)).toEqual(['Overview']);
  });

  it('refresh_to_empty_workspace_hides_selected_team_ui', async () => {
    const { result } = await renderScreen({ overview: [{ ok: true, data: twoTeams() }, { ok: true, data: overviewFixture([]) }] });
    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    await act(async () => {});
    expect(result.getByText('No teams defined in this workspace.')).toBeTruthy();
    expect(result.queryByRole('tablist')).toBeNull();
    expect(result.queryAllByRole('tabpanel')).toHaveLength(0);
    expect(result.queryByRole('region', { name: 'Workspace board routing' })).toBeNull();
    for (const name of ['New team', 'Refresh']) expect((result.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('overview_error_after_refresh_retains_selection_and_view', async () => {
    const { result } = await renderScreen({ overview: [{ ok: true, data: twoTeams() }, { ok: false, error: { code: 'INTERNAL', message: 'boom', retryable: true } }] });
    fireEvent.click(card(list(result), 'Release Team'));
    await openTab(result, 'Members');
    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    await act(async () => {});
    expect(within(list(result)).getByRole('alert').textContent).toContain('INTERNAL: boom');
    expect(card(list(result), 'Release Team').getAttribute('aria-pressed')).toBe('true');
    expect(selectedTabs(result)).toEqual(['Members']);
  });

  it('workspace_change_resets_selection_and_view', async () => {
    const fake = fakeManagement({ overview: [{ ok: true, data: twoTeams() }, { ok: true, data: overviewFixture([team({ id: 'ops', name: 'Ops Team' })]) }] });
    const result = render(<TeamsScreen workspace={workspaceA} management={fake.api} />);
    await act(async () => {});
    fireEvent.click(card(list(result), 'Release Team'));
    await openTab(result, 'Members');
    result.rerender(<TeamsScreen workspace={{ ...workspaceA, id: 'ws-b' }} management={fake.api} />);
    await act(async () => {});
    expect(card(list(result), 'Ops Team').getAttribute('aria-pressed')).toBe('true');
    expect(selectedTabs(result)).toEqual(['Overview']);
    expect(fake.overview).toHaveBeenLastCalledWith('ws-b');
  });

  it('tab_and_team_changes_issue_no_management_reads', async () => {
    const { fake, result } = await renderScreen();
    for (const name of ['Members', 'Routing', 'Overview']) await openTab(result, name);
    tab(result, 'Overview').focus();
    for (const key of ['ArrowRight', 'ArrowRight', 'ArrowRight', 'Home', 'End']) fireEvent.keyDown(document.activeElement!, { key });
    fireEvent.click(card(list(result), 'Release Team'));
    fireEvent.keyDown(document.activeElement ?? card(list(result), 'Release Team'), { key: 'ArrowDown' });
    fireEvent.keyDown(card(list(result), 'Release Team'), { key: 'ArrowUp' });
    await act(async () => {});
    for (const fn of [fake.overview, fake.agents, fake.boardSettings, fake.roles]) expect(fn).toHaveBeenCalledTimes(1);
  });

  it('global_status_and_feedback_stay_outside_tab_panels', async () => {
    const fake = fakeManagement({
      roles: [{ ok: false, error: { code: 'INTERNAL', message: 'roles down', retryable: false } }],
      overview: [{ ok: true, data: overviewFixture(twoTeams().teams, { truncated: true }) }],
      calls: { createTeam: vi.fn(async () => ({ ok: false as const, error: { code: 'BAD_REQUEST', message: 'dup', retryable: false } })) },
    });
    const result = render(<TeamsScreen workspace={workspaceA} management={fake.api} connection={{ state: 'lost', error: null, distro: null, command: 'serve' }} />);
    await act(async () => {});
    fireEvent.click(result.getByRole('button', { name: 'New team' }));
    fireEvent.change(result.getByLabelText('Team name'), { target: { value: 'X' } });
    fireEvent.click(result.getByRole('button', { name: 'Create team' }));
    await act(async () => {});
    for (const name of ['Overview', 'Members', 'Routing']) {
      await openTab(result, name);
      const panel = result.getByRole('tabpanel');
      const outside = [
        result.getByRole('list', { name: 'Data notices' }),
        result.getByRole('button', { name: 'Retry loading roles' }),
        result.getByText(/Connection to the backend was lost\./),
        result.getAllByRole('alert').find((a) => a.textContent?.includes('BAD_REQUEST: dup'))!,
        result.getByRole('button', { name: 'New team' }),
        result.getByRole('button', { name: 'Refresh' }),
      ];
      for (const el of outside) {
        expect(el).toBeTruthy();
        expect(panel.contains(el)).toBe(false);
      }
    }
  });
});

describe('team overview', () => {
  const panel = () => screen.getByRole('tabpanel', { name: 'Overview' });
  const summary = () => within(panel()).getByRole('list', { hidden: true, name: 'Member availability' });

  it('overview_shows_definition_runtime_members_and_coordinator', async () => {
    await renderScreen();
    const facts = within(panel()).getByLabelText('Team summary').textContent ?? '';
    for (const text of ['Dev Team', 'dev-team', 'Valid', 'Running', 't-1', '2 members', '1 Working', '1 Available', 'Available']) {
      expect(facts).toContain(text);
    }
    expect(summary()).toBeTruthy();
    expect(within(panel()).queryByRole('table')).toBeNull();
  });

  it('overview_partial_and_missing_definition', async () => {
    const data = overviewFixture(
      [team({ id: null, name: null, definition: { state: 'missing', problems: [] }, runtime: { state: 'running', teamId: 'rt-9', status: 'running' } })],
      { partial: true, coordinator: { running: false }, runtimeState: { available: false, error: { code: 'RT', message: 'state db locked' } } },
    );
    await renderScreen({ overview: [{ ok: true, data }] });
    const text = panel().textContent ?? '';
    for (const t of ['None (runtime only)', 'No definition (runtime only)', 'rt-9', 'Not running', 'Unavailable — state db locked',
      'This team has no definition file; it cannot be edited here.']) expect(text).toContain(t);
    expect(within(panel()).queryByRole('button', { name: 'Rename team' })).toBeNull();
    expect(within(panel()).queryByRole('button', { name: 'Delete team' })).toBeNull();
    const notice = screen.getByText('Live team state unavailable — state db locked');
    expect(panel().contains(notice)).toBe(false);
  });

  it('overview_problems_and_truncation', async () => {
    const data = overviewFixture([team({
      definition: { state: 'problems', problems: [{ path: 'members[0].agent', message: 'unknown agent' }] },
      membersTruncated: true,
      members: [member(), member({ memberId: 'qa', name: 'qa' })],
    })]);
    await renderScreen({ overview: [{ ok: true, data }] });
    const text = panel().textContent ?? '';
    expect(text).toContain('Has 1 problem');
    expect(text).toContain('2+ members');
    expect(text).toContain('Counts cover the 2 members shown; more members exist.');
    expect(within(within(panel()).getByRole('list', { name: 'Definition problems' })).getByText('members[0].agent: unknown agent')).toBeTruthy();
  });

  it('overview_uses_no_sample_data', async () => {
    await renderScreen({ overview: [{ ok: true, data: overviewFixture([team({ members: [], membersTruncated: true })]) }] });
    expect(panel().textContent).toContain('No members');
    expect(panel().textContent).toContain('Counts cover the 0 members shown; more members exist.');
    expect(within(panel()).queryByText(/^0 /)).toBeNull();
    expect(within(panel()).queryByRole('list', { name: 'Member availability' })).toBeNull();
    for (const sample of ['Developer', 'QA', 'T-031']) expect(panel().textContent).not.toContain(sample);
  });

  it('overview_tab_shows_no_extra_reads', async () => {
    const { fake } = await renderScreen();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(fake.overview).toHaveBeenCalledTimes(1);
    expect(fake.boardSettings).toHaveBeenCalledTimes(1);
  });

  it('overview_distinguishes_runtime_coordinator_and_live_state', async () => {
    const data = overviewFixture([team({ runtime: { state: 'stopped', teamId: null, status: 'stopped' } })], {
      coordinator: { running: true }, runtimeState: { available: false, error: null },
    });
    await renderScreen({ overview: [{ ok: true, data }] });
    const fact = (name: string) => within(panel()).getByText(name, { selector: 'dt' }).nextElementSibling!;
    expect(fact('Runtime').textContent).toContain('Stopped');
    expect(fact('Runtime').textContent).toContain('No runtime id');
    expect(fact('Coordinator').textContent).toBe('Running');
    expect(fact('Live state').textContent).toBe('Unavailable — runtime not reachable');
  });
});

describe('member roster', () => {
  it('roster_shows_only_returned_identity_role_agent_availability_and_work', async () => {
    const { fake } = await renderScreen();
    const dev = memberRow('dev');
    expect(['name', 'role', 'agent', 'availability', 'work'].map(f => field(dev, f))).toEqual(['dev', 'Developer', 'Active: opencode-sonnet · opencode · claude-sonnet', 'Working', 'T-031 Teams screen']);
    const lead = memberRow('lead');
    expect(['role', 'agent', 'availability', 'work'].map(f => field(lead, f))).toEqual(['TeamLead', 'Not running · saved inline: codex · model not set', 'Available', 'No current work']);
    const list = showMembers();
    expect(within(list).queryByRole('button', {name: /in Roles|Switch|Resume|Edit|Remove/})).toBeNull();
    expect(list.textContent).not.toMatch(/Implements scoped tickets\.|Default —/);
    expect(fake.overview).toHaveBeenCalledTimes(1);
  });
  it('keyboard_enter_and_space_open_the_exact_member', async () => {
    const user = userEvent.setup();
    await renderScreen({overview: [{ok: true, data: overviewFixture([team({members: [member(), member({memberId: 'qa', name: 'qa'})]})])}]});
    memberRow('qa').focus(); await user.keyboard('{Enter}');
    const detail = screen.getByRole('region', {name: 'qa'});
    expect(detail.textContent).not.toContain('dev');
    expect(screen.queryByRole('list', {name: /^Members of /})).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'Back to members'}));
    expect(document.activeElement).toBe(memberRow('qa')); expect(memberRow('qa').getAttribute('aria-current')).toBe('true');
    memberRow('dev').focus(); await user.keyboard(' '); expect(screen.getByRole('region', {name: 'dev'})).toBeTruthy();
  });
  it('refresh_keeps_detail_on_the_same_stable_member_and_removal_shows_notice', async () => {
    const dev = member(), qa = member({memberId: 'qa', name: 'qa'});
    const mk = (members: typeof dev[]) => ({ok: true as const, data: overviewFixture([team({members})])});
    await renderScreen({overview: [mk([dev, qa]), mk([{...qa, role: 'Reviewer'}, dev]), mk([dev])]});
    openMember('qa'); fireEvent.click(screen.getByRole('button', {name: 'Refresh'})); await act(async () => {});
    expect(screen.getByRole('region', {name: 'qa'}).textContent).toContain('Reviewer');
    fireEvent.click(screen.getByRole('button', {name: 'Refresh'})); await act(async () => {});
    expect(screen.queryByRole('region', {name: 'qa'})).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Member "qa" is no longer in this team. Showing all members.');
    expect(memberRow('dev')).toBeTruthy();
  });
  it('truncated_refresh_reports_selected_member_not_returned', async () => {
    const dev = member(), qa = member({memberId: 'qa', name: 'qa'});
    await renderScreen({overview: [
      {ok: true, data: overviewFixture([team({members: [dev, qa]})])},
      {ok: true, data: overviewFixture([team({members: [dev], membersTruncated: true})])},
    ]});
    openMember('qa');
    fireEvent.click(screen.getByRole('button', {name: 'Refresh'}));
    await act(async () => {});
    expect(screen.queryByRole('region', {name: 'qa'})).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Member "qa" is not among the returned members (the member list is truncated). Showing the returned members.');
    expect(memberRow('dev')).toBeTruthy();
  });
  it('navigation_between_roster_and_detail_does_not_read_management', async () => {
    const {fake} = await renderScreen();
    showMembers(); openMember('dev');
    fireEvent.click(screen.getByRole('button', {name: 'Back to members'}));
    fireEvent.click(screen.getByRole('tab', {name: 'Overview'}));
    showMembers();
    expect(fake.overview).toHaveBeenCalledTimes(1);
    expect(fake.agents).toHaveBeenCalledTimes(1);
    expect(fake.boardSettings).toHaveBeenCalledTimes(1);
  });
  it('member_without_id_is_listed_but_not_openable', async () => {
    await renderScreen({overview: [{ok: true, data: overviewFixture([team({members: [member({memberId: null, name: 'ghost-runtime', source: 'runtime'})]})])}]});
    const row = memberRow('ghost-runtime'); expect(row.textContent).toContain('No member id returned'); expect(row.closest('li')!.querySelector('button')).toBeNull();
  });
  it('empty_roster_and_truncation_are_truthful', async () => {
    const empty = await renderScreen({overview: [{ok: true, data: overviewFixture([team({members: []})])}]});
    fireEvent.click(screen.getByRole('tab', {name: 'Members'})); expect(screen.getByText('This team has no members.')).toBeTruthy(); expect(screen.queryByRole('list', {name: /^Members of /})).toBeNull(); empty.result.unmount();
    const members = Array.from({length: 16}, (_, i) => member({memberId: `m${i}`, name: `m${i}`}));
    await renderScreen({overview: [{ok: true, data: overviewFixture([team({members, membersTruncated: true})])}]});
    expect(within(showMembers()).getAllByRole('listitem')).toHaveLength(16); expect(screen.getByText('Showing the first 16 members.')).toBeTruthy();
  });
  it('add_member_is_available_at_members_level', async () => {
    await renderScreen(); showMembers(); expect(screen.getAllByRole('button', {name: 'Add member'})).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', {name: 'Add member'})); expect(screen.getByRole('form', {name: 'Add member'})).toBeTruthy();
    openMember('dev'); expect(screen.queryByRole('button', {name: 'Add member'})).toBeNull();
  });
});

describe('roster evidence and team removal', () => {
  it('roster_saved_fallback_is_never_labelled_active', async () => {
    const option = {...member().agentOptions[0]!, name: 'Saved choice'};
    await renderScreen({overview: [{ok: true, data: overviewFixture([team({members: [member({runtime: null, agentOptions: [option]}), member({memberId: 'missing', name: 'missing', runtime: null, agentOptions: [{...option, id: 'gone', name: null, state: 'missing'}]}), member({memberId: 'runtime', name: 'runtime', runtime: null, source: 'runtime'})]})])}]});
    expect(field(memberRow('dev'), 'agent')).toBe('Not running · saved default: Saved choice');
    expect(field(memberRow('missing'), 'agent')).toContain('Saved default is missing from the catalog');
    expect(field(memberRow('runtime'), 'agent')).toBe('No live or saved agent');
  });
  it('roster_role_shows_catalog_name_stable_id_and_diagnostics', async () => {
    const {result} = await renderScreen({overview: [{ok: true, data: overviewFixture([team({members: [member({role: 'qa-b'}), member({memberId: 'x', name: 'x', role: 'retired', roleState: 'undefined'})]})])}], roles: [{ok: true, data: rolesFixture({items: [roleItem('qa-b', {name: 'QA'})]})}]});
    expect(field(memberRow('dev'), 'role')).toBe('QAqa-b'); expect(field(memberRow('x'), 'role')).toContain('Role not defined in roles.json'); result.unmount();
    await renderScreen({roles: [{ok: false, error: {code: 'ERROR', message: 'failed', retryable: false}}]}); expect(field(memberRow('dev'), 'role')).toBe('Developer');
  });
  it('removed_team_never_opens_same_member_id_in_another_team', async () => {
    const alpha = team({id: 'alpha', name: 'Alpha', members: [member()]}), beta = team({id: 'beta', name: 'Beta', members: [member()]});
    await renderScreen({overview: [{ok: true, data: overviewFixture([alpha, beta])}, {ok: true, data: overviewFixture([beta])}]});
    openMember('dev'); fireEvent.click(screen.getByRole('button', {name: 'Refresh'})); await act(async () => {});
    showMembers(); expect(screen.queryByRole('region', {name: 'dev'})).toBeNull(); expect(screen.queryByRole('button', {name: 'Back to members'})).toBeNull();
  });
});

it('routing tab shows workspace routing with role links without extra reads', async () => {
  const { routingSettingsFixture } = await import('./teamsFixtures');
  const onViewRole = vi.fn();
  const fake = fakeManagement({ boardSettings: [{ ok: true, data: routingSettingsFixture() }] });
  const view = render(<TeamsScreen workspace={workspaceA} management={fake.api} onViewRole={onViewRole} />);
  await act(async () => {});
  expect(view.queryByRole('region', { name: 'Workspace board routing' })).toBeNull();
  fireEvent.click(view.getByRole('tab', { name: 'Routing' }));
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  expect(panel.getByText(/Changes affect every team/)).toBeTruthy();
  fireEvent.click(panel.getByRole('button', { name: 'View Developer in Roles (rule 1)' }));
  expect(onViewRole).toHaveBeenCalledOnce(); expect(onViewRole).toHaveBeenCalledWith('Developer');
  expect(fake.boardSettings).toHaveBeenCalledTimes(1); expect(fake.roles).toHaveBeenCalledTimes(1);
});

describe('member detail focus and settings', () => {
  it('separates member settings, saved options and live state with timing copy', async () => {
    await renderScreen(); showMembers(); const detail = openMember('dev');
    expect(within(detail).getByRole('navigation', {name: 'Member location'}).textContent).toBe('Dev TeamMembersdev');
    for (const label of ['Name', 'Member id', 'Role', 'Ticket permission']) expect(within(detail).getByText(label)).toBeTruthy();
    for (const text of [
      'Changes to name, role, ticket permission, and saved agent options apply the next time the team starts. Saving does not change the running member.',
      'Shared role instructions are edited in Roles and apply to new assignments after they are saved; current assignments keep the instructions they started with.',
      'Saved options are used in this order the next time the team starts; the first is the default. Editing them does not switch the running agent.',
      'Live state comes from the running team. Saving member settings does not change it.',
    ]) expect(detail.textContent).toContain(text);
    expect(detail.textContent).not.toMatch(/roles? (provides?|supply|supplies|grants?|owns?|controls?|determines?|sets?) /i);
    expect(detail.textContent).not.toMatch(/role'?s? (permission|default agent|active agent|quota)/i);
  });
  it('shows inline and runtime-only members without inventing saved catalog options', async () => {
    const inline = member({agentMode: 'inline', provider: 'codex', model: null});
    const runtime = member({memberId: 'live', name: 'live', source: 'runtime'});
    await renderMembers({overview: [{ok: true, data: overviewFixture([team({members: [inline, runtime]})])}]});
    let detail = openMember('dev');
    expect(detail.textContent).toContain('Inline agent — codex · model not set');
    fireEvent.click(within(detail).getByRole('button', {name: 'Back to members'}));
    detail = openMember('live');
    expect(detail.textContent).toContain('Saved options are not available for runtime-only members.');
    expect(within(detail).queryByRole('button', {name: /^(Edit|Remove) live$/})).toBeNull();
  });
  it('keeps a missing role visible and repairable without a link', async () => {
    await renderMembers({overview: [{ok: true, data: overviewFixture([team({members: [member({role: 'retired'})]})])}]});
    const detail = openMember('dev');
    expect(detail.textContent).toContain('Choose an existing role by editing this member.');
    expect(within(detail).queryByRole('button', {name: /in Roles/})).toBeNull();
    fireEvent.click(within(detail).getByRole('button', {name: 'Edit dev'}));
    expect(within(screen.getByLabelText('Role')).getByRole('option', {name: 'retired — missing from role catalog'})).toBeTruthy();
  });
  it('focuses the heading and restores the roster row on return', async () => {
    await renderScreen(); showMembers(); openMember('dev');
    expect(document.activeElement).toBe(screen.getByRole('heading', {name: 'dev', level: 3}));
    expect(screen.getByRole('heading', {name: 'Member settings'})).toBeTruthy();
    expect(screen.getByRole('heading', {name: 'Agent options — next team start'})).toBeTruthy();
    expect(screen.getByRole('heading', {name: 'Live agent'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Back to members'}));
    expect(document.activeElement).toBe(document.querySelector('[data-member-row="dev"]'));
  });
  it('restores edit and remove focus after cancelling', async () => {
    await renderScreen(); showMembers(); openMember('lead');
    fireEvent.click(screen.getByRole('button', {name: 'Edit lead'}));
    expect(document.activeElement).toBe(screen.getByRole('heading', {name: 'Edit lead'}));
    fireEvent.click(within(screen.getByRole('form', {name: 'Edit lead'})).getByRole('button', {name: 'Cancel'}));
    expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Edit lead'}));
    fireEvent.click(screen.getByRole('button', {name: 'Remove lead'}));
    expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Cancel removing lead'}));
    fireEvent.keyDown(screen.getByRole('alertdialog'), {key: 'Escape'});
    expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Remove lead'}));
  });
  it('restores add focus after cancelling', async () => {
    await renderScreen(); showMembers();
    fireEvent.click(screen.getByRole('button', {name: 'Add member'}));
    fireEvent.click(within(screen.getByRole('form', {name: 'Add member'})).getByRole('button', {name: 'Cancel'}));
    expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Add member'}));
  });
});
