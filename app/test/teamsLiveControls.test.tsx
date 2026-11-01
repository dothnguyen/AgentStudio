// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus } from '../src/renderer/api';
import { TeamsHarness } from './teamsHarness';
import { workspaceA } from './dashboardFixtures';
import {
  memberRow, field, openMember, showMembers,
  RUN_TEAM_ID,
  boardSettingsFixture,
  deferred,
  fakeManagement,
  member,
  overviewFixture,
  runner,
  team,
  teamDefinition,
  twoTeams,
} from './teamsFixtures';

afterEach(cleanup);

const ok = <T,>(data: T) => ({ ok: true as const, data });
const boardOk = (r = runner()) => ok(boardSettingsFixture(r));
const runningRunner = () =>
  runner({ status: 'running', runStatus: 'running', teamId: 't-1', teamStatus: 'running', teamDefId: 'dev-team' });
const connected: ConnectionStatus = { state: 'connected', error: null, distro: null, command: null };

async function renderScreen(opts: Parameters<typeof fakeManagement>[0] = {}, connection?: ConnectionStatus) {
  const fake = fakeManagement(opts);
  const result = render(<TeamsHarness sidebar workspace={workspaceA} management={fake.api} connection={connection} />);
  await act(async () => {});
  return { fake, result };
}
const flush = () => act(async () => {});
const board = () => screen.getByRole('region', { name: 'Board' });
const overviewPanel = () => screen.getByRole('tabpanel', { name: 'Overview' });
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const boardValue = () => board().querySelector('.teams-summary-value')!.textContent;
const boardButton = (name: string) => within(board()).getByRole('button', { name }) as HTMLButtonElement;
function expectBoardButton(run: boolean, stop: boolean, why?: string) {
  const buttons = within(board()).queryAllByRole('button', { name: /^(Run|Stop) board$/ });
  const want = stop ? ['Stop board'] : run ? ['Run board'] : [];
  expect(buttons.map((b) => b.textContent), why).toEqual(want);
}
const runResult = { ok: true as const, data: { board: { workspace: '/work/alpha', status: 'running' as const, teamId: 't-1' }, rules: 3 } };

describe('live team state', () => {
  it('member_availability_and_work_fixture_matrix', async () => {
    const o = overviewFixture([team({
      runtime: { state: 'running', teamId: RUN_TEAM_ID, status: 'running' },
      members: [
        member({ memberId: 'a', name: 'a', presence: 'idle', work: { state: 'none' } }),
        member({
          memberId: 'b', name: 'b', presence: 'busy',
          work: { state: 'working', assignment: null, ticket: { key: 'T-7', title: 'Fix login', status: 'dev', workflowRunId: null } },
        }),
        member({
          memberId: 'c', name: 'c', presence: 'waiting_input',
          work: { state: 'working', ticket: null, assignment: { goal: 'Answer question' } } as never,
        }),
        member({ memberId: 'd', name: 'd', presence: 'limit_reached', work: { state: 'none' } }),
        member({ memberId: 'e', name: 'e', presence: 'offline', work: { state: 'unavailable', reason: 'offline' } }),
        member({ memberId: 'f', name: 'f', presence: 'not_in_runtime', work: { state: 'unavailable', reason: 'not_in_runtime' } }),
        member({ memberId: 'g', name: 'g', presence: 'unavailable', work: { state: 'unavailable', reason: 'unavailable' } }),
      ],
    })]);
    await renderScreen({ overview: [ok(o)] });
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(name => memberRow(name));
    expect(rows.map(r => field(r, 'availability'))).toEqual(['Available', 'Working', 'Waiting for input', 'Limit reached', 'Offline', 'Not in runtime', 'Unavailable']);
    ['ok', 'busy', 'warning', 'warning', 'danger', 'muted', 'muted'].forEach((tone, i) => expect(rows[i]!.querySelector('.teams-member-status')!.className).toContain(`teams-tone-${tone}`));
    expect(rows.map(r => field(r, 'work'))).toEqual(['Idle', 'T-7 Fix login', 'Answer question', 'Idle', 'Not available — offline', 'Not available — member is not in the running team', 'Not available — live state unavailable']);
  });

  it('stopped_team_members_say_unavailable', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: /^Open Release Team,/ }));
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    const row = memberRow('qa');
    expect(field(row, 'availability')).toBe('Stopped');
    expect(row.querySelector('.teams-member-status')!.className).toContain('teams-tone-muted');
    expect(field(row, 'work')).toBe('Not available — team stopped');
    expect(row.querySelector('[data-part="agent-name"]')!.textContent).toBe('Not running · saved default: OpenCode Sonnet');
    const badge = (name: string) => screen.getByRole('button', { name: new RegExp(`^Open ${name},`) }).querySelector('.team-nav-state')!;
    expect(badge('Release Team').textContent).toBe('Stopped');
    expect(badge('Dev Team').textContent).toBe('Running');
  });
});

describe('board controls', () => {
  it('run_board_reflects_backend_outcome', async () => {
    const runBoard = vi.fn(async () => runResult);
    const { fake } = await renderScreen({ boardSettings: [boardOk(), boardOk(runningRunner())], calls: { runBoard } });
    expect(overviewPanel().contains(board())).toBe(true);
    expect(boardValue()).toBe('Not running');
    fireEvent.click(boardButton('Run board'));
    await flush();
    expect(runBoard).toHaveBeenCalledTimes(1);
    expect(runBoard).toHaveBeenCalledWith('ws-a', 't-1');
    expect(screen.getByRole('status').textContent).toBe('Board is running with Dev Team.');
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(fake.boardSettings).toHaveBeenCalledTimes(2);
    expect(fake.agents).toHaveBeenCalledTimes(1);
    expect(boardValue()).toBe('Running');
    expectBoardButton(false, true);
  });

  it('overview_board_relationship_matrix', async () => {
    const cases = [
      { runner: runner({ status: 'running', teamId: 't-1' }), status: 'Running', run: false, stop: true },
      { runner: runner({ status: 'running', teamId: 'other', teamDefId: 'release' }), status: 'Running', run: false, stop: true, detail: 'Team release runs this board.' },
      { runner: runner({ status: 'stopped', teamId: 't-1' }), status: 'Stopped', run: true, stop: false, detail: 'This team ran the board last.' },
      { runner: runner(), status: 'Not running', run: true, stop: false },
      { runner: runner({ status: 'disconnected' }), status: 'Disconnected', run: false, stop: false },
      { runner: runner({ status: 'unavailable' }), status: 'State unavailable', run: false, stop: false },
      { runner: runner(), status: 'Disconnected', run: false, stop: false, lost: true },
    ];
    for (const c of cases) {
      const { result } = await renderScreen({ boardSettings: [boardOk(c.runner)] }, c.lost ? { state: 'lost', error: 'offline', distro: null, command: null } : connected);
      expect(overviewPanel().contains(board())).toBe(true);
      expect(boardValue()).toBe(c.status);
      if (c.detail) expect(board().textContent).toContain(c.detail);
      expectBoardButton(c.run, c.stop);
      result.unmount();
    }
  });

  it('compact_board_summary_preserves_runner_state_matrix', async () => {
    const lost: ConnectionStatus = { state: 'lost', error: 'offline', distro: null, command: null };
    const cases = [
      { name: 'running here', runner: runner({ status: 'running', teamId: 't-1' }), status: 'Running', detail: 'With this team', run: false, stop: true },
      { name: 'running other', runner: runner({ status: 'running', teamId: 'other', teamDefId: 'release' }), status: 'Running', detail: 'Team release runs this board. Stop it before running the board with this team.', run: false, stop: true },
      { name: 'stopped', runner: runner({ status: 'stopped', teamId: 't-1' }), status: 'Stopped', detail: 'This team ran the board last. Running work finishes; no new tickets are claimed.', run: true, stop: false },
      { name: 'not_bound', runner: runner({ status: 'not_bound' }), status: 'Not running', detail: 'No team runs this board.', run: true, stop: false },
      { name: 'team_not_running', runner: runner({ status: 'team_not_running', teamId: 'old', teamStatus: 'stopped' }), status: 'Team not running', detail: 'The bound team is stopped; no new tickets are claimed.', run: true, stop: true },
      { name: 'disconnected', runner: runner({ status: 'disconnected' }), status: 'Disconnected', detail: 'The coordinator is not running; the board cannot claim work or be controlled. Run: agent-studio coordinator start', run: false, stop: false },
      { name: 'unavailable', runner: runner({ status: 'unavailable' }), status: 'State unavailable', detail: 'Runtime state could not be read.', run: false, stop: false },
      { name: 'lost connection', runner: runner({ status: 'running', teamId: 't-1' }), status: 'Disconnected', detail: 'The backend connection is not available; board state cannot be read or changed.', run: false, stop: false, lost: true },
    ];
    for (const c of cases) {
      const { result } = await renderScreen({ boardSettings: [boardOk(c.runner)] }, c.lost ? lost : connected);
      const text = board().textContent ?? '';
      expect(boardValue(), c.name).toBe(c.status);
      if (c.detail !== null) expect(text, c.name).toContain(c.detail);
      expectBoardButton(c.run, c.stop, c.name);
      result.unmount();
    }
  });

  it('compact_board_actions_keep_pending_lock_and_refresh_feedback', async () => {
    const d = deferred<typeof runResult>();
    const runBoard = vi.fn(() => d.promise);
    const { fake } = await renderScreen({ boardSettings: [boardOk(), boardOk(runningRunner())], calls: { runBoard } });
    const run = boardButton('Run board');
    fireEvent.click(run);
    fireEvent.click(run);
    await flush();
    expect(runBoard).toHaveBeenCalledTimes(1);
    expect(runBoard).toHaveBeenCalledWith('ws-a', 't-1');
    expect(screen.getByRole('status').textContent).toBe('Starting board…');
    for (const name of ['Run board', 'Rename team']) expect(button(name).disabled).toBe(true);
    expect(fake.overview).toHaveBeenCalledTimes(1);
    expect(fake.boardSettings).toHaveBeenCalledTimes(1);
    d.resolve(runResult);
    await flush();
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(fake.boardSettings).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status').textContent).toBe('Board is running with Dev Team.');
    cleanup();

    const s = deferred<ReturnType<typeof ok>>();
    const stopBoard = vi.fn(() => s.promise);
    const stopped = await renderScreen({ boardSettings: [boardOk(runningRunner()), boardOk(runner({ status: 'stopped', teamId: 't-1' }))], calls: { stopBoard } });
    fireEvent.click(boardButton('Stop board'));
    fireEvent.click(boardButton('Stop board'));
    await flush();
    expect(stopBoard).toHaveBeenCalledTimes(1);
    expect(stopBoard).toHaveBeenCalledWith('ws-a');
    expect(stopped.fake.overview).toHaveBeenCalledTimes(1);
    expect(stopped.fake.boardSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('Stopping board…');
    for (const name of ['Stop board', 'Rename team']) expect(button(name).disabled).toBe(true);
    s.resolve(ok({ board: { workspace: '/work/alpha', status: 'stopped' as const, teamId: 't-1' } }));
    await flush();
    expect(screen.getByRole('status').textContent).toContain('Board stopped.');
    expect(stopped.fake.overview).toHaveBeenCalledTimes(2);
    expect(stopped.fake.boardSettings).toHaveBeenCalledTimes(2);
    cleanup();

    const runErr = vi.fn(async () => ({ ok: false as const, error: { code: 'TEAM_NOT_RUNNING', message: 'Team is not running.', retryable: false } }));
    await renderScreen({ calls: { runBoard: runErr } });
    fireEvent.click(boardButton('Run board'));
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('TEAM_NOT_RUNNING: Team is not running.');
    expect(screen.getByRole('alert').textContent).toContain('The team or the board is not running.');
  });

  it('rapid_repeated_clicks_submit_once', async () => {
    const d = deferred<typeof runResult>();
    const runBoard = vi.fn(() => d.promise);
    await renderScreen({ calls: { runBoard } });
    const run = boardButton('Run board');
    fireEvent.click(run);
    fireEvent.click(run);
    await flush();
    expect(runBoard).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('Starting board…');
    for (const name of ['Run board', 'Rename team', 'New team']) expect(button(name).disabled).toBe(true);
    d.resolve(runResult);
    await flush();
    expect(screen.queryByText('Starting board…')).toBeNull();
    expect(runBoard).toHaveBeenCalledTimes(1);
  });

  it('pending_board_action_and_refresh_share_one_status_region', async () => {
    const action = deferred<typeof runResult>();
    const boardRefresh = deferred<ReturnType<typeof boardOk>>();
    const runBoard = vi.fn(() => action.promise);
    await renderScreen({ boardSettings: [boardOk(), boardRefresh.promise], calls: { runBoard } });
    fireEvent.click(boardButton('Run board'));
    fireEvent.click(button('Refresh'));
    await flush();
    expect(screen.getByText('Starting board…')).toBeTruthy();
    expect(screen.getByText('Refreshing board state… Showing previously loaded data.')).toBeTruthy();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(runBoard).toHaveBeenCalledWith('ws-a', 't-1');
    await act(async () => { boardRefresh.resolve(boardOk()); action.resolve(runResult); });
  });

  it('pending_stop_and_board_refresh_share_one_status_region', async () => {
    const stopped = ok({ board: { workspace: '/work/alpha', status: 'stopped' as const, teamId: 't-1' } });
    const action = deferred<typeof stopped>();
    const boardRefresh = deferred<ReturnType<typeof boardOk>>();
    const stopBoard = vi.fn(() => action.promise);
    await renderScreen({ boardSettings: [boardOk(runningRunner()), boardRefresh.promise], calls: { stopBoard } });
    fireEvent.click(boardButton('Stop board'));
    fireEvent.click(button('Refresh'));
    await flush();
    expect(screen.getByText('Stopping board…')).toBeTruthy();
    expect(screen.getByText('Refreshing board state… Showing previously loaded data.')).toBeTruthy();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(stopBoard).toHaveBeenCalledTimes(1);
    expect(stopBoard).toHaveBeenCalledWith('ws-a');
    await act(async () => { boardRefresh.resolve(boardOk(runningRunner())); action.resolve(stopped); });
  });

  it('stop_board_reflects_backend_outcome', async () => {
    const stopBoard = vi.fn(async () => ok({ board: { workspace: '/work/alpha', status: 'stopped' as const, teamId: 't-1' } }));
    const { fake } = await renderScreen({
      boardSettings: [boardOk(runningRunner()), boardOk(runner({ status: 'stopped', teamId: 't-1' }))],
      calls: { stopBoard },
    });
    fireEvent.click(boardButton('Stop board'));
    await flush();
    expect(stopBoard).toHaveBeenCalledTimes(1);
    expect(stopBoard).toHaveBeenCalledWith('ws-a');
    expect(screen.getByRole('status').textContent).toBe('Board stopped. Running work finishes; no new tickets are claimed.');
    expect(fake.boardSettings).toHaveBeenCalledTimes(2);
    expect(boardValue()).toBe('Stopped');
  });

  it('run_error_shows_backend_error_and_refreshes', async () => {
    const runBoard = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'BOARD_ALREADY_RUNNING', message: 'Team x already runs this board.', retryable: false, data: { teamId: 'x' } },
    }));
    const { fake } = await renderScreen({ calls: { runBoard } });
    fireEvent.click(boardButton('Run board'));
    await flush();
    const alert = screen.getByRole('alert').textContent!;
    expect(alert).toContain('Board did not start.');
    expect(alert).toContain('BOARD_ALREADY_RUNNING: Team x already runs this board.');
    expect(alert).toContain('Another team already runs this board.');
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(fake.boardSettings).toHaveBeenCalledTimes(2);
    expect(fake.overview).toHaveBeenCalledTimes(2);
  });

  it('pending_outcome_is_not_reported_as_success', async () => {
    const stopBoard = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'PENDING', message: 'The command was recorded but the coordinator has not answered yet.',
        retryable: true, data: { idempotencyKey: 'k-00000001' },
      },
    }));
    const { fake } = await renderScreen({ boardSettings: [boardOk(runningRunner())], calls: { stopBoard } });
    fireEvent.click(boardButton('Stop board'));
    await flush();
    const alert = screen.getByRole('alert').textContent!;
    expect(alert).toContain('Board did not stop.');
    expect(alert).toContain('recorded but not confirmed yet');
    expect(screen.queryByRole('status')).toBeNull();
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(fake.boardSettings).toHaveBeenCalledTimes(2);
  });

  it('pending_run_is_not_success_and_refreshes_both_sections', async () => {
    const runBoard = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'PENDING', message: 'Awaiting confirmation.', retryable: true },
    }));
    const { fake } = await renderScreen({ calls: { runBoard } });
    fireEvent.click(boardButton('Run board'));
    await flush();
    expect(runBoard).toHaveBeenCalledTimes(1);
    expect(runBoard).toHaveBeenCalledWith('ws-a', 't-1');
    expect(screen.getByRole('alert').textContent).toContain('Board did not start.');
    expect(screen.getByRole('alert').textContent).toContain('recorded but not confirmed yet');
    expect(screen.queryByRole('status')).toBeNull();
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(fake.boardSettings).toHaveBeenCalledTimes(2);
  });

  it('thrown_ipc_error_is_shown', async () => {
    const runBoard = vi.fn(async () => { throw new Error('ipc down'); });
    await renderScreen({ calls: { runBoard } });
    fireEvent.click(boardButton('Run board'));
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('INTERNAL: ipc down');
  });

  it('board_running_with_another_team', async () => {
    await renderScreen({ boardSettings: [boardOk(runner({ status: 'running', teamId: 'other', teamDefId: 'release' }))] });
    expect(boardValue()).toBe('Running');
    expectBoardButton(false, true);
  });

  it('coordinator_disconnected_disables_controls', async () => {
    await renderScreen({ boardSettings: [boardOk(runner({ status: 'disconnected', coordinatorRunning: false }))] });
    expect(boardValue()).toBe('Disconnected');
    expect(board().textContent).toContain('agent-studio coordinator start');
    expectBoardButton(false, false);
  });

  it('board_state_unavailable', async () => {
    await renderScreen({
      boardSettings: [boardOk(runner({ status: 'unavailable', error: { code: 'DB', message: 'database locked' } }))],
    });
    expect(boardValue()).toBe('State unavailable');
    expect(board().textContent).toContain('database locked');
    expectBoardButton(false, false);
  });

  it('board_settings_error_has_retry', async () => {
    const { fake } = await renderScreen({
      boardSettings: [
        { ok: false, error: { code: 'BOARD_CONFIG_INVALID', message: 'board.json is invalid', retryable: false } },
        boardOk(),
      ],
    });
    expect(within(board()).getByRole('alert').textContent).toContain('BOARD_CONFIG_INVALID: board.json is invalid');
    expect(within(board()).queryByRole('button', { name: 'Run board' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    await flush();
    expect(showMembers()).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    await flush();
    fireEvent.click(within(board()).getByRole('button', { name: 'Retry' }));
    await flush();
    expect(fake.boardSettings).toHaveBeenCalledTimes(2);
    expect(boardButton('Run board')).toBeTruthy();
    expect(fake.overview).toHaveBeenCalledTimes(1);
  });

  it('board_button_keeps_focus_when_stop_flips_to_run', async () => {
    const stopBoard = vi.fn(async () => ok({ board: { workspace: '/work/alpha', status: 'stopped' as const, teamId: 't-1' } }));
    await renderScreen({ boardSettings: [boardOk(runningRunner()), boardOk(runner({ status: 'stopped', teamId: 't-1' }))], calls: { stopBoard } });
    const stop = boardButton('Stop board');
    stop.focus();
    fireEvent.click(stop);
    await flush();
    expect(stopBoard).toHaveBeenCalledTimes(1);
    const run = boardButton('Run board');
    expect(document.activeElement).toBe(run);
  });

  it('board_button_removal_moves_focus_to_board_heading', async () => {
    const stopBoard = vi.fn(async () => ok({ board: { workspace: '/work/alpha', status: 'stopped' as const, teamId: 'old' } }));
    const stoppedTeam = team({ runtime: { state: 'stopped', teamId: null, status: 'stopped' } });
    const bound = runner({ status: 'team_not_running', teamId: 'old', teamStatus: 'stopped' });
    await renderScreen({ overview: [ok(overviewFixture([stoppedTeam]))], boardSettings: [boardOk(bound), boardOk(runner({ status: 'stopped', teamId: 'old' }))], calls: { stopBoard } });
    const stop = boardButton('Stop board');
    stop.focus();
    fireEvent.click(stop);
    await flush();
    expect(within(board()).queryAllByRole('button', { name: /^(Run|Stop) board$/ })).toHaveLength(0);
    expect(document.activeElement).toBe(document.getElementById('teams-board-title'));
  });

  it('stopped_team_cannot_run', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: /^Open Release Team,/ }));
    expectBoardButton(false, false);
    expect(board().textContent).toContain('Start this team to run the board (team: Stopped).');
  });

  it('connection_loss_disables_and_reconnect_refreshes', async () => {
    const fake = fakeManagement();
    const ui = (c: ConnectionStatus) => <TeamsHarness workspace={workspaceA} management={fake.api} connection={c} />;
    const { rerender } = render(ui(connected));
    await flush();
    rerender(ui({ state: 'lost', error: 'serve exited', distro: null, command: null }));
    await flush();
    expect(screen.getByText('Connection lost. Showing previously loaded data.')).toBeTruthy();
    expect(boardValue()).toBe('Disconnected');
    expectBoardButton(false, false);
    for (const f of [fake.overview, fake.agents, fake.boardSettings]) expect(f).toHaveBeenCalledTimes(1);
    rerender(ui(connected));
    await flush();
    expect(screen.queryByText(/Connection lost\./)).toBeNull();
    for (const f of [fake.overview, fake.agents, fake.boardSettings]) expect(f).toHaveBeenCalledTimes(2);
  });

  it('connecting_shows_banner', async () => {
    await renderScreen({}, { state: 'connecting', error: null, distro: null, command: null });
    expect(screen.getByText('Connecting to Agent Studio…')).toBeTruthy();
  });

  it('unmount_during_action_ignores_result', async () => {
    const d = deferred<typeof runResult>();
    const runBoard = vi.fn(() => d.promise);
    const { fake, result } = await renderScreen({ calls: { runBoard } });
    fireEvent.click(boardButton('Run board'));
    await flush();
    result.unmount();
    d.resolve(runResult);
    await flush();
    expect(runBoard).toHaveBeenCalledTimes(1);
    expect(fake.overview).toHaveBeenCalledTimes(1);
    expect(fake.boardSettings).toHaveBeenCalledTimes(1);
  });

  it('refresh_reloads_board_state', async () => {
    const { fake } = await renderScreen();
    fireEvent.click(button('Refresh'));
    await flush();
    expect(fake.boardSettings).toHaveBeenCalledTimes(2);
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(fake.agents).toHaveBeenCalledTimes(2);
  });

  it('team_edits_do_not_reload_board', async () => {
    const renameTeam = vi.fn(async () => ok({ team: teamDefinition({ name: 'Core Team' }), problems: [] }));
    const { fake } = await renderScreen({ calls: { renameTeam } });
    fireEvent.click(button('Rename team'));
    fireEvent.change(screen.getByLabelText('Team name'), { target: { value: 'Core Team' } });
    fireEvent.click(button('Save name'));
    await flush();
    expect(renameTeam).toHaveBeenCalledTimes(1);
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(fake.boardSettings).toHaveBeenCalledTimes(1);
  });

  it('role_integration_preserves_live_and_agents_controls', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    openMember('dev');
    expect(screen.getByRole('region', {name: 'Agents'})).toBeTruthy();
    expect(button('Refresh')).toBeTruthy();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/role (grants|owns|sets|chooses|provides|inherits)/i);
    expect(text).not.toMatch(/inherited from (the|a) role/i);
  });
});

describe('roster runtime evidence', () => {
  it('stale_and_pending_live_agent_evidence_is_labelled', async () => {
    const live = member().runtime ?? { ...((await import('./teamsFixtures')).twoTeams().teams[1]!.members[0]!.runtime!) };
    await renderScreen({overview: [ok(overviewFixture([team({members: [member({runtime: {...live, stale: true, activeAgent: 'codex-gpt', pendingAgent: 'codex-gpt'}}), member({memberId: 'next', name: 'next', presence: 'not_started', work: {state: 'unavailable', reason: 'not_started'}})]})]))]});
    expect(field(memberRow('dev'), 'agent')).toContain('Last live agent: Codex GPT (team not running)');
    expect(field(memberRow('dev'), 'agent')).toContain('Switch to codex-gpt pending');
    expect(field(memberRow('next'), 'availability')).toBe('Not started'); expect(field(memberRow('next'), 'work')).toBe('Not available — team not started');
  });
});

