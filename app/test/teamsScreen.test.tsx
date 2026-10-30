// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { WorkspaceShell } from '../src/renderer/shell/WorkspaceShell';
import { TeamsHarness, teamRow } from './teamsHarness';
import type { TeamsNavigationController } from '../src/renderer/teams/useTeamsNavigationController';
import { roleItem, rolesFixture } from './rolesFixtures';
import { readyApi, workspaceA } from './dashboardFixtures';
import {
  catalogFixture, fakeManagement, member, overviewFixture, team, twoTeams, openMember, showMembers, memberRow, field,
  boardSettingsFixture, connectionFixture, coordinatorStopped, deferred, emptyRoster, emptyWorkspace, invalidBoardSettings, invalidRoleCatalog,
  teamDefinition, teamRolesFixture, longContentOverview, managementError, memberTruncatedOverview, missingBoardSettings, partialOverview, runtimeUnavailable, truncatedOverview, LONG_UNBROKEN,
} from './teamsFixtures';
afterEach(cleanup);

it('disconnected_with_pending_board_load_announces_only_one_status', async () => {
  const boardGate = deferred<ReturnType<typeof okR<ReturnType<typeof boardSettingsFixture>>>>();
  const fake = fakeManagement({ boardSettings: [boardGate.promise] });
  const view = render(<TeamsHarness workspace={workspaceA} management={fake.api} connection={connectionFixture('lost')} />);
  await act(async () => {});
  expect(view.getByText('Connection lost. Showing previously loaded data.')).toBeTruthy();
  expect(view.getByText('Loading board state…')).toBeTruthy();
  expect(view.getAllByRole('status')).toHaveLength(1);
  expect((view.getByRole('button', { name: 'New team' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { boardGate.resolve(okR(boardSettingsFixture())); });
});

it('routing_refresh_with_overview_pending_announces_only_one_status', async () => {
  const overviewGate = deferred<ReturnType<typeof okR<ReturnType<typeof twoTeams>>>>();
  const boardGate = deferred<ReturnType<typeof okR<ReturnType<typeof boardSettingsFixture>>>>();
  const fake = fakeManagement({ overview: [okR(twoTeams()), overviewGate.promise], boardSettings: [okR(boardSettingsFixture()), boardGate.promise] });
  const view = render(<TeamsHarness workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  fireEvent.click(view.getByRole('tab', { name: 'Routing' }));
  fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
  await act(async () => {});
  expect(view.getByText(/Refreshing teams… Showing previously loaded data/)).toBeTruthy();
  expect(view.getByText(/Refreshing routing settings… Showing previously loaded data/)).toBeTruthy();
  expect(view.getAllByRole('status')).toHaveLength(1);
  await act(async () => { overviewGate.resolve(okR(twoTeams())); boardGate.resolve(okR(boardSettingsFixture())); });
});

it('retained_refresh_success_does_not_duplicate_pending_or_connection_status', async () => {
  const overviewGate = deferred<ReturnType<typeof okR<ReturnType<typeof twoTeams>>>>();
  const fake = fakeManagement({ overview: [okR(twoTeams()), okR(twoTeams()), overviewGate.promise] });
  const view = render(<TeamsHarness workspace={workspaceA} management={fake.api} connection={connectionFixture('connected')} />);
  await act(async () => {});
  fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
  await act(async () => {});
  expect(view.getByRole('status').textContent).toContain('Teams data refreshed.');
  fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
  await act(async () => {});
  expect(view.queryByText('Teams data refreshed.')).toBeNull();
  expect(view.getAllByRole('status')).toHaveLength(1);
  expect(view.getByRole('status').textContent).toContain('Refreshing teams');
  view.rerender(<TeamsHarness workspace={workspaceA} management={fake.api} connection={connectionFixture('lost')} />);
  expect(view.getAllByRole('status')).toHaveLength(1);
  expect(view.getByRole('status').textContent).toContain('Connection lost.');
  await act(async () => { overviewGate.resolve(okR(twoTeams())); });
});

async function renderScreen(opts: Parameters<typeof fakeManagement>[0] = {}) {
  const fake = fakeManagement(opts);
  const result = render(<TeamsHarness sidebar workspace={workspaceA} management={fake.api} />);
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
  await openTab(out.result, 'Overview');
  return out;
}

const cardNames = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('.team-nav-label')).map((n) => n.textContent);
const card = teamRow;

describe('compact team overview', () => {
  const RUNTIME_ID = '123e4567-e89b-42d3-a456-426614174999';
  it('compact_overview_renders_team_board_and_availability_from_returned_data', async () => {
    const data = overviewFixture([team({
      id: 'dev-team-id', name: 'Dev Team',
      runtime: { state: 'running', teamId: RUNTIME_ID, status: 'active' },
      members: [member({ memberId: 'a', name: 'a', presence: 'busy' }), member({ memberId: 'b', name: 'b', presence: 'idle' })],
    })]);
    const { result } = await renderScreen({ overview: [{ ok: true, data }] });
    for (const heading of ['Team status', 'Board', 'Member availability', 'Team actions']) {
      expect(result.getByRole('heading', { name: heading })).toBeTruthy();
    }
    expect(within(result.getByRole('tabpanel', { name: 'Overview' })).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['Team status', 'Board', 'Member availability', 'Team actions', 'Members']);
    const status = result.getByRole('heading', { name: 'Team status' }).closest('section')!;
    const availability = result.getByRole('heading', { name: 'Member availability' }).closest('section')!;
    expect(within(status).getByText('Dev Team')).toBeTruthy();
    expect(within(status).getByText('Running')).toBeTruthy();
    expect(within(status).getByText('Definition: Valid')).toBeTruthy();
    expect(within(status).getByText('Coordinator: Running')).toBeTruthy();
    expect(within(status).getByText('Live state: Available')).toBeTruthy();
    expect(within(availability).getByText('2 members')).toBeTruthy();
    expect(within(availability).getByText('1 Working')).toBeTruthy();
    expect(within(availability).getByText('1 Available')).toBeTruthy();
    for (const card of [status, availability]) {
      expect(card.textContent).not.toContain('dev-team-id');
      expect(card.textContent).not.toContain(RUNTIME_ID);
    }
  });

  it('compact_overview_qualifies_partial_truncated_stale_and_unavailable_data', async () => {
    const base = overviewFixture([team({
      definition: { state: 'problems', problems: [{ path: 'members[0]', message: 'unknown role' }] },
      membersTruncated: true,
      members: [],
    })], {
      partial: true,
      runtimeState: { available: false, error: { code: 'RUNTIME_DOWN', message: 'state db locked', retryable: true } },
    } as Partial<ReturnType<typeof overviewFixture>>);
    const { result } = await renderScreen({ overview: [{ ok: true, data: base }, { ok: false, error: { code: 'INTERNAL', message: 'refresh failed', retryable: true } }] });
    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    await act(async () => {});
    expect(result.getByText('Team data is stale — showing previously loaded data.')).toBeTruthy();
    expect(result.getByText('Some team details could not be read.')).toBeTruthy();
    expect(result.getByText('members[0]: unknown role')).toBeTruthy();
    expect(result.getByText('Counts cover the 0 members shown; more members exist.')).toBeTruthy();
    expect(result.getByText('No members')).toBeTruthy();
    expect(within(result.getByRole('region', { name: 'Member availability' })).queryByRole('list', { name: 'Member availability counts' })).toBeNull();
    expect(result.getAllByText(/state db locked/).length).toBeGreaterThan(0);
  });

  it('availability_counts_only_returned_members_and_preserves_unknown_presence', async () => {
    const data = overviewFixture([team({
      membersTruncated: true,
      members: [
        member({ memberId: 'a', presence: 'busy' }),
        member({ memberId: 'b', presence: 'busy' }),
        member({ memberId: 'c', presence: 'future_state' as never }),
      ],
    })]);
    const { result } = await renderScreen({ overview: [{ ok: true, data }] });
    const summary = within(result.getByRole('region', { name: 'Member availability' }));
    expect(summary.getByText('Counts cover the 3 members shown; more members exist.')).toBeTruthy();
    const buckets = within(summary.getByRole('list', { name: 'Member availability counts' })).getAllByRole('listitem');
    expect(buckets.map((bucket) => bucket.textContent)).toEqual(['2 Working', '1 future_state']);
    expect(buckets[0]!.querySelector('.teams-tone-busy')).toBeTruthy();
    expect(buckets[1]!.querySelector('.teams-tone-muted')).toBeTruthy();
  });

  it('retained_overview_is_stale_and_team_writes_are_locked_during_refresh_and_disconnection', async () => {
    const gate = deferred<ReturnType<typeof okR<ReturnType<typeof twoTeams>>>>();
    const fake = fakeManagement({ overview: [okR(twoTeams()), gate.promise] });
    const result = render(<TeamsHarness sidebar workspace={workspaceA} management={fake.api} connection={connectionFixture('connected')} />);
    await act(async () => {});
    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    await act(async () => {});
    expect(result.getByText('Team data is stale — showing previously loaded data.')).toBeTruthy();
    expect((result.getByRole('button', { name: 'Rename team' }) as HTMLButtonElement).disabled).toBe(true);
    expect((result.getByRole('button', { name: 'Delete team' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { gate.resolve(okR(twoTeams())); });
    expect(result.queryByText('Team data is stale — showing previously loaded data.')).toBeNull();
    result.rerender(<TeamsHarness sidebar workspace={workspaceA} management={fake.api} connection={connectionFixture('lost')} />);
    expect(result.getByText('Team data is stale — showing previously loaded data.')).toBeTruthy();
    expect((result.getByRole('button', { name: 'Rename team' }) as HTMLButtonElement).disabled).toBe(true);
    expect((result.getByRole('button', { name: 'Delete team' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('overview_tabs_are_only_overview_and_routing_and_keep_roving_keyboard_semantics', async () => {
    const { result } = await renderScreen();
    const tabs = result.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Overview', 'Routing']);
    expect(result.getAllByRole('tabpanel', { hidden: true })).toHaveLength(2);
    const selected = () => tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent);
    expect(selected()).toEqual(['Overview']);
    expect(tabs.filter((t) => t.tabIndex === 0)).toHaveLength(1);
    for (const t of tabs) expect(document.getElementById(t.getAttribute('aria-controls')!)).toBeTruthy();
    fireEvent.click(tabs[1]!);
    expect(selected()).toEqual(['Routing']);
    fireEvent.keyDown(tabs[1]!, { key: 'ArrowRight' });
    expect(selected()).toEqual(['Overview']);
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' });
    expect(selected()).toEqual(['Routing']);
    fireEvent.keyDown(tabs[1]!, { key: 'Home' });
    expect(selected()).toEqual(['Overview']);
    fireEvent.keyDown(tabs[0]!, { key: 'End' });
    expect(selected()).toEqual(['Routing']);
    expect(tabs.filter((t) => t.tabIndex === 0)).toHaveLength(1);
  });

  it('routing_tab_keeps_workspace_routing_without_extra_reads', async () => {
    const { result, fake } = await renderScreen();
    const reads = () => [fake.api.overview, fake.api.boardSettings, fake.api.agents, fake.api.roles].map((f) => (f as unknown as { mock?: { calls: unknown[] } }).mock?.calls.length ?? 0);
    const before = reads();
    await openTab(result, 'Routing');
    expect(result.getByText('Workspace board routing')).toBeTruthy();
    expect(reads()).toEqual(before);
  });
});

describe('TeamsScreen', () => {
  it('defined_member_shows_role_metadata_and_deep_link', async () => {
    const onViewRole = vi.fn();
    const fake = fakeManagement({
      overview: [{ ok: true, data: overviewFixture([team({ members: [member({ role: 'qa-b' })] })]) }],
      roles: [{ ok: true, data: rolesFixture({ items: [roleItem('qa-a', { name: 'QA' }), roleItem('qa-b', { name: 'QA', description: 'Second QA' })] }) }],
    });
    const result = render(<TeamsHarness workspace={workspaceA} management={fake.api} onViewRole={onViewRole} />);
    await act(async () => {});
    await openTab(result, 'Overview');
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
    expect(row.textContent).toContain('live-id · live-provider · live-model');
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
    const list = result.getByRole('navigation', { name: 'Harness sidebar' });
    expect(cardNames(list)).toEqual(['Dev Team', 'Release Team']);
    expect(card(list, 'Dev Team').getAttribute('aria-current')).toBe('page');
    const detail = result.getByRole('region', { name: 'Dev Team' });
    expect(detail.textContent).toContain('Running');
    expect(detail.textContent).toContain('Running');
    await openTab(result, 'Overview');
    const r1 = openMember('dev').textContent;
    expect(r1).toContain('Default — OpenCode Sonnet · opencode · sonnet');
    expect(r1).toContain('T-031 · Teams screen');
    fireEvent.click(result.getByRole('button', { name: 'Back to members' }));
    const r2 = openMember('lead').textContent;
    expect(r2).toContain('Inline agent — codex · model not set');
    expect(r2).toContain('Live state is unavailable because this member has no running runtime record.');
    expect(fake.overview).toHaveBeenCalledTimes(1);
    expect(fake.overview).toHaveBeenCalledWith('ws-a');
    expect(fake.agents).toHaveBeenCalledTimes(1);
    expect(fake.agents).toHaveBeenCalledWith('ws-a');
  });

  it('selecting_a_team_shows_its_members_without_reloading', async () => {
    const { fake, result } = await renderScreen();
    const list = result.getByRole('navigation', { name: 'Harness sidebar' });
    fireEvent.click(card(list, 'Release Team'));
    expect(card(list, 'Release Team').getAttribute('aria-current')).toBe('page');
    expect(card(list, 'Dev Team').getAttribute('aria-current')).toBeNull();
    await openTab(result, 'Overview');
    const detail = result.getByRole('region', { name: 'Release Team' });
    expect(within(detail).getByRole('heading', { level: 2 }).textContent).toBe('Release Team');
    const row = openMember('qa');
    expect(row.textContent).toContain('qa');
    expect(row.textContent).toContain('Live state is unavailable because this member has no running runtime record.');
    expect(fake.overview).toHaveBeenCalledTimes(1);
  });

  it('does_not_render_catalog_region_but_still_loads_catalog_for_member_forms', async () => {
    const { result, fake } = await renderScreen();
    expect(result.queryByRole('region', { name: 'Agent catalog' })).toBeNull();
    expect(result.queryByRole('heading', { name: 'Agent catalog' })).toBeNull();
    expect(result.queryByRole('list', { name: 'Agent catalog' })).toBeNull();
    expect(fake.agents).toHaveBeenCalledTimes(1);
    await openTab(result, 'Overview');
    fireEvent.click(result.getByRole('button', { name: 'Add member' }));
    expect(result.getByRole('option', { name: 'OpenCode Sonnet (opencode-sonnet)' })).toBeTruthy();
  });

  it('keeps members visible and catalog choices unavailable when catalog loading fails', async () => {
    const { result } = await renderScreen({ agents: [{ ok: false, error: { code: 'CATALOG_FAIL', message: 'failed', retryable: true } }] });
    await openTab(result, 'Overview');
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
    const list = result.getByRole('navigation', { name: 'Harness sidebar' });
    for (const t of ['ghost', 'Runtime unavailable', 'Definition unreadable']) expect(list.textContent).toContain(t);
    const detail = result.getByRole('region', { name: 'ghost' });
    expect(detail.textContent).toContain('$: could not load team definition: TEAM_CONFIG_INVALID');
    await openTab(result, 'Overview');
    const row = openMember('m1');
    for (const t of ['m1', 'Agent definition gone is missing', 'No role', 'Role descriptions unavailable', 'Live state is unavailable because this member has no running runtime record.']) {
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
    await openTab(result, 'Overview');
    expect(result.getByText('Showing 16 of 16 returned members. More members may exist; filters apply only to returned members.')).toBeTruthy();
    expect(within(result.getByRole('list', { name: 'Data notices' })).getByText('Showing the first 1 team. More teams exist in this workspace.')).toBeTruthy();
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
    const list = result.getByRole('navigation', { name: 'Harness sidebar' });
    const status = result.getByRole('region', { name: 'Teams data status' });
    const alert = within(status).getByRole('alert');
    expect(alert.textContent).toContain('INTERNAL: boom');
    expect(alert.textContent).toContain('Restart the backend.');
    expect(within(list).getByRole('alert').textContent).toBe('Teams unavailable. boom');
    fireEvent.click(within(status).getByRole('button', { name: 'Retry' }));
    await act(async () => {});
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(fake.agents).toHaveBeenCalledTimes(1);
    expect(card(list, 'Dev Team')).toBeTruthy();
  });

  it('refresh_reloads_both_and_keeps_selection', async () => {
    const { fake, result } = await renderScreen();
    const list = result.getByRole('navigation', { name: 'Harness sidebar' });
    fireEvent.click(card(list, 'Release Team'));
    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    await act(async () => {});
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(fake.agents).toHaveBeenCalledTimes(2);
    expect(card(list, 'Release Team').getAttribute('aria-current')).toBe('page');
  });

  it('rejected_overview_shows_internal_error', async () => {
    const { result } = await renderScreen({ overview: [Promise.reject(new Error('ipc down'))] });
    expect(within(result.getByRole('region', { name: 'Teams data status' })).getByRole('alert').textContent)
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
      if (b.matches('[role="tab"]')) expect(['0', '-1']).toContain(b.getAttribute('tabindex'));
      else expect(b.hasAttribute('tabindex')).toBe(false);
    }
    expect(Array.from(result.container.querySelectorAll('[role="tab"]')).filter((b) => b.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(result.container.querySelector('.teams-card, .teams-layout')).toBeNull();
    expect(result.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(result.getByRole('region', { name: 'Dev Team' })).toBeTruthy();
    expect(result.queryByRole('region', { name: 'Workspace teams' })).toBeNull();
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
    expect(card(result.getByRole('navigation', { name: 'Workspace' }), 'Dev Team').getAttribute('aria-current')).toBeNull();
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
      if (!m.runtime) expect(detail.textContent).toContain('Live state is unavailable because this member has no running runtime record.');
      else if (m.agentMode === 'inline') { expect(detail.textContent).toContain('Live switching is unavailable for inline members.'); expect(within(detail).getByText('Active agent')).toBeTruthy(); }
      else expect(within(detail).getByText('Active agent')).toBeTruthy();
      result.unmount();
    }
  });

});

describe('focused navigation', () => {
  const selectedTabs = (r: ReturnType<typeof render>) => r.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent);
  const list = (r: ReturnType<typeof render>) => r.getByRole('navigation', { name: 'Harness sidebar' });
  const reordered = () => {
    const data = twoTeams();
    const byName = (n: string) => data.teams.find((t) => t.name === n)!;
    byName('Dev Team').runtime = { state: 'stopped', teamId: 't-1', status: 'stopped' };
    byName('Release Team').runtime = { state: 'running', teamId: 't-2', status: 'running' };
    return data;
  };

  it('initial_selection_is_first_ordered_team_on_overview', async () => {
    const { result } = await renderScreen();
    expect(card(list(result), 'Dev Team').getAttribute('aria-current')).toBe('page');
    const tablist = result.getByRole('tablist', { name: 'Dev Team views' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Overview', 'Routing']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1]);
    const panels = result.getAllByRole('tabpanel');
    expect(panels).toHaveLength(1);
    expect(panels[0]!.id).toBe('teams-panel-overview');
    expect(panels[0]!.getAttribute('aria-labelledby')).toBe('teams-tab-overview');
    expect(panels[0]!.textContent).toContain('Running');
    expect(panels[0]!.textContent).toContain('Board');
    expect(result.queryByRole('table')).toBeNull();
    expect(result.queryByRole('region', { name: 'Workspace board routing' })).toBeNull();
  });

  it('routing_tab_shows_exactly_one_panel', async () => {
    const { result } = await renderScreen();
    expect(result.getAllByRole('tabpanel')).toHaveLength(1);
    await openTab(result, 'Routing');
    expect(result.getAllByRole('tabpanel')).toHaveLength(1);
    expect(within(result.getByRole('tabpanel')).getByRole('region', { name: 'Workspace board routing' })).toBeTruthy();
    expect(result.queryByRole('table')).toBeNull();
  });

  it('tab_keyboard_moves_focus_selection_and_wraps', async () => {
    const { result } = await renderScreen();
    tab(result, 'Overview').focus();
    const steps: Array<[string, string]> = [
      ['ArrowRight', 'Routing'], ['ArrowRight', 'Overview'],
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

  it('sidebar_team_rows_use_native_tab_order_without_roving_keys', async () => {
    const { result } = await renderScreen();
    const root = list(result);
    expect(root.querySelector('ul')!.getAttribute('aria-label')).toBe('Workspace teams');
    expect(card(root, 'Dev Team').tabIndex).toBe(0);
    expect(card(root, 'Release Team').tabIndex).toBe(0);
    card(root, 'Dev Team').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(card(root, 'Dev Team'));
    expect(card(root, 'Dev Team').getAttribute('aria-current')).toBe('page');
    expect(card(root, 'Release Team').getAttribute('aria-current')).toBeNull();
  });

  it('selecting_a_new_team_returns_to_overview', async () => {
    const { result } = await renderScreen();
    await openTab(result, 'Overview');
    fireEvent.click(card(list(result), 'Release Team'));
    expect(card(list(result), 'Release Team').getAttribute('aria-current')).toBe('page');
    expect(selectedTabs(result)).toEqual(['Overview']);
    await openTab(result, 'Overview');
    fireEvent.click(card(list(result), 'Release Team'));
    expect(selectedTabs(result)).toEqual(['Overview']);
  });

  it('refresh_reorder_preserves_selection_and_view', async () => {
    const { result } = await renderScreen({ overview: [{ ok: true, data: twoTeams() }, { ok: true, data: reordered() }] });
    fireEvent.click(card(list(result), 'Release Team'));
    await openTab(result, 'Overview');
    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    await act(async () => {});
    expect(cardNames(list(result))).toEqual(['Release Team', 'Dev Team']);
    expect(card(list(result), 'Release Team').getAttribute('aria-current')).toBe('page');
    expect(selectedTabs(result)).toEqual(['Overview']);
    expect(within(result.getByRole('region', { name: 'Release Team' })).getByRole('list', { name: /^Members of / })).toBeTruthy();
  });

  it('refresh_removal_falls_back_to_first_team_overview', async () => {
    const { result } = await renderScreen({ overview: [{ ok: true, data: twoTeams() }, { ok: true, data: overviewFixture([twoTeams().teams[1]!]) }] });
    fireEvent.click(card(list(result), 'Release Team'));
    await openTab(result, 'Overview');
    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    await act(async () => {});
    expect(cardNames(list(result))).toEqual(['Dev Team']);
    expect(card(list(result), 'Dev Team').getAttribute('aria-current')).toBe('page');
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
    await openTab(result, 'Overview');
    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    await act(async () => {});
    expect(within(result.getByRole('region', { name: 'Teams data status' })).getByRole('alert').textContent).toContain('INTERNAL: boom');
    expect(within(list(result)).getByText(/^Team list unavailable\. Showing previously loaded teams\./)).toBeTruthy();
    expect(card(list(result), 'Release Team').getAttribute('aria-current')).toBe('page');
    expect(selectedTabs(result)).toEqual(['Overview']);
  });

  it('workspace_change_resets_selection_and_view', async () => {
    const fake = fakeManagement({ overview: [{ ok: true, data: twoTeams() }, { ok: true, data: overviewFixture([team({ id: 'ops', name: 'Ops Team' })]) }] });
    const result = render(<TeamsHarness sidebar workspace={workspaceA} management={fake.api} />);
    await act(async () => {});
    fireEvent.click(card(list(result), 'Release Team'));
    await openTab(result, 'Routing');
    result.rerender(<TeamsHarness sidebar workspace={{ ...workspaceA, id: 'ws-b' }} management={fake.api} />);
    await act(async () => {});
    expect(card(list(result), 'Ops Team').getAttribute('aria-current')).toBe('page');
    expect(selectedTabs(result)).toEqual(['Overview']);
    expect(fake.overview).toHaveBeenLastCalledWith('ws-b');
  });

  it('tab_and_team_changes_issue_no_management_reads', async () => {
    const { fake, result } = await renderScreen();
    for (const name of ['Routing', 'Overview']) await openTab(result, name);
    tab(result, 'Overview').focus();
    for (const key of ['ArrowRight', 'ArrowRight', 'Home', 'End']) fireEvent.keyDown(document.activeElement!, { key });
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
    const conn = (state: 'connected' | 'lost') => ({ state, error: null, distro: null, command: 'serve' });
    const result = render(<TeamsHarness workspace={workspaceA} management={fake.api} connection={conn('connected')} />);
    await act(async () => {});
    fireEvent.click(result.getByRole('button', { name: 'New team' }));
    fireEvent.change(result.getByLabelText('Team name'), { target: { value: 'X' } });
    fireEvent.click(result.getByRole('button', { name: 'Create team' }));
    await act(async () => {});
    expect(result.getAllByRole('alert')).toHaveLength(1);
    expect(result.getByRole('alert').textContent).toContain('BAD_REQUEST: dup');
    expect(result.getByRole('button', { name: 'Retry loading roles' }).parentElement?.textContent).toContain('INTERNAL: roles down');
    result.rerender(<TeamsHarness workspace={workspaceA} management={fake.api} connection={conn('lost')} />);
    await act(async () => {});
    for (const name of ['Overview', 'Routing']) {
      await openTab(result, name);
      const panel = result.getByRole('tabpanel');
      const outside = [
        result.getByRole('list', { name: 'Data notices' }),
        result.getByRole('button', { name: 'Retry loading roles' }),
        result.getByText('Connection lost. Showing previously loaded data.'),
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
  const summary = () => within(panel()).getByRole('list', { hidden: true, name: 'Member availability counts' });

  it('overview_shows_definition_runtime_members_and_coordinator', async () => {
    await renderScreen();
    const facts = panel().textContent ?? '';
    for (const text of ['Dev Team', 'Definition: Valid', 'Running', '2 members', '1 Working', '1 Available', 'Live state: Available']) {
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
    for (const t of ['No definition (runtime only)', 'rt-9', 'Coordinator: Not running', 'Unavailable — state db locked',
      'Some team details could not be read.',
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
    expect(within(panel()).queryByRole('list', { name: 'Member availability counts' })).toBeNull();
    for (const sample of ['Developer', 'QA', 'T-031']) expect(panel().textContent).not.toContain(sample);
  });

  it('overview_tab_shows_no_extra_reads', async () => {
    const { fake } = await renderScreen();
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(fake.overview).toHaveBeenCalledTimes(1);
    expect(fake.boardSettings).toHaveBeenCalledTimes(1);
  });

  it('overview_distinguishes_runtime_coordinator_and_live_state', async () => {
    const data = overviewFixture([team({ runtime: { state: 'stopped', teamId: null, status: 'stopped' } })], {
      coordinator: { running: true }, runtimeState: { available: false, error: null },
    });
    await renderScreen({ overview: [{ ok: true, data }] });
    const status = within(panel()).getByRole('heading', { name: 'Team status' }).closest('section')!;
    expect(within(status).getByText('Stopped')).toBeTruthy();
    expect(within(status).getByText('Coordinator: Running')).toBeTruthy();
    expect(within(status).getByText('Live state: Unavailable — runtime not reachable')).toBeTruthy();
  });
});

describe('member roster', () => {
  const names = () => Array.from(document.querySelectorAll('[data-member-row]')).map(el => el.getAttribute('data-member-row'));
  const search = () => screen.getByLabelText('Search members') as HTMLInputElement;
  const avail = () => screen.getByLabelText('Availability') as HTMLSelectElement;
  const roster = (members: ReturnType<typeof member>[], extra: Partial<ReturnType<typeof team>> = {}) => ({ ok: true as const, data: overviewFixture([team({ members, ...extra })]) });
  const trio = () => [member({ memberId: 'a', name: 'Alpha', presence: 'busy' }), member({ memberId: 'b', name: 'Bravo', presence: 'idle' }), member({ memberId: 'c', name: 'ALPHA-two', presence: 'busy' })];

  it('renders the sole member roster and Add member below compact Overview with only Overview and Routing tabs', async () => {
    const { result } = await renderScreen();
    expect(result.getAllByRole('tab').map(t => t.textContent)).toEqual(['Overview', 'Routing']);
    expect(result.queryByRole('tab', { name: 'Members' })).toBeNull();
    expect(result.getAllByRole('tabpanel')).toHaveLength(1);
    expect(result.getAllByRole('list', { name: /^Members of / })).toHaveLength(1);
    const heading = result.getByRole('heading', { name: 'Members' });
    const summary = result.getByRole('heading', { name: 'Member availability' });
    expect(summary.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(result.getAllByRole('button', { name: 'Add member' })).toHaveLength(1);
    const ids = names();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('combines text and availability filters, clears them, and preserves backend row order', async () => {
    const { fake } = await renderScreen({ overview: [roster(trio())] });
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    fireEvent.change(search(), { target: { value: '   ' } });
    expect(names()).toEqual(['a', 'b', 'c']);
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    fireEvent.change(search(), { target: { value: 'AlPhA' } });
    expect(names()).toEqual(['a', 'c']);
    fireEvent.change(avail(), { target: { value: 'busy' } });
    expect(names()).toEqual(['a', 'c']);
    fireEvent.change(search(), { target: { value: 'two' } });
    expect(names()).toEqual(['c']);
    fireEvent.change(avail(), { target: { value: 'idle' } });
    expect(screen.getByText('No returned members match the current filters.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(names()).toEqual(['a', 'b', 'c']);
    expect(search().value).toBe(''); expect(avail().value).toBe('');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    expect(fake.overview).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an empty team from no returned filter matches', async () => {
    const empty = await renderScreen({ overview: [roster([])] });
    expect(screen.getByText('This team has no members.')).toBeTruthy();
    expect(screen.queryByText('No returned members match the current filters.')).toBeNull();
    empty.result.unmount();
    await renderScreen({ overview: [roster(trio())] });
    fireEvent.change(search(), { target: { value: 'zzz' } });
    expect(screen.getByText('No returned members match the current filters.')).toBeTruthy();
    expect(screen.queryByText('This team has no members.')).toBeNull();
  });

  it('qualifies every filtered result when the returned roster is truncated', async () => {
    await renderScreen({ overview: [roster(trio(), { membersTruncated: true })] });
    const note = (x: number) => `Showing ${x} of 3 returned members. More members may exist; filters apply only to returned members.`;
    expect(screen.getByText(note(3))).toBeTruthy();
    fireEvent.change(search(), { target: { value: 'alpha' } });
    expect(screen.getByText(note(2))).toBeTruthy();
    fireEvent.change(search(), { target: { value: 'zzz' } });
    expect(screen.getByText(note(0))).toBeTruthy();
  });

  it('qualifies an empty truncated roster and keeps filters harmless', async () => {
    await renderScreen({ overview: [roster([], { membersTruncated: true })] });
    expect(screen.getByText('This team has no members.')).toBeTruthy();
    expect(screen.getByText('Showing 0 of 0 returned members. More members may exist; filters apply only to returned members.')).toBeTruthy();
    fireEvent.change(search(), { target: { value: 'anything' } });
    expect(screen.getByText('This team has no members.')).toBeTruthy();
    expect(screen.queryByText('No returned members match the current filters.')).toBeNull();
  });

  it('offers unknown raw availability and renders a member without an id as a static row', async () => {
    await renderScreen({ overview: [roster([
      member({ memberId: null, name: 'Anonymous', presence: 'mystery' }),
      member({ memberId: 'known', name: 'Known', presence: 'mystery-extra' }),
    ])] });
    expect(within(avail()).getByRole('option', { name: 'mystery (1)' }).getAttribute('value')).toBe('mystery');
    fireEvent.change(avail(), { target: { value: 'mystery' } });
    expect(screen.getByText('Anonymous')).toBeTruthy();
    expect(screen.queryByText('Known')).toBeNull();
    expect(screen.queryByRole('button', { name: /Anonymous/ })).toBeNull();
    expect(screen.getByText('No member id returned')).toBeTruthy();
  });

  it('opens detail from Overview and restores the invoking row after Back with filters preserved', async () => {
    const { fake } = await renderScreen({ overview: [roster(trio())] });
    fireEvent.change(search(), { target: { value: 'alpha' } });
    fireEvent.change(avail(), { target: { value: 'busy' } });
    openMember('ALPHA-two');
    expect(screen.queryByRole('list', { name: /^Members of / })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Member availability' })).toBeNull();
    expect(screen.getAllByRole('region', { name: 'ALPHA-two' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Back to members' }));
    expect(search().value).toBe('alpha'); expect(avail().value).toBe('busy');
    expect(document.activeElement).toBe(document.querySelector('[data-member-row="c"]'));
    expect(fake.overview).toHaveBeenCalledTimes(1);
  });

  it('keeps filters across refresh, resets a vanished availability only, and falls back to the Members heading when the row is filtered out', async () => {
    const after = trio().map(m => m.memberId === 'c' ? { ...m, presence: 'idle' } : m);
    const onlyIdle = trio().map(m => ({ ...m, presence: 'idle' }));
    await renderScreen({ overview: [roster(trio()), roster(after), roster(onlyIdle)] });
    fireEvent.change(search(), { target: { value: 'alpha' } });
    fireEvent.change(avail(), { target: { value: 'busy' } });
    openMember('ALPHA-two');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await act(async () => {});
    expect(screen.getAllByRole('region', { name: 'ALPHA-two' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Back to members' }));
    expect(names()).toEqual(['a']);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Members' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(names()).toEqual(['a', 'b', 'c']);
    fireEvent.change(search(), { target: { value: 'alpha' } });
    fireEvent.change(avail(), { target: { value: 'busy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await act(async () => {});
    expect(avail().value).toBe(''); expect(search().value).toBe('alpha');
    expect(names()).toEqual(['a', 'c']);
  });

  it('clears detail on team change and reports a refreshed missing member before focusing the roster', async () => {
    const a = member({ memberId: 'a', name: 'a' }), b = member({ memberId: 'b', name: 'b' });
    const { result } = await renderScreen({ overview: [roster([a, b]), roster([b, a]), roster([b]), roster([a, b], { membersTruncated: true }), roster([b], { membersTruncated: true })] });
    openMember('a');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await act(async () => {});
    expect(screen.getAllByRole('region', { name: 'a' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Back to members' }));
    openMember('a');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await act(async () => {});
    expect(screen.queryByRole('region', { name: 'a' })).toBeNull();
    expect(screen.getByText('Member "a" is no longer in this team. Showing all members.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Members' }));
    expect(names()).toEqual(['b']);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await act(async () => {});
    openMember('a');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await act(async () => {});
    expect(screen.getByText('Member "a" is not among the returned members (the member list is truncated). Showing the returned members.')).toBeTruthy();
    result.unmount();
  });

  it('keeps filters across same-team reconnection and resets them on workspace change', async () => {
    const fake = fakeManagement({ overview: [roster(trio()), roster(trio()), roster(trio())] });
    const ui = (state: 'connected' | 'lost', ws = workspaceA) => <TeamsHarness sidebar workspace={ws} management={fake.api} connection={connectionFixture(state)} />;
    const result = render(ui('connected'));
    await act(async () => {});
    fireEvent.change(search(), { target: { value: 'alpha' } });
    fireEvent.change(avail(), { target: { value: 'busy' } });
    result.rerender(ui('lost'));
    result.rerender(ui('connected'));
    await act(async () => {});
    expect(search().value).toBe('alpha'); expect(avail().value).toBe('busy');
    result.rerender(ui('connected', { ...workspaceA, id: 'ws-b' }));
    await act(async () => {});
    expect(search().value).toBe(''); expect(avail().value).toBe('');
  });

  it('clears detail and filters when switching to another team', async () => {
    const { result } = await renderScreen();
    fireEvent.change(search(), { target: { value: 'dev' } });
    fireEvent.change(avail(), { target: { value: 'busy' } });
    openMember('dev');
    fireEvent.click(teamRow(result.getByRole('navigation', { name: 'Harness sidebar' }), 'Release Team'));
    await act(async () => {});
    expect(screen.queryByRole('region', { name: 'dev' })).toBeNull();
    expect(search().value).toBe('');
    expect(avail().value).toBe('');
  });
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
    expect(screen.getByText('Member "qa" is no longer in this team. Showing all members.').getAttribute('role')).toBe('status');
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
    expect(screen.getByText('Member "qa" is not among the returned members (the member list is truncated). Showing the returned members.').getAttribute('role')).toBe('status');
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
    fireEvent.click(screen.getByRole('tab', {name: 'Overview'})); expect(screen.getByText('This team has no members.')).toBeTruthy(); expect(screen.queryByRole('list', {name: /^Members of /})).toBeNull(); empty.result.unmount();
    const members = Array.from({length: 16}, (_, i) => member({memberId: `m${i}`, name: `m${i}`}));
    await renderScreen({overview: [{ok: true, data: overviewFixture([team({members, membersTruncated: true})])}]});
    expect(within(showMembers()).getAllByRole('listitem')).toHaveLength(16); expect(screen.getByText('Showing 16 of 16 returned members. More members may exist; filters apply only to returned members.')).toBeTruthy();
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
  const view = render(<TeamsHarness workspace={workspaceA} management={fake.api} onViewRole={onViewRole} />);
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
    expect(document.activeElement).toBe(screen.getByRole('heading', {name: 'dev', level: 2}));
    expect(screen.getByRole('heading', {name: 'Member settings'})).toBeTruthy();
    expect(screen.getByRole('heading', {name: 'Agent options — next team start'})).toBeTruthy();
    expect(screen.getByRole('heading', {name: 'Live', level: 3})).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Back to members'}));
    expect(document.activeElement).toBe(document.querySelector('[data-member-row="dev"]'));
  });
  it('member_detail_leads_with_one_live_section_without_duplicate_summary', async () => {
    await renderScreen(); showMembers(); const detail = openMember('dev');
    const h2 = within(detail).getByRole('heading', {name: 'dev', level: 2});
    const live = within(detail).getByRole('heading', {name: 'Live', level: 3});
    const settings = within(detail).getByRole('heading', {name: 'Member settings'});
    expect(h2.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(live.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(detail).getAllByRole('region', {name: 'Live for dev'})).toHaveLength(1);
    const region = within(detail).getByRole('region', {name: 'Live for dev'});
    for (const label of ['Active agent', 'Availability']) {
      expect(within(detail).getAllByText(label)).toHaveLength(1);
      expect(within(region).getAllByText(label)).toHaveLength(1);
    }
    expect(detail.textContent).not.toContain('Current work:');
    expect(detail.textContent).not.toContain('Live state comes from the running team');
  });
  it('member_detail_live_section_uses_runtime_assignment_ticket_and_unavailable_copy', async () => {
    const running = {state: 'running' as const, teamId: 't', status: 'running'};
    const live = {...twoTeams().teams[1]!.members[0]!.runtime!, configuredAgents: ['opencode-sonnet', 'codex-gpt'], activeAgent: 'opencode-sonnet', paneState: 'alive', availability: 'idle'};
    const work = {state: 'working' as const, assignment: {id: 'as-1', status: 'working', taskId: 'task-1', goal: 'Ship it', workflowRunId: null}, ticket: {key: 'T-9', title: 'Nine', status: 'doing', workflowRunId: null}};
    const members = [
      member({memberId: 'run', name: 'run', runtime: {...live, assignment: {id: 'as-1', status: 'working', taskId: 'task-1'}, provider: 'actual-p', model: null, reasoning: null}, work}),
      member({memberId: 'none', name: 'none', runtime: null}),
      member({memberId: 'old', name: 'old', runtime: {...live, stale: true, configuredAgents: null}, agentOptions: [{id: 'saved-only', name: null, provider: null, model: null, reasoning: null, description: null, state: 'ok'}]}),
      member({memberId: 'gone', name: 'gone', runtime: {...live, activeAgent: null, paneState: null, provider: null, model: null, reasoning: null}, work: {state: 'unavailable', reason: 'board offline'}}),
    ];
    await renderMembers({overview: [{ok: true, data: overviewFixture([team({runtime: running, members})])}]});
    let region = within(openMember('run')).getByRole('region', {name: 'Live for run'});
    expect(region.textContent).toContain('as-1 · working · task-1');
    expect(region.textContent).toContain('T-9 · Nine · doing');
    expect(region.textContent).toContain('actual-p');
    fireEvent.click(screen.getByRole('button', {name: 'Back to members'}));
    region = within(openMember('none')).getByRole('region', {name: 'Live for none'});
    expect(region.textContent).toContain('Live state is unavailable because this member has no running runtime record.');
    expect(within(region).queryByRole('button')).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'Back to members'}));
    region = within(openMember('old')).getByRole('region', {name: 'Live for old'});
    expect(region.textContent).toContain('Live state is stale.');
    expect(region.textContent).not.toContain('saved-only');
    expect(within(region).queryByRole('button', {name: 'Switch'})).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'Back to members'}));
    region = within(openMember('gone')).getByRole('region', {name: 'Live for gone'});
    expect(region.textContent).toContain('Unknown');
    expect(region.textContent).toContain('Pane state unavailable');
    expect(region.textContent).toContain('Current work unavailable — board offline');
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

const okR = <T,>(data: T) => ({ ok: true as const, data });
const board = () => screen.getByRole('region', { name: 'Board' });
const calls = (fake: ReturnType<typeof fakeManagement>) => [fake.overview, fake.agents, fake.boardSettings, fake.roles].map(f => f.mock.calls.length);
const btn = (r: { getByRole: (role: string, o: { name: string | RegExp }) => HTMLElement }, name: string | RegExp) => r.getByRole('button', { name }) as HTMLButtonElement;

describe('T-082 states', () => {
  it('member_activation_focuses_the_member_detail_h2', async () => {
    await renderMembers();
    fireEvent.click(memberRow('dev'));
    const heading = screen.getByRole('heading', { name: 'dev', level: 2 });
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(heading);
  });

  it('refresh_is_single_flight_and_waits_for_every_section_before_success', async () => {
    const gate = deferred<ReturnType<typeof okR<ReturnType<typeof twoTeams>>>>();
    const { fake, result } = await renderScreen({ overview: [okR(twoTeams()), gate.promise] });
    const refresh = btn(result, 'Refresh');
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    await act(async () => {});
    expect(calls(fake)).toEqual([2, 2, 2, 2]);
    expect(result.queryByText('Teams data refreshed.')).toBeNull();
    await act(async () => { gate.resolve(okR(twoTeams())); });
    expect(result.getByRole('status').textContent).toContain('Teams data refreshed.');
    expect(document.activeElement).toBe(refresh);
  });

  it('mixed_refresh_failure_does_not_announce_success_and_retries_only_failed_source', async () => {
    const { fake, result } = await renderScreen({
      roles: [okR(rolesFixture()), managementError('ROLES_DOWN', 'catalog unavailable', 'Check roles.'), okR(rolesFixture())],
    });
    const refresh = btn(result, 'Refresh');
    refresh.focus();
    fireEvent.click(refresh);
    await act(async () => {});

    expect(calls(fake)).toEqual([2, 2, 2, 2]);
    expect(document.activeElement).toBe(refresh);
    expect(result.queryByText('Teams data refreshed.')).toBeNull();
    expect(result.getByRole('alert').textContent).toContain('ROLES_DOWN: catalog unavailable');
    expect(result.getByRole('alert').textContent).toContain('Showing previously loaded data.');
    expect(result.getByRole('tab', { name: 'Overview' }).hasAttribute('disabled')).toBe(false);

    fireEvent.click(btn(result, 'Retry loading roles'));
    await act(async () => {});
    expect(calls(fake)).toEqual([2, 2, 2, 3]);
    expect(result.queryByRole('alert')).toBeNull();
    expect(result.queryByText('Teams data refreshed.')).toBeNull();
  });

  it('initial_loading_and_empty_workspace_are_truthful', async () => {
    const pending = deferred<ReturnType<typeof okR<ReturnType<typeof emptyWorkspace>>>>();
    const fake = fakeManagement({ overview: [pending.promise as never] });
    const result = render(<TeamsHarness workspace={workspaceA} management={fake.api} />);
    await act(async () => {});
    expect(result.getByRole('status').textContent).toBe('Loading teams…');
    expect(result.queryByRole('tablist')).toBeNull();
    expect(btn(result, 'New team').disabled).toBe(true);
    expect(btn(result, 'Refresh').disabled).toBe(false);
    pending.resolve(okR(emptyWorkspace()));
    await act(async () => {});
    expect(result.getByText('No teams defined in this workspace.')).toBeTruthy();
    expect(btn(result, 'New team').disabled).toBe(false);
    expect(result.queryByRole('tablist')).toBeNull();
    expect(result.container.querySelectorAll('.teams-card')).toHaveLength(0);
  });

  it('empty_roster_keeps_add_member_available', async () => {
    const { result } = await renderMembers({ overview: [okR(emptyRoster())] });
    expect(result.getByText('This team has no members.')).toBeTruthy();
    expect(btn(result, 'Add member').disabled).toBe(false);
    expect(result.queryAllByRole('listitem').filter(li => li.querySelector('.teams-member-row'))).toHaveLength(0);
  });

  it('partial_truncated_and_unavailable_notices_use_returned_data', async () => {
    const unavailable = await renderScreen({ overview: [okR(runtimeUnavailable('RUNTIME_DOWN', 'tmux is not reachable'))] });
    expect(within(unavailable.result.getByRole('list', { name: 'Data notices' })).getByText('Live team state unavailable — tmux is not reachable')).toBeTruthy();
    unavailable.result.unmount();
    const stopped = await renderScreen({ overview: [okR(coordinatorStopped())] });
    expect(stopped.result.getByText(/Coordinator/)).toBeTruthy();
    expect(btn(stopped.result, 'Run board').disabled).toBe(true);
    stopped.result.unmount();
    const partial = await renderScreen({ overview: [okR(partialOverview())] });
    expect(partial.result.getByText('Some team definitions could not be read.')).toBeTruthy();
    partial.result.unmount();
    const truncated = await renderScreen({ overview: [okR(truncatedOverview())] });
    expect(within(truncated.result.getByRole('list', { name: 'Data notices' })).getByText(/Showing the first 1 team\. More teams exist/)).toBeTruthy();
    expect(within(truncated.result.getByRole('navigation', { name: 'Harness sidebar' })).getByText(/Showing the first 1 team\. More teams exist/)).toBeTruthy();
    expect(truncated.result.queryByText(/of \d+ teams/)).toBeNull();
    truncated.result.unmount();
    await renderMembers({ overview: [okR(memberTruncatedOverview())] });
    expect(screen.getByText('Showing 1 of 1 returned members. More members may exist; filters apply only to returned members.')).toBeTruthy();
  });

  it('failed_refresh_retains_stale_overview_and_retries_only_overview', async () => {
    const runBoard = vi.fn();
    const { fake, result } = await renderScreen({ overview: [okR(twoTeams()), managementError('READ_FAILED', 'overview unreadable', 'Check the coordinator.'), okR(twoTeams())], calls: { runBoard } });
    expect(btn(result, 'Run board').disabled).toBe(false);
    fireEvent.click(btn(result, 'Refresh'));
    await act(async () => {});
    expect(calls(fake)).toEqual([2, 2, 2, 2]);
    expect(document.activeElement).toBe(btn(result, 'Refresh'));
    const alerts = result.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toContain('Showing previously loaded data.');
    expect(alerts[0]!.textContent).toContain('READ_FAILED: overview unreadable');
    expect(alerts[0]!.textContent).toContain('Check the coordinator.');
    expect(teamRow(result.container, 'Dev Team')).toBeTruthy();
    expect(btn(result, 'New team').disabled).toBe(true);
    expect(btn(result, 'Rename team').disabled).toBe(true);
    expect(btn(result, 'Run board').disabled).toBe(true);
    fireEvent.click(btn(result, 'Run board'));
    expect(runBoard).not.toHaveBeenCalled();
    expect(result.getByRole('tab', { name: 'Overview' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(btn(result, 'Retry'));
    await act(async () => {});
    expect(calls(fake)).toEqual([3, 2, 2, 2]);
    expect(result.queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(document.getElementById('teams-detail-title'));
    expect(btn(result, 'New team').disabled).toBe(false);
    expect(btn(result, 'Run board').disabled).toBe(false);
  });

  it('open_team_write_forms_disable_submit_when_overview_goes_stale', async () => {
    const { result } = await renderScreen({ overview: [okR(twoTeams()), managementError('READ_FAILED', 'overview unreadable'), managementError('READ_FAILED', 'overview unreadable')] });
    fireEvent.click(btn(result, 'Rename team'));
    expect(btn(result, 'Save name').disabled).toBe(false);
    fireEvent.click(btn(result, 'Refresh')); await act(async () => {});
    expect(btn(result, 'Save name').disabled).toBe(true);
    expect(btn(result, 'Cancel').disabled).toBe(false);
    result.unmount();
    const del = await renderScreen({ overview: [okR(twoTeams()), managementError('READ_FAILED', 'overview unreadable')] });
    fireEvent.click(btn(del.result, 'Delete team'));
    expect(btn(del.result, 'Confirm delete').disabled).toBe(false);
    fireEvent.click(btn(del.result, 'Refresh')); await act(async () => {});
    expect(btn(del.result, 'Confirm delete').disabled).toBe(true);
    expect(btn(del.result, 'Cancel').disabled).toBe(false);
  });

  it('open_new_team_form_disables_creation_when_connection_is_lost', async () => {
    const createTeam = vi.fn();
    const fake = fakeManagement({ calls: { createTeam } });
    const ui = (state: 'connected' | 'lost') => <TeamsHarness workspace={workspaceA} management={fake.api} connection={connectionFixture(state)} />;
    const result = render(ui('connected'));
    await act(async () => {});
    fireEvent.click(btn(result, 'New team'));
    fireEvent.change(result.getByLabelText('Team name'), { target: { value: 'New team name' } });
    expect(btn(result, 'Create team').disabled).toBe(false);
    result.rerender(ui('lost'));
    expect(btn(result, 'Create team').disabled).toBe(true);
    expect(btn(result, 'Cancel').disabled).toBe(false);
    fireEvent.click(btn(result, 'Create team'));
    expect(createTeam).not.toHaveBeenCalled();
    expect((result.getByLabelText('Team name') as HTMLInputElement).value).toBe('New team name');
  });

  it('member_validation_alert_does_not_duplicate_section_error_alert', async () => {
    await renderMembers({ roles: [managementError('ROLES_DOWN', 'roles unreadable')] });
    fireEvent.click(memberRow('dev')); await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Edit dev' })); await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /^Remove OpenCode Sonnet/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save member' })); await act(async () => {});
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).not.toContain('ROLES_DOWN');
    expect(document.body.textContent).toContain('ROLES_DOWN: roles unreadable');
  });

  it.each(['roles', 'agents'] as const)('stale %s catalog blocks dependent member changes until retry', async (source) => {
    const updateMember = vi.fn();
    const failure = managementError('CATALOG_DOWN', 'catalog unavailable');
    const opts = source === 'roles'
      ? { roles: [okR(rolesFixture()), failure, okR(rolesFixture())] }
      : { agents: [okR(catalogFixture()), failure, okR(catalogFixture())] };
    await renderMembers({ ...opts, calls: { updateMember } });
    fireEvent.click(memberRow('dev')); await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Edit dev' }));
    if (source === 'roles') fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'Reviewer' } });
    else fireEvent.change(screen.getByLabelText('Add agent option'), { target: { value: 'spare' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await act(async () => {});
    const save = screen.getByRole('button', { name: 'Save member' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.submit(save.closest('form')!);
    expect(updateMember).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: source === 'roles' ? 'Retry loading roles' : 'Retry loading agents' }));
    await act(async () => {});
    expect(save.disabled).toBe(false);
    if (source === 'roles') expect((screen.getByLabelText('Role') as HTMLSelectElement).value).toBe('Reviewer');
    else expect(screen.getByRole('button', { name: 'Remove Spare agent' })).toBeTruthy();
  });

  it.each(['roles', 'agents'] as const)('pending %s refresh blocks dependent member changes until fresh data arrives', async (source) => {
    const updateMember = vi.fn();
    const roleGate = deferred<ReturnType<typeof okR<ReturnType<typeof rolesFixture>>>>();
    const agentGate = deferred<ReturnType<typeof okR<ReturnType<typeof catalogFixture>>>>();
    const opts = source === 'roles'
      ? { roles: [okR(rolesFixture()), roleGate.promise] }
      : { agents: [okR(catalogFixture()), agentGate.promise] };
    await renderMembers({ ...opts, calls: { updateMember } });
    fireEvent.click(memberRow('dev')); await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Edit dev' }));
    if (source === 'roles') fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'Reviewer' } });
    else fireEvent.change(screen.getByLabelText('Add agent option'), { target: { value: 'spare' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await act(async () => {});
    const save = screen.getByRole('button', { name: 'Save member' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.submit(save.closest('form')!);
    expect(updateMember).not.toHaveBeenCalled();
    await act(async () => {
      if (source === 'roles') roleGate.resolve(okR(rolesFixture()));
      else agentGate.resolve(okR(catalogFixture()));
    });
    expect(save.disabled).toBe(false);
    if (source === 'roles') expect((screen.getByLabelText('Role') as HTMLSelectElement).value).toBe('Reviewer');
    else expect(screen.getByRole('button', { name: 'Remove Spare agent' })).toBeTruthy();
  });

  it('stale catalogs do not block an unrelated member name change', async () => {
    const updateMember = vi.fn(async () => okR({ team: {}, member: { name: 'Renamed' }, problems: [], appliesOnNextStart: false }));
    await renderMembers({ roles: [managementError('ROLES_DOWN', 'roles unavailable')], agents: [managementError('AGENTS_DOWN', 'agents unavailable')], calls: { updateMember } });
    fireEvent.click(memberRow('dev')); await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Edit dev' }));
    fireEvent.change(screen.getByLabelText('Member name'), { target: { value: 'Renamed' } });
    const save = screen.getByRole('button', { name: 'Save member' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save); await act(async () => {});
    expect(updateMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', { name: 'Renamed' });
  });

  it('refresh_with_overview_and_board_pending_announces_one_status', async () => {
    const o = deferred<ReturnType<typeof okR<ReturnType<typeof twoTeams>>>>();
    const b = deferred<ReturnType<typeof okR<ReturnType<typeof boardSettingsFixture>>>>();
    const { fake, result } = await renderScreen();
    fake.overview.mockImplementationOnce(() => o.promise);
    fake.boardSettings.mockImplementationOnce(() => b.promise);
    fireEvent.click(btn(result, 'Refresh')); await act(async () => {});
    expect(result.getAllByRole('status')).toHaveLength(1);
    expect(document.body.textContent).toContain('Refreshing board state');
    o.resolve(okR(twoTeams())); b.resolve(okR(boardSettingsFixture())); await act(async () => {});
  });

  it('connecting_while_overview_pending_announces_one_status', async () => {
    const o = deferred<ReturnType<typeof okR<ReturnType<typeof twoTeams>>>>();
    const fake = fakeManagement();
    fake.overview.mockImplementationOnce(() => o.promise);
    const result = render(<TeamsHarness workspace={workspaceA} management={fake.api} connection={connectionFixture('connecting')} />);
    await act(async () => {});
    expect(result.getAllByRole('status')).toHaveLength(1);
    expect(document.body.textContent).toContain('Connecting to Agent Studio…');
    expect(document.body.textContent).toContain('Loading teams…');
    o.resolve(okR(twoTeams())); await act(async () => {});
  });

  it('catalog_role_and_board_failures_are_independent', async () => {
    const { fake, result } = await renderScreen({
      roles: [managementError('ROLES_DOWN', 'roles unreadable'), managementError('ROLES_DOWN', 'still unreadable'), okR(invalidRoleCatalog())],
      agents: [managementError('AGENTS_DOWN', 'agents unreadable', 'Fix agents.json.')],
      boardSettings: [managementError('BOARD_DOWN', 'board unreadable')],
    });
    expect(result.getAllByRole('alert')).toHaveLength(1);
    const errors = Array.from(document.querySelectorAll('.panel-error'));
    expect(errors.map(a => a.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('ROLES_DOWN: roles unreadable'), expect.stringContaining('Fix agents.json.'), expect.stringContaining('BOARD_DOWN: board unreadable')]));
    for (const a of errors) expect(within(a as HTMLElement).getAllByRole('button')).toHaveLength(1);
    expect(errors.every(a => /\S/.test(a.querySelectorAll('p')[1]?.textContent ?? ''))).toBe(true);
    expect(result.queryByRole('button', { name: 'Run board' })).toBeNull();
    expect(calls(fake)).toEqual([1, 1, 1, 1]);
    fireEvent.click(btn(result, 'Retry loading roles')); await act(async () => {});
    expect(calls(fake)).toEqual([1, 1, 1, 2]);
    expect(document.activeElement).toBe(btn(result, 'Retry loading roles'));
    expect(result.getByRole('alert').textContent).toContain('ROLES_DOWN: still unreadable');
    fireEvent.click(btn(result, 'Retry loading roles')); await act(async () => {});
    expect(calls(fake)).toEqual([1, 1, 1, 3]);
    expect(result.queryByRole('button', { name: 'Retry loading roles' })).toBeNull();
    expect(document.activeElement).toBe(document.getElementById('teams-detail-title'));
    expect(result.getByRole('button', { name: 'Retry loading agents' })).toBeTruthy();
    fireEvent.click(within(board()).getByRole('button', { name: 'Retry' })); await act(async () => {});
    expect(calls(fake)).toEqual([1, 1, 2, 3]);
  });

  it('connecting_lost_and_reconnected_disable_only_unsafe_actions', async () => {
    const writes = Object.fromEntries(['createTeam', 'renameTeam', 'deleteTeam', 'addMember', 'updateMember', 'removeMember', 'runBoard', 'stopBoard'].map(n => [n, vi.fn()]));
    const fake = fakeManagement({ calls: writes });
    const ui = (state: 'connecting' | 'connected' | 'lost') => <TeamsHarness workspace={workspaceA} management={fake.api} connection={connectionFixture(state)} />;
    const result = render(ui('connecting'));
    await act(async () => {});
    expect(result.getByText('Connecting to Agent Studio…')).toBeTruthy();
    result.rerender(ui('connected')); await act(async () => {});
    expect(result.queryByText('Connecting to Agent Studio…')).toBeNull();
    expect(calls(fake)).toEqual([2, 2, 2, 2]);
    result.rerender(ui('lost')); await act(async () => {});
    expect(result.getByText('Connection lost. Showing previously loaded data.')).toBeTruthy();
    expect(btn(result, 'New team').disabled).toBe(true);
    expect(btn(result, 'Rename team').disabled).toBe(true);
    expect(btn(result, 'Run board').disabled).toBe(true);
    expect(btn(result, 'Refresh').disabled).toBe(false);
    expect(result.getByRole('tab', { name: 'Routing' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(result.getByRole('tab', { name: 'Overview' }));
    expect(openMember('dev')).toBeTruthy();
    expect(btn(result, 'Edit dev').disabled).toBe(true);
    expect(btn(result, 'Back to members').disabled).toBe(false);
    result.rerender(ui('connected')); await act(async () => {});
    expect(calls(fake)).toEqual([3, 3, 3, 3]);
    expect(btn(result, 'Edit dev').disabled).toBe(false);
    expect(result.getByRole('region', { name: 'dev' })).toBeTruthy();
    for (const write of Object.values(writes)) expect(write).not.toHaveBeenCalled();
  });

  it('team_tabs_roving_and_sidebar_native_keyboard_behavior', async () => {
    const { result } = await renderScreen();
    const tabs = result.getAllByRole('tab');
    expect(tabs.filter(t => t.tabIndex === 0)).toHaveLength(1);
    tabs[0]!.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(result.getByRole('tab', { name: 'Routing' }));
    expect(result.getByRole('tab', { name: 'Routing' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(result.getByRole('tab', { name: 'Overview' }));
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(result.getByRole('tab', { name: 'Routing' }));
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(result.getByRole('tab', { name: 'Overview' }));
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(result.getByRole('tab', { name: 'Routing' }));
    await userEvent.keyboard('{Home}');
    expect(result.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
    const cards = within(result.getByRole('list', { name: 'Workspace teams' })).getAllByRole('button');
    expect(cards.every(c => c.tabIndex === 0)).toBe(true);
    cards[1]!.focus();
    await userEvent.keyboard('{Enter}');
    expect(document.activeElement).toBe(document.getElementById('teams-detail-title'));
    expect(document.getElementById('teams-detail-title')!.textContent).toBe(cards[1]!.querySelector('.team-nav-label')!.textContent);
    expect(cards[1]!.getAttribute('aria-current')).toBe('page');
    cards[0]!.focus();
    await userEvent.keyboard(' ');
    expect(document.activeElement).toBe(document.getElementById('teams-detail-title'));
    expect(document.getElementById('teams-detail-title')!.textContent).toBe(cards[0]!.querySelector('.team-nav-label')!.textContent);
  });

  it('refresh_never_moves_focus_to_another_team', async () => {
    const { result } = await renderScreen();
    const list = result.getByRole('list', { name: 'Workspace teams' });
    const second = within(list).getAllByRole('button')[1]!;
    second.focus(); await userEvent.keyboard('{Enter}');
    const heading = document.getElementById('teams-detail-title')!;
    const name = heading.textContent;
    fireEvent.click(btn(result, 'Refresh')); await act(async () => {});
    expect(document.activeElement).toBe(btn(result, 'Refresh'));
    expect(document.getElementById('teams-detail-title')!.textContent).toBe(name);
  });

  it('member_open_back_save_remove_and_error_focus_is_deterministic', async () => {
    const updateMember = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'BAD_REQUEST', message: 'nope', retryable: false } })
      .mockResolvedValue(okR({ team: { id: 'dev-team', name: 'Dev Team', members: [] }, member: { id: 'dev', name: 'dev2', role: 'Developer' }, appliesOnNextStart: true, problems: [] }));
    const removeMember = vi.fn().mockResolvedValue({ ok: false, error: { code: 'TEAM_ALREADY_RUNNING', message: 'running', retryable: false } });
    await renderMembers({ calls: { updateMember, removeMember } });
    const row = memberRow('dev');
    fireEvent.click(row); await act(async () => {});
    const heading = screen.getByRole('heading', { name: 'dev', level: 2 });
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
    fireEvent.click(screen.getByRole('button', { name: 'Back to members' })); await act(async () => {});
    expect(document.activeElement).toBe(memberRow('dev'));
    fireEvent.click(memberRow('dev')); await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Edit dev' })); await act(async () => {});
    fireEvent.change(screen.getByLabelText('Member name'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save member' })); await act(async () => {});
    expect(updateMember).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText('Member name'));
    fireEvent.change(screen.getByLabelText('Member name'), { target: { value: 'dev2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save member' })); await act(async () => {});
    expect(updateMember).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save member' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); await act(async () => {});
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit dev' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove dev' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel removing dev' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove dev' })); await act(async () => {});
    expect(removeMember).toHaveBeenCalledWith(workspaceA.id, 'dev-team', 'dev');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm remove dev' }));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' }); await act(async () => {});
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove dev' }));
  });

  it('successful_member_edit_retains_selection_and_focuses_updated_heading', async () => {
    const refreshed = twoTeams();
    refreshed.teams[1]!.members[0]!.name = 'Updated developer';
    const updateMember = vi.fn().mockResolvedValue(okR({ team: { id: 'dev-team', name: 'Dev Team', members: [] }, member: { id: 'dev', name: 'Updated developer', role: 'Developer' }, appliesOnNextStart: true, problems: [] }));
    await renderMembers({ overview: [okR(twoTeams()), okR(refreshed)], calls: { updateMember } });
    openMember('dev');
    fireEvent.click(screen.getByRole('button', { name: 'Edit dev' }));
    fireEvent.change(screen.getByLabelText('Member name'), { target: { value: 'Updated developer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save member' }));
    await act(async () => {});
    expect(updateMember).toHaveBeenCalledWith(workspaceA.id, 'dev-team', 'dev', { name: 'Updated developer' });
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Updated developer', level: 2 }));
    expect(screen.queryByRole('button', { name: 'Save member' })).toBeNull();
  });

  it('successful_removal_clears_detail_and_focuses_the_next_action_after_refresh', async () => {
    const initial = twoTeams();
    const refreshed = twoTeams();
    refreshed.teams[1]!.members = refreshed.teams[1]!.members.filter(m => m.memberId !== 'dev');
    const removeMember = vi.fn().mockResolvedValue(okR({ removed: { id: 'dev', name: 'dev' }, problems: [] }));
    const { result } = await renderMembers({ overview: [okR(initial), okR(refreshed)], calls: { removeMember } });
    openMember('dev');
    fireEvent.click(btn(result, 'Remove dev'));
    fireEvent.click(btn(result, 'Confirm remove dev'));
    await act(async () => {});
    expect(removeMember).toHaveBeenCalledWith(workspaceA.id, 'dev-team', 'dev');
    expect(result.queryByRole('region', { name: 'dev' })).toBeNull();
    expect(result.queryByRole('button', { name: /^dev\b/ })).toBeNull();
    expect(memberRow('lead')).toBeTruthy();
    expect(document.activeElement).toBe(btn(result, 'Add member'));
  });

  it('status_and_missing_evidence_are_not_color_only', async () => {
    const o = overviewFixture([team({ members: [
      member({ memberId: 'a', name: 'a', presence: 'limit_reached', work: { state: 'unavailable', reason: 'offline' } }),
      member({ memberId: 'b', name: 'b', presence: 'brand_new_state', role: null, roleState: 'undefined' as never, agentDefId: null, provider: null, model: null, agentOptions: [], defaultAgent: null }),
    ] })]);
    const { result } = await renderMembers({ overview: [okR(o)] });
    for (const dot of Array.from(result.container.querySelectorAll('.status-dot'))) {
      expect(dot.getAttribute('aria-hidden')).toBe('true');
      expect(dot.parentElement!.textContent!.trim().length).toBeGreaterThan(0);
    }
    for (const badge of Array.from(result.container.querySelectorAll('.status-badge'))) expect(badge.textContent!.trim()).not.toBe('');
    expect(field(memberRow('a'), 'availability')).toBe('Limit reached');
    expect(field(memberRow('a'), 'work')).toBe('Not available — offline');
    expect(field(memberRow('b'), 'availability').length).toBeGreaterThan(0);
    expect(field(memberRow('b'), 'role').length).toBeGreaterThan(0);
    expect(field(memberRow('b'), 'agent').length).toBeGreaterThan(0);
  });

  it('no_illustrative_design_data_is_rendered', async () => {
    const empty = await renderScreen({ overview: [okR(emptyWorkspace())], agents: [okR(catalogFixture({ agents: [] }))], boardSettings: [okR(boardSettingsFixture())], roles: [okR(invalidRoleCatalog())] });
    const text = empty.result.container.textContent!;
    for (const sample of ['Dev Team', 'Release Team', 'OpenCode', 'Codex', 'Claude', 'gpt', 'sonnet', 'T-0', 'running', 'idle']) expect(text).not.toContain(sample);
    expect(empty.result.container.querySelectorAll('.status-badge')).toHaveLength(0);
    empty.result.unmount();
    const long = await renderMembers({ overview: [okR(longContentOverview())], boardSettings: [okR(missingBoardSettings())] });
    expect(long.result.container.textContent).toContain(LONG_UNBROKEN);
    expect(long.result.container.textContent).not.toContain('Dev Team');
    long.result.unmount();
    const invalid = await renderScreen({ boardSettings: [okR(invalidBoardSettings())] });
    expect(invalid.result.container.textContent).not.toContain('Release Team→');
  });
  it('cancel_rename_and_delete_restore_focus_to_the_invoking_action', async () => {
    const { result } = await renderScreen();
    for (const name of ['Rename team', 'Delete team']) {
      fireEvent.click(btn(result, name));
      fireEvent.click(btn(result, 'Cancel'));
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
      expect(document.activeElement).toBe(btn(result, name));
    }
  });

  it('catalog_retry_in_empty_workspace_focuses_an_existing_heading', async () => {
    const { result } = await renderScreen({ overview: [okR(overviewFixture([]))], roles: [managementError('ROLES_DOWN', 'roles unreadable'), okR(rolesFixture())] });
    fireEvent.click(btn(result, 'Retry loading roles')); await act(async () => {});
    expect(document.activeElement).toBe(document.getElementById('teams-list-title'));
  });

  it('cancelling_new_team_restores_focus_to_its_invoking_action', async () => {
    const { result } = await renderScreen({ overview: [okR(overviewFixture([]))] });
    const opener = btn(result, 'New team');
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(btn(result, 'Cancel'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(document.activeElement).toBe(opener);
  });

  it('agent_catalog_retry_in_empty_workspace_restores_focus_on_failure_and_success', async () => {
    const { result, fake } = await renderScreen({
      overview: [okR(overviewFixture([]))],
      agents: [managementError('AGENTS_DOWN', 'agents unreadable'), managementError('AGENTS_DOWN', 'still unreadable'), okR(catalogFixture())],
    });
    const retry = btn(result, 'Retry loading agents');
    retry.focus();
    fireEvent.click(retry);
    await act(async () => {});
    expect(document.activeElement).toBe(btn(result, 'Retry loading agents'));
    expect(result.getByRole('alert').textContent).toContain('AGENTS_DOWN: still unreadable');
    fireEvent.click(btn(result, 'Retry loading agents'));
    await act(async () => {});
    expect(document.activeElement).toBe(document.getElementById('teams-list-title'));
    expect(fake.agents).toHaveBeenCalledTimes(3);
    expect(fake.overview).toHaveBeenCalledTimes(1);
  });
});

it('pending_role_and_agent_catalog_loads_are_named_with_one_status', async () => {
  const rolesGate = deferred<ReturnType<typeof okR<ReturnType<typeof teamRolesFixture>>>>();
  const agentsGate = deferred<ReturnType<typeof okR<ReturnType<typeof catalogFixture>>>>();
  const fake = fakeManagement({ roles: [rolesGate.promise as never], agents: [agentsGate.promise as never] });
  const view = render(<TeamsHarness workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  expect(view.getByText('Loading the role catalog…')).toBeTruthy();
  expect(view.getByText('Loading the agent catalog…')).toBeTruthy();
  expect(view.queryAllByRole('status').length).toBeLessThanOrEqual(1);
  await act(async () => { rolesGate.resolve(okR(teamRolesFixture())); agentsGate.resolve(okR(catalogFixture())); });
  expect(view.queryByText('Loading the role catalog…')).toBeNull();
});

it('refreshing_catalogs_identify_retained_data_until_each_load_succeeds', async () => {
  const rolesGate = deferred<ReturnType<typeof okR<ReturnType<typeof teamRolesFixture>>>>();
  const agentsGate = deferred<ReturnType<typeof okR<ReturnType<typeof catalogFixture>>>>();
  const fake = fakeManagement({ roles: [okR(teamRolesFixture()), rolesGate.promise], agents: [okR(catalogFixture()), agentsGate.promise] });
  const view = render(<TeamsHarness workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
  await act(async () => {});

  expect(view.getByText('Refreshing the role catalog… Showing previously loaded data.')).toBeTruthy();
  expect(view.getByText('Refreshing the agent catalog… Showing previously loaded data.')).toBeTruthy();
  expect(view.getAllByRole('status')).toHaveLength(1);
  await act(async () => { rolesGate.resolve(okR(teamRolesFixture())); });
  expect(view.queryByText('Refreshing the role catalog… Showing previously loaded data.')).toBeNull();
  expect(view.getByRole('status').textContent).toContain('Refreshing the agent catalog');
  await act(async () => { agentsGate.resolve(okR(catalogFixture())); });
  expect(view.queryByText('Refreshing the agent catalog… Showing previously loaded data.')).toBeNull();
});

it.each(['roles', 'agents'] as const)('failed %s refresh remains independent of the other pending catalog', async (failed) => {
  const rolesGate = deferred<ReturnType<typeof okR<ReturnType<typeof teamRolesFixture>>> | ReturnType<typeof managementError>>();
  const agentsGate = deferred<ReturnType<typeof okR<ReturnType<typeof catalogFixture>>> | ReturnType<typeof managementError>>();
  const fake = fakeManagement({
    roles: [okR(teamRolesFixture()), rolesGate.promise, okR(teamRolesFixture())],
    agents: [okR(catalogFixture()), agentsGate.promise, okR(catalogFixture())],
  });
  const view = render(<TeamsHarness workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
  await act(async () => {});
  await act(async () => {
    if (failed === 'roles') rolesGate.resolve(managementError('CATALOG_DOWN', 'Role catalog failed', 'Retry roles.'));
    else agentsGate.resolve(managementError('CATALOG_DOWN', 'Agent catalog failed', 'Retry agents.'));
  });
  const remaining = failed === 'roles' ? 'agent' : 'role';
  expect(view.getByRole('alert').textContent).toContain('CATALOG_DOWN:');
  expect(view.getByRole('alert').textContent).toContain('Showing previously loaded data.');
  expect(view.getByRole('status').textContent).toContain(`Refreshing the ${remaining} catalog`);
  expect(view.queryByText('Teams data refreshed.')).toBeNull();
  await act(async () => {
    if (failed === 'roles') agentsGate.resolve(okR(catalogFixture()));
    else rolesGate.resolve(okR(teamRolesFixture()));
  });
  fireEvent.click(view.getByRole('button', { name: `Retry loading ${failed}` }));
  await act(async () => {});
  expect(view.queryByRole('alert')).toBeNull();
  expect(calls(fake)).toEqual(failed === 'roles' ? [2, 2, 2, 3] : [2, 3, 2, 2]);
});

it.each(['roles', 'agents'] as const)('initial_%s_catalog_load_is_announced_when_other_sections_are_ready', async (source) => {
  const gate = deferred<ReturnType<typeof okR<ReturnType<typeof teamRolesFixture> | ReturnType<typeof catalogFixture>>>>();
  const fake = fakeManagement({ [source]: [gate.promise] } as Parameters<typeof fakeManagement>[0]);
  const view = render(<TeamsHarness workspace={workspaceA} management={fake.api} />);
  await act(async () => {});

  const message = source === 'roles' ? 'Loading the role catalog…' : 'Loading the agent catalog…';
  expect(view.getByText(message)).toBeTruthy();
  expect(view.getAllByRole('status')).toHaveLength(1);
  expect(view.getByRole('status').textContent).toContain(message);

  await act(async () => { gate.resolve(okR(source === 'roles' ? teamRolesFixture() : catalogFixture())); });
});

it.each(['roles', 'agents'] as const)('pending_catalog_announcement_moves_to_remaining_source_after_%s_loads', async (first) => {
  const rolesGate = deferred<ReturnType<typeof okR<ReturnType<typeof teamRolesFixture>>>>();
  const agentsGate = deferred<ReturnType<typeof okR<ReturnType<typeof catalogFixture>>>>();
  const fake = fakeManagement({ roles: [rolesGate.promise], agents: [agentsGate.promise] });
  const view = render(<TeamsHarness workspace={workspaceA} management={fake.api} />);
  await act(async () => {});

  expect(view.getByText('Loading the role catalog…')).toBeTruthy();
  expect(view.getByText('Loading the agent catalog…')).toBeTruthy();
  expect(view.getAllByRole('status')).toHaveLength(1);
  expect(view.getByRole('status').textContent).toContain('Loading the role catalog…');

  await act(async () => {
    if (first === 'roles') rolesGate.resolve(okR(teamRolesFixture()));
    else agentsGate.resolve(okR(catalogFixture()));
  });
  const remaining = first === 'roles' ? 'agent' : 'role';
  expect(view.getAllByRole('status')).toHaveLength(1);
  expect(view.getByRole('status').textContent).toContain(`Loading the ${remaining} catalog…`);

  await act(async () => {
    if (first === 'roles') agentsGate.resolve(okR(catalogFixture()));
    else rolesGate.resolve(okR(teamRolesFixture()));
  });
  expect(view.queryByText('Loading the role catalog…')).toBeNull();
  expect(view.queryByText('Loading the agent catalog…')).toBeNull();
});

it('empty_workspace_shows_board_loading_and_error_with_independent_retry', async () => {
  const fake = fakeManagement({ overview: [okR({ ...twoTeams(), teams: [] })], boardSettings: [managementError('BOARD_DOWN', 'Board is down'), okR(boardSettingsFixture())] });
  const view = render(<TeamsHarness workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  expect(view.getByRole('alert').textContent).toContain('BOARD_DOWN: Board is down');
  expect(view.getAllByRole('alert')).toHaveLength(1);
  fireEvent.click(view.getByRole('button', { name: /Retry/ }));
  await act(async () => {});
  expect(view.queryByRole('alert')).toBeNull();
});

it('successful_board_retry_in_empty_workspace_focuses_an_existing_heading', async () => {
  const fake = fakeManagement({ overview: [okR({ ...twoTeams(), teams: [] })], boardSettings: [managementError('BOARD_DOWN', 'Board is down'), okR(boardSettingsFixture())] });
  const view = render(<TeamsHarness workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  const retry = view.getByRole('button', { name: /Retry/ });
  retry.focus();
  fireEvent.click(retry);
  await act(async () => {});
  expect(view.queryByRole('alert')).toBeNull();
  expect(document.activeElement?.tagName).toMatch(/^H[1-6]$/);
  expect(document.activeElement?.textContent).toBeTruthy();
  expect(document.activeElement?.isConnected).toBe(true);
});

it('failed_board_retry_in_empty_workspace_keeps_focus_and_reloads_only_board', async () => {
  const fake = fakeManagement({
    overview: [okR({ ...twoTeams(), teams: [] })],
    boardSettings: [managementError('BOARD_DOWN', 'Board is down'), managementError('BOARD_DOWN', 'Still unavailable')],
  });
  const view = render(<TeamsHarness workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  const before = calls(fake);
  const retry = view.getByRole('button', { name: /Retry/ });
  retry.focus();
  fireEvent.click(retry);
  await act(async () => {});
  expect(view.getByRole('alert').textContent).toContain('BOARD_DOWN: Still unavailable');
  expect(document.activeElement).toBe(view.getByRole('button', { name: /Retry/ }));
  expect(calls(fake)).toEqual([before[0], before[1], before[2]! + 1, before[3]]);
});

describe('T-084 shared sidebar navigation controller', () => {
  const selectedTabs = (r: ReturnType<typeof render>) => r.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent);
  const liveRuntime = () => ({ ...twoTeams().teams[1]!.members[0]!.runtime!, configuredAgents: ['opencode-sonnet', 'codex-gpt'], activeAgent: 'opencode-sonnet', paneState: 'alive', availability: 'idle' });
  const settle = () => act(async () => {});
  async function renderWithController(opts: Parameters<typeof fakeManagement>[0] = {}, connection?: ReturnType<typeof connectionFixture>) {
    const fake = fakeManagement(opts);
    const ref: { current: TeamsNavigationController | null } = { current: null };
    const keys: Array<string | null> = [];
    const ui = (c?: ReturnType<typeof connectionFixture>) => (
      <TeamsHarness sidebar workspace={workspaceA} management={fake.api} connection={c}
        onController={(controller) => { ref.current = controller; if (keys[keys.length - 1] !== controller.selectedKey) keys.push(controller.selectedKey); }} />
    );
    const result = render(ui(connection));
    await settle();
    return { fake, result, controller: () => ref.current!, keys, ui };
  }

  it('shared_navigation_controller_prevents_second_overview_read', async () => {
    const { fake, result } = await renderWithController();
    const sidebar = result.getByRole('navigation', { name: 'Harness sidebar' });
    fireEvent.click(teamRow(sidebar, 'Release Team'));
    await openTab(result, 'Overview');
    await openTab(result, 'Routing');
    fireEvent.click(teamRow(sidebar, 'Dev Team'));
    expect(fake.overview).toHaveBeenCalledTimes(1);
    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(fake.overview).toHaveBeenCalledTimes(2);
  });

  it('external_team_selection_clears_member_and_returns_to_overview', async () => {
    const { result, controller } = await renderWithController();
    await openTab(result, 'Overview');
    openMember('dev');
    expect(document.getElementById('teams-member-detail-title')).toBeTruthy();
    act(() => controller().selectTeam('release'));
    expect(document.getElementById('teams-member-detail-title')).toBeNull();
    expect(result.getByRole('heading', { level: 2, name: 'Release Team' })).toBeTruthy();
    expect(selectedTabs(result)).toEqual(['Overview']);
    expect(document.activeElement).toBe(document.getElementById('teams-detail-title'));
    act(() => controller().selectTeam('not-a-team'));
    expect(controller().selectedKey).toBe('release');
  });

  it('same_team_selection_intent_returns_routing_to_overview', async () => {
    const { fake, result, controller } = await renderWithController();
    await openTab(result, 'Routing');
    expect(selectedTabs(result)).toEqual(['Routing']);
    const version = controller().selectionVersion;
    act(() => controller().selectTeam('dev-team'));
    expect(controller().selectionVersion).toBe(version + 1);
    expect(selectedTabs(result)).toEqual(['Overview']);
    expect(fake.overview).toHaveBeenCalledTimes(1);
  });

  it('refresh_reorder_preserves_team_tab_member_and_focus', async () => {
    const [release, dev] = [twoTeams().teams[0]!, twoTeams().teams[1]!];
    const after = overviewFixture([{ ...release, runtime: { state: 'running', teamId: 'r', status: 'running' } }, { ...dev, runtime: { state: 'stopped', teamId: null, status: null } }]);
    const { fake, result } = await renderWithController({ overview: [okR(twoTeams()), okR(after)] });
    await openTab(result, 'Overview');
    openMember('dev');
    const row = teamRow(result.getByRole('navigation', { name: 'Harness sidebar' }), 'Dev Team');
    row.focus();
    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(cardNames(result.getByRole('navigation', { name: 'Harness sidebar' }))).toEqual(['Release Team', 'Dev Team']);
    expect(selectedTabs(result)).toEqual(['Overview']);
    expect(document.getElementById('teams-member-detail-title')).toBeTruthy();
    expect(result.getByRole('heading', { level: 2, name: 'Dev Team' })).toBeTruthy();
  });

  it('refresh_removal_clears_confirmation_and_uses_first_ordered_team', async () => {
    const running = { state: 'running' as const, teamId: 't', status: 'running' };
    const live = team({ runtime: running, members: [member({ runtime: liveRuntime() as never })] });
    const other = team({ id: 'other', name: 'Other Team', members: [member({ memberId: 'o', name: 'o' })] });
    const switchMemberAgent = vi.fn().mockResolvedValue({ ok: false, error: { code: 'BAD_REQUEST', message: 'Member has an active assignment; confirm cancellation of this assignment to switch.', retryable: false, data: { assignmentId: 'assignment-A' } } });
    const { result } = await renderWithController({ overview: [okR(overviewFixture([live, other])), okR(overviewFixture([other]))], calls: { switchMemberAgent } });
    await openTab(result, 'Overview');
    openMember('dev');
    fireEvent.click(result.getByRole('button', { name: 'Switch' }));
    await settle();
    expect(result.getByRole('dialog')).toBeTruthy();
    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(result.queryByRole('dialog')).toBeNull();
    expect(result.getByRole('heading', { level: 2, name: 'Other Team' })).toBeTruthy();
    expect(selectedTabs(result)).toEqual(['Overview']);
  });

  it('manual_refresh_reads_overview_agents_roles_and_board_once_each', async () => {
    const { fake, result } = await renderWithController();
    const before = calls(fake);
    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(calls(fake).map((n, i) => n - before[i]!)).toEqual([1, 1, 1, 1]);
  });

  it('reconnect_does_not_duplicate_shared_overview_refresh', async () => {
    const { fake, result, ui } = await renderWithController({}, connectionFixture('connected'));
    const before = calls(fake);
    result.rerender(ui(connectionFixture('lost')));
    await settle();
    expect(calls(fake)).toEqual(before);
    result.rerender(ui(connectionFixture('connected')));
    await settle();
    expect(calls(fake).map((n, i) => n - before[i]!)).toEqual([1, 1, 1, 1]);
  });

  it('create_team_refreshes_then_selects_authoritative_result', async () => {
    const createTeam = vi.fn(async () => okR({ team: teamDefinition({ id: 'qa-team', name: 'QA Team' }), problems: [] }));
    const after = overviewFixture([...twoTeams().teams, team({ id: 'qa-team', name: 'QA Team', members: [] })]);
    const { fake, result, keys } = await renderWithController({ overview: [okR(twoTeams()), okR(after)], calls: { createTeam } });
    fireEvent.click(result.getByRole('button', { name: 'New team' }));
    fireEvent.change(result.getByLabelText('Team name'), { target: { value: 'QA Team' } });
    fireEvent.click(result.getByRole('button', { name: 'Create team' }));
    await settle();
    expect(document.activeElement).not.toBe(document.getElementById('teams-detail-title'));
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(result.getByRole('heading', { level: 2, name: 'QA Team' })).toBeTruthy();
    expect(teamRow(result.getByRole('navigation', { name: 'Harness sidebar' }), 'QA Team').getAttribute('aria-current')).toBe('page');
    expect(keys).toEqual([null, 'dev-team', 'qa-team']);
  });

  it('create_request_from_sidebar_opens_dialog_without_duplicate_overview_read', async () => {
    const { fake, result } = await renderWithController();
    const before = calls(fake);
    fireEvent.click(result.getByRole('button', { name: 'New team' }));
    await settle();
    expect(result.getByRole('dialog', { name: 'New team' })).toBeTruthy();
    expect(result.getAllByRole('button', { name: 'New team' })).toHaveLength(1);
    expect(result.getByRole('button', { name: /^Open Dev Team,/ }).getAttribute('aria-current')).toBe('page');
    expect(calls(fake)).toEqual(before);
  });

  it('confirmed_created_team_opens_overview_and_clears_member_detail', async () => {
    const createTeam = vi.fn(async () => okR({ team: teamDefinition({ id: 'qa-team', name: 'QA Team' }), problems: [] }));
    const after = overviewFixture([...twoTeams().teams, team({ id: 'qa-team', name: 'QA Team', members: [] })]);
    const { result } = await renderWithController({ overview: [okR(twoTeams()), okR(after)], calls: { createTeam } });
    fireEvent.click(tab(result, 'Routing'));
    await settle();
    expect(selectedTabs(result)).toEqual(['Routing']);
    fireEvent.click(result.getByRole('button', { name: 'New team' }));
    await settle();
    expect(selectedTabs(result)).toEqual(['Routing']);
    fireEvent.change(result.getByLabelText('Team name'), { target: { value: 'QA Team' } });
    fireEvent.click(result.getByRole('button', { name: 'Create team' }));
    await settle();
    expect(result.getByRole('heading', { level: 2, name: 'QA Team' })).toBeTruthy();
    expect(selectedTabs(result)).toEqual(['Overview']);
    expect(result.queryByRole('dialog')).toBeNull();
  });
});

