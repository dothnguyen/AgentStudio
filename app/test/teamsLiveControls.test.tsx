// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus } from '../src/renderer/api';
import { TeamsScreen } from '../src/renderer/teams/TeamsScreen';
import { workspaceA } from './dashboardFixtures';
import {
  RUN_TEAM_ID,
  boardSettingsFixture,
  deferred,
  fakeManagement,
  member,
  overviewFixture,
  runner,
  team,
  teamDefinition,
} from './teamsFixtures';

afterEach(cleanup);

const ok = <T,>(data: T) => ({ ok: true as const, data });
const boardOk = (r = runner()) => ok(boardSettingsFixture(r));
const runningRunner = () =>
  runner({ status: 'running', runStatus: 'running', teamId: 't-1', teamStatus: 'running', teamDefId: 'dev-team' });
const connected: ConnectionStatus = { state: 'connected', error: null, distro: null, command: null };

async function renderScreen(opts: Parameters<typeof fakeManagement>[0] = {}, connection?: ConnectionStatus) {
  const fake = fakeManagement(opts);
  const result = render(<TeamsScreen workspace={workspaceA} management={fake.api} connection={connection} />);
  await act(async () => {});
  return { fake, result };
}
const flush = () => act(async () => {});
const board = () => screen.getByRole('region', { name: 'Board control' });
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const boardButton = (name: string) => within(board()).getByRole('button', { name }) as HTMLButtonElement;
const cells = (row: HTMLElement) => Array.from(row.querySelectorAll('td'));
const runResult = { ok: true as const, data: { board: { workspace: '/work/alpha', status: 'running' as const, teamId: 't-1' }, rules: 3 } };

describe('live team state', () => {
  it('member_availability_and_work_match_runtime_evidence', async () => {
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
        member({ memberId: 'd', name: 'd', presence: 'offline', work: { state: 'unavailable', reason: 'offline' } as never }),
      ],
    })]);
    await renderScreen({ overview: [ok(o)] });
    const rows = within(screen.getByRole('region', { name: 'Dev Team' })).getAllByRole('row').slice(1);
    const status = rows.map((r) => cells(r)[4]!);
    expect(status.map((c) => c.textContent)).toEqual(['Available', 'Working', 'Waiting for input', 'Offline']);
    ['ok', 'busy', 'warning', 'danger'].forEach((tone, i) => {
      expect(status[i]!.querySelector('.status-badge')!.className).toContain(`teams-tone-${tone}`);
    });
    expect(rows.map((r) => cells(r)[5]!.textContent)).toEqual(['No current work', 'T-7 Fix login', 'Answer question', 'Not available']);
  });

  it('stopped_team_members_say_unavailable', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: /^Release Team/ }));
    const row = within(screen.getByRole('region', { name: 'Release Team' })).getAllByRole('row')[1]!;
    expect(cells(row)[4]!.textContent).toBe('Stopped');
    expect(cells(row)[4]!.querySelector('.status-badge')!.className).toContain('teams-tone-muted');
    expect(cells(row)[5]!.textContent).toBe('Not available');
    const badge = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) }).querySelector('.teams-runtime')!;
    expect(badge('Release Team').className).toContain('teams-tone-muted');
    expect(badge('Dev Team').className).toContain('teams-tone-ok');
  });
});

describe('board controls', () => {
  it('run_board_reflects_backend_outcome', async () => {
    const runBoard = vi.fn(async () => runResult);
    const { fake } = await renderScreen({ boardSettings: [boardOk(), boardOk(runningRunner())], calls: { runBoard } });
    expect(board().textContent).toContain('Board: Not running');
    fireEvent.click(boardButton('Run board'));
    await flush();
    expect(runBoard).toHaveBeenCalledTimes(1);
    expect(runBoard).toHaveBeenCalledWith('ws-a', 't-1');
    expect(screen.getByRole('status').textContent).toBe('Board is running with Dev Team.');
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(fake.boardSettings).toHaveBeenCalledTimes(2);
    expect(fake.agents).toHaveBeenCalledTimes(1);
    expect(board().textContent).toContain('Board: Running with this team');
    expect(boardButton('Run board').disabled).toBe(true);
    expect(boardButton('Stop board').disabled).toBe(false);
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
    for (const name of ['Run board', 'Stop board', 'Rename team', 'New team']) expect(button(name).disabled).toBe(true);
    d.resolve(runResult);
    await flush();
    expect(screen.queryByText('Starting board…')).toBeNull();
    expect(runBoard).toHaveBeenCalledTimes(1);
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
    expect(board().textContent).toContain('Board: Stopped');
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
    expect(board().textContent).toContain('Board: Running with another team');
    expect(boardButton('Run board').disabled).toBe(true);
    expect(boardButton('Stop board').disabled).toBe(false);
  });

  it('coordinator_disconnected_disables_controls', async () => {
    await renderScreen({ boardSettings: [boardOk(runner({ status: 'disconnected', coordinatorRunning: false }))] });
    expect(board().textContent).toContain('Board: Disconnected');
    expect(board().textContent).toContain('agent-studio coordinator start');
    expect(boardButton('Run board').disabled).toBe(true);
    expect(boardButton('Stop board').disabled).toBe(true);
  });

  it('board_state_unavailable', async () => {
    await renderScreen({
      boardSettings: [boardOk(runner({ status: 'unavailable', error: { code: 'DB', message: 'database locked' } }))],
    });
    expect(board().textContent).toContain('Board: State unavailable');
    expect(board().textContent).toContain('database locked');
    expect(boardButton('Run board').disabled).toBe(true);
    expect(boardButton('Stop board').disabled).toBe(true);
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
    expect(screen.getByRole('table')).toBeTruthy();
    fireEvent.click(within(board()).getByRole('button', { name: 'Retry' }));
    await flush();
    expect(fake.boardSettings).toHaveBeenCalledTimes(2);
    expect(boardButton('Run board')).toBeTruthy();
    expect(fake.overview).toHaveBeenCalledTimes(1);
  });

  it('stopped_team_cannot_run', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: /^Release Team/ }));
    expect(boardButton('Run board').disabled).toBe(true);
    expect(board().textContent).toContain('Start this team to run the board (team: Stopped).');
  });

  it('connection_loss_disables_and_reconnect_refreshes', async () => {
    const fake = fakeManagement();
    const ui = (c: ConnectionStatus) => <TeamsScreen workspace={workspaceA} management={fake.api} connection={c} />;
    const { rerender } = render(ui(connected));
    await flush();
    rerender(ui({ state: 'lost', error: 'serve exited', distro: null, command: null }));
    await flush();
    expect(screen.getByText('Connection to the backend was lost. Live state may be out of date and board controls are disabled.')).toBeTruthy();
    expect(board().textContent).toContain('Board: Disconnected');
    expect(boardButton('Run board').disabled).toBe(true);
    expect(boardButton('Stop board').disabled).toBe(true);
    for (const f of [fake.overview, fake.agents, fake.boardSettings]) expect(f).toHaveBeenCalledTimes(1);
    rerender(ui(connected));
    await flush();
    expect(screen.queryByText(/Connection to the backend was lost/)).toBeNull();
    for (const f of [fake.overview, fake.agents, fake.boardSettings]) expect(f).toHaveBeenCalledTimes(2);
  });

  it('connecting_shows_banner', async () => {
    await renderScreen({}, { state: 'connecting', error: null, distro: null, command: null });
    expect(screen.getByText(/^Connecting to the backend…/)).toBeTruthy();
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
    expect(screen.getAllByText(/Live agent actions/).length).toBeGreaterThan(0);
    expect(button('Refresh')).toBeTruthy();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/role (grants|owns|sets|chooses|provides|inherits)/i);
    expect(text).not.toMatch(/inherited from (the|a) role/i);
  });
});
