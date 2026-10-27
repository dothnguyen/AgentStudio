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
      'opencode · claude-sonnet',
      'Working',
      'T-031 Teams screen',
    ]);
    expect(r2).toEqual([
      'leadInline member',
      'TeamLeadNo description',
      'codex · model not set',
      'Available',
      'No current work',
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

  it('catalog_lists_agent_definitions_with_usage', async () => {
    const { result } = await renderScreen();
    const items = within(result.getByRole('region', { name: 'Agent catalog' })).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    for (const t of ['OpenCode Sonnet', 'opencode-sonnet', 'opencode · claude-sonnet', 'Implements tickets.', 'Used by 1 member in 1 team']) {
      expect(items[0]!.textContent).toContain(t);
    }
    expect(items[1]!.textContent).toContain('Codex GPT');
    expect(items[1]!.textContent).toContain('Used by 1 member in 1 team');
    for (const t of ['Spare agent', 'claude · model not set', 'No description', 'Not used by any team']) {
      expect(items[2]!.textContent).toContain(t);
    }
  });

  it('empty_workspace_shows_empty_states_and_no_sample_agents', async () => {
    const { result } = await renderScreen({
      overview: [{ ok: true, data: overviewFixture([]) }],
      agents: [{ ok: true, data: catalogFixture({ agents: [] }) }],
    });
    expect(result.getByText('No teams defined in this workspace.')).toBeTruthy();
    expect(result.getByText('No reusable agents defined.')).toBeTruthy();
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
    expect(result.getByText(desc)).toBeTruthy();
  });

  it('loading_states_are_announced', async () => {
    const never = new Promise<never>(() => {});
    const { result } = await renderScreen({ overview: [never], agents: [never] });
    const texts = result.getAllByRole('status').map((s) => s.textContent);
    expect(texts).toContain('Loading teams…');
    expect(texts).toContain('Loading agent catalog…');
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
    const catalog = result.getByRole('region', { name: 'Agent catalog' });
    expect(catalog.textContent).toContain('OpenCode Sonnet');
    expect(within(catalog).getAllByText('Usage unavailable')).toHaveLength(3);
    fireEvent.click(within(list).getByRole('button', { name: 'Retry' }));
    await act(async () => {});
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(fake.agents).toHaveBeenCalledTimes(1);
    expect(card(list, 'Dev Team')).toBeTruthy();
  });

  it('catalog_error_retries_only_catalog', async () => {
    const { fake, result } = await renderScreen({
      agents: [
        { ok: false, error: { code: 'AGENT_CATALOG_INVALID', message: 'agents.json is not valid JSON', retryable: false } },
        { ok: true, data: catalogFixture() },
      ],
    });
    const catalog = result.getByRole('region', { name: 'Agent catalog' });
    expect(within(catalog).getByRole('alert').textContent).toContain('AGENT_CATALOG_INVALID: agents.json is not valid JSON');
    expect(card(result.getByRole('region', { name: 'Workspace teams' }), 'Dev Team')).toBeTruthy();
    fireEvent.click(within(catalog).getByRole('button', { name: 'Retry' }));
    await act(async () => {});
    expect(fake.agents).toHaveBeenCalledTimes(2);
    expect(fake.overview).toHaveBeenCalledTimes(1);
  });

  it('catalog_problems_are_capped', async () => {
    const problems = Array.from({ length: 7 }, (_, i) => ({ path: `agents[${i}].provider`, message: 'must be a non-empty string' }));
    const { result } = await renderScreen({ agents: [{ ok: true, data: catalogFixture({ problems }) }] });
    const box = result.container.querySelector('.teams-catalog-problems')!;
    expect(box.textContent).toContain('agents.json has problems:');
    expect(box.querySelectorAll('li')).toHaveLength(5);
    expect(box.textContent).toContain('…and 2 more problems');
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
    expect(result.getAllByText(evil).length).toBeGreaterThanOrEqual(3);
    expect(result.container.querySelector('img, script')).toBeNull();
  });

  it('controls_are_native_buttons', async () => {
    const { result } = await renderScreen();
    for (const b of result.container.querySelectorAll('button')) {
      expect(b.getAttribute('type')).toBe('button');
      expect(b.hasAttribute('tabindex')).toBe(false);
    }
    expect(result.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    for (const name of ['Workspace teams', 'Dev Team', 'Agent catalog']) {
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
