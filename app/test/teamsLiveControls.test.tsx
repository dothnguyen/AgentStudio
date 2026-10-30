// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus } from '../src/renderer/api';
import { TeamsScreen } from '../src/renderer/teams/TeamsScreen';
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
  twoTeams, catalogFixture, connectionFixture, managementError, switchEvidence,
} from './teamsFixtures';
import { SWITCH_REFRESH_INTERVAL_MS, SWITCH_REFRESH_LIMIT } from '../src/renderer/teams/memberAgentActionsModel';
import userEvent from '@testing-library/user-event';

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
const overviewPanel = () => screen.getByRole('tabpanel', { name: 'Overview' });
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const boardButton = (name: string) => within(board()).getByRole('button', { name }) as HTMLButtonElement;
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
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(name => memberRow(name));
    expect(rows.map(r => field(r, 'availability'))).toEqual(['Available', 'Working', 'Waiting for input', 'Limit reached', 'Offline', 'Not in runtime', 'Unavailable']);
    ['ok', 'busy', 'warning', 'warning', 'danger', 'muted', 'muted'].forEach((tone, i) => expect(rows[i]!.querySelector('.status-badge')!.className).toContain(`teams-tone-${tone}`));
    expect(rows.map(r => field(r, 'work'))).toEqual(['No current work', 'T-7 Fix login', 'Answer question', 'No current work', 'Not available — offline', 'Not available — member is not in the running team', 'Not available — live state unavailable']);
  });

  it('stopped_team_members_say_unavailable', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: /^Release Team/ }));
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    const row = memberRow('qa');
    expect(field(row, 'availability')).toBe('Stopped');
    expect(row.querySelector('.status-badge')!.className).toContain('teams-tone-muted');
    expect(field(row, 'work')).toBe('Not available — team stopped');
    expect(field(row, 'agent')).toBe('Not running · saved default: OpenCode Sonnet');
    const badge = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) }).querySelector('.teams-runtime')!;
    expect(badge('Release Team').className).toContain('teams-tone-muted');
    expect(badge('Dev Team').className).toContain('teams-tone-ok');
  });
});

describe('board controls', () => {
  it('run_board_reflects_backend_outcome', async () => {
    const runBoard = vi.fn(async () => runResult);
    const { fake } = await renderScreen({ boardSettings: [boardOk(), boardOk(runningRunner())], calls: { runBoard } });
    expect(overviewPanel().contains(board())).toBe(true);
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

  it('overview_board_relationship_matrix', async () => {
    const cases = [
      { runner: runner({ status: 'running', teamId: 't-1' }), status: 'Board: Running with this team', run: false, stop: true },
      { runner: runner({ status: 'running', teamId: 'other', teamDefId: 'release' }), status: 'Board: Running with another team', run: false, stop: true, detail: 'Team release runs this board.' },
      { runner: runner({ status: 'stopped', teamId: 't-1' }), status: 'Board: Stopped', run: true, stop: false, detail: 'This team ran the board last.' },
      { runner: runner(), status: 'Board: Not running', run: true, stop: false },
      { runner: runner({ status: 'disconnected' }), status: 'Board: Disconnected', run: false, stop: false },
      { runner: runner({ status: 'unavailable' }), status: 'Board: State unavailable', run: false, stop: false },
      { runner: runner(), status: 'Board: Disconnected', run: false, stop: false, lost: true },
    ];
    for (const c of cases) {
      const { result } = await renderScreen({ boardSettings: [boardOk(c.runner)] }, c.lost ? { state: 'lost', error: 'offline', distro: null, command: null } : connected);
      expect(overviewPanel().contains(board())).toBe(true);
      expect(board().textContent).toContain(c.status);
      if (c.detail) expect(board().textContent).toContain(c.detail);
      expect(boardButton('Run board').disabled).toBe(!c.run);
      expect(boardButton('Stop board').disabled).toBe(!c.stop);
      result.unmount();
    }
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
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
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
    expect(screen.getByText('Connection lost. Showing previously loaded data.')).toBeTruthy();
    expect(board().textContent).toContain('Board: Disconnected');
    expect(boardButton('Run board').disabled).toBe(true);
    expect(boardButton('Stop board').disabled).toBe(true);
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
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    openMember('dev');
    expect(screen.getByRole('region', {name: 'Live agent actions for dev'})).toBeTruthy();
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
    expect(field(memberRow('dev'), 'agent')).toContain('Last live agent: codex-gpt (team not running)');
    expect(field(memberRow('dev'), 'agent')).toContain('Switch to codex-gpt pending');
    expect(field(memberRow('next'), 'availability')).toBe('Not started'); expect(field(memberRow('next'), 'work')).toBe('Not available — team not started');
  });
});

async function openTab(r: {getByRole: (role: string, options: {name: string}) => HTMLElement}, name: string) {
  fireEvent.click(r.getByRole('tab', {name}));
  await act(async () => {});
}
async function renderMembers(opts: Parameters<typeof fakeManagement>[0] = {}) {
  const out = await renderScreen(opts);
  fireEvent.click(out.result.getByRole('tab', {name: 'Members'}));
  await act(async () => {});
  return out;
}
const card = (root: HTMLElement, name: string) => within(root).getByRole('button', {name: new RegExp(`^${name}`)});

describe('live member actions', () => {
  const renderLive = async (opts: Parameters<typeof fakeManagement>[0] = {}) => { const out = await renderMembers(opts); openMember('dev'); return out; };
  const live = { ...twoTeams().teams[1]!.members[0]!.runtime!, configuredAgents: ['opencode-sonnet', 'codex-gpt'], activeAgent: 'opencode-sonnet', paneState: 'alive', availability: 'idle' };
  const data = (runtime = live) => overviewFixture([team({ runtime: { state: 'running', teamId: 't', status: 'running' }, members: [member({runtime})] })]);
  const confirmation = (id: string) => ({ok: false as const, error: {code: 'BAD_REQUEST', message: 'Member has an active assignment; confirm cancellation of this assignment to switch.', retryable: false, data: {assignmentId: id}}});
  it('selection_change_dismisses_confirmation_and_focuses_new_detail', async () => {
    const call = vi.fn().mockResolvedValue(confirmation('assignment-A'));
    const overview = overviewFixture([team({runtime: {state: 'running', teamId: 't', status: 'running'}, members: [member({runtime: live}), member({memberId: 'other', name: 'other', runtime: live})]})]);
    const {result} = await renderLive({overview: [ok(overview)], calls: {switchMemberAgent: call}});
    fireEvent.click(result.getByRole('button', {name: 'Switch'})); await flush();
    fireEvent.click(result.getByRole('button', {name: 'Back to members'}));
    openMember('other'); await flush();
    expect(result.queryByRole('dialog')).toBeNull();
    expect(call).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(result.getByRole('heading', {name: 'other'}));
  });
  it('dialog_restores_detail_heading_if_trigger_is_disabled', async () => {
    const call = vi.fn().mockResolvedValue(confirmation('assignment-A'));
    const {result} = await renderLive({overview: [ok(data())], calls: {switchMemberAgent: call}});
    const trigger = result.getByRole('button', {name: 'Switch'}) as HTMLButtonElement;
    fireEvent.click(trigger); await flush();
    trigger.disabled = true;
    fireEvent.click(within(result.getByRole('dialog')).getByRole('button', {name: 'Cancel'}));
    expect(call).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(result.getByRole('heading', {name: 'dev'}));
  });
  it('dead_pane_and_all_switch_evidence_are_visible_without_options', async () => {
    const lastSwitch = {state: 'pending' as const, requestedAgent: 'codex-gpt', assignmentId: null, code: 'CODE', message: 'detail', at: 'now'};
    const {result} = await renderLive({overview: [ok(data({...live, configuredAgents: [], quotaHolds: {}, paneState: 'dead', lastSwitch}))]});
    expect(result.getByText("The member's pane is not alive.")).toBeTruthy();
    expect(result.getByText(/pending — CODE: detail/)).toBeTruthy();
  });
  it('exact_assignment_confirmation_and_decline', async () => {
    const call = vi.fn().mockResolvedValue(confirmation('assignment-A'));
    const {result} = await renderLive({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
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
    const {result} = await renderLive({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    fireEvent.click(result.getByRole('button', {name: 'Switch'})); await act(async () => {});
    fireEvent.click(result.getByRole('button', {name: 'Confirm cancellation'})); await act(async () => {});
    expect(call).toHaveBeenCalledTimes(2); expect(result.getByRole('dialog').textContent).toContain('B'); expect(result.getByRole('dialog').textContent).toContain('fresh confirmation');
    fireEvent.click(result.getByRole('button', {name: 'Confirm cancellation'})); await act(async () => {});
    expect(call).toHaveBeenLastCalledWith('ws-a', 'dev-team', 'dev', 'codex-gpt', {cancelActive: true, assignmentId: 'B'});
  });
  it('changed_assignment_and_catalog_error_share_one_alert', async () => {
    const call = vi.fn().mockResolvedValueOnce(confirmation('A')).mockResolvedValueOnce(confirmation('B'));
    const {result} = await renderLive({overview: [ok(data())], roles: [managementError('ROLES_DOWN', 'Roles unavailable', 'Retry roles')], calls: {switchMemberAgent: call}});
    fireEvent.click(result.getByRole('button', {name: 'Switch'})); await flush();
    fireEvent.click(result.getByRole('button', {name: 'Confirm cancellation'})); await flush();
    expect(result.getByText(/ROLES_DOWN/)).toBeTruthy();
    expect(result.getByText(/fresh confirmation is required/)).toBeTruthy();
    expect(result.getAllByRole('alert')).toHaveLength(1);
  });
  it('dismissed_confirmation_stays_closed_when_changed_assignment_arrives', async () => {
    for (const dismissal of ['cancel', 'escape'] as const) {
      const response = deferred<ReturnType<typeof confirmation>>();
      const call = vi.fn().mockResolvedValueOnce(confirmation('A')).mockImplementationOnce(() => response.promise);
      const {result} = await renderLive({overview: [ok(data())], calls: {switchMemberAgent: call}});
      fireEvent.click(result.getByRole('button', {name: 'Switch'})); await flush();
      const dialog = result.getByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', {name: 'Confirm cancellation'})); await flush();
      const cancel = within(dialog).getByRole('button', {name: 'Cancel'});
      expect(document.activeElement).toBe(cancel);
      fireEvent.keyDown(cancel, {key: 'Tab', shiftKey: true});
      expect(document.activeElement).toBe(cancel);
      if (dismissal === 'cancel') fireEvent.click(cancel);
      else fireEvent.keyDown(cancel, {key: 'Escape'});
      await act(async () => { response.resolve(confirmation('B')); });
      expect(result.queryByRole('dialog')).toBeNull();
      expect(call).toHaveBeenCalledTimes(2);
      result.unmount();
    }
  });
  it('all_held_and_unknown_reset_display', async () => {
    const {result} = await renderLive({overview: [{ok: true, data: data({...live, quotaHolds: {'codex-gpt': null, missing: 'bad'}})}]});
    expect(result.getAllByText(/Reset time unknown/)).toHaveLength(2);
    expect(result.getAllByRole('button', {name: 'Resume'})).toHaveLength(2);
    expect(result.getByText('All alternate agents are on quota hold.')).toBeTruthy();
  });
  it('duplicate_switch_blocked', async () => {
    const call = vi.fn(() => new Promise(() => {}));
    const {result} = await renderLive({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    const trigger = result.getByRole('button', {name: 'Switch'});
    fireEvent.click(trigger); fireEvent.click(trigger);
    expect(call).toHaveBeenCalledTimes(1); expect(result.getAllByText('Requesting…').length).toBeGreaterThan(0);
    expect(call).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'codex-gpt');
  });
  it('inactive_resume_does_not_switch_or_interrupt', async () => {
    const held = {...live, quotaHolds: {'codex-gpt': null}, assignment: {id: 'job', status: 'working', taskId: 'task'}};
    const resume = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', option: 'codex-gpt', cleared: true, activeAgent: 'opencode-sonnet'}});
    const switchCall = vi.fn();
    const {result} = await renderLive({overview: [{ok: true, data: data(held)}, {ok: true, data: data({...held, quotaHolds: {}})}], calls: {resumeMemberAgent: resume, switchMemberAgent: switchCall}});
    fireEvent.click(result.getByRole('button', {name: 'Resume'})); await act(async () => {});
    expect(result.getByText('Quota hold cleared for inactive option Codex GPT; quota was not verified. The live agent and assignment were not changed.')).toBeTruthy();
    expect(result.container.textContent).toContain('job · working · task'); expect(switchCall).not.toHaveBeenCalled();
  });
  it('keyboard_accessible_dialog_focus_return', async () => {
    const call = vi.fn().mockResolvedValue(confirmation('A'));
    const {result} = await renderLive({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    const trigger = result.getByRole('button', {name: 'Switch'}); trigger.focus(); fireEvent.click(trigger); await act(async () => {});
    const dialog = result.getByRole('dialog'); const confirm = within(dialog).getByRole('button', {name: 'Confirm cancellation'}); const cancel = within(dialog).getByRole('button', {name: 'Cancel'});
    expect(dialog.getAttribute('aria-modal')).toBe('true'); expect(dialog.getAttribute('aria-labelledby')).toBeTruthy(); expect(dialog.getAttribute('aria-describedby')).toBeTruthy(); expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, {key: 'Tab'}); expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(confirm, {key: 'Tab', shiftKey: true}); expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, {key: 'Escape'}); expect(document.activeElement).toBe(trigger); expect(call).toHaveBeenCalledTimes(1);
  });

  it('connection_loss_disables_open_confirmation_without_sending_cancellation', async () => {
    const call = vi.fn().mockResolvedValue(confirmation('A'));
    const fake = fakeManagement({overview: [ok(data())], calls: {switchMemberAgent: call}});
    const ui = (connection: ConnectionStatus) => <TeamsScreen workspace={workspaceA} management={fake.api} connection={connection} />;
    const result = render(ui(connected));
    await flush();
    fireEvent.click(result.getByRole('tab', {name: 'Members'}));
    openMember('dev');
    fireEvent.click(result.getByRole('button', {name: 'Switch'}));
    await flush();
    result.rerender(ui({state: 'lost', error: 'disconnected', distro: null, command: null}));
    const dialog = result.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', {name: 'Confirm cancellation'}) as HTMLButtonElement;
    const cancel = within(dialog).getByRole('button', {name: 'Cancel'});
    expect(confirm.disabled).toBe(true);
    expect(document.activeElement).toBe(cancel);
    fireEvent.click(confirm);
    fireEvent.keyDown(cancel, {key: 'Tab'});
    expect(document.activeElement).toBe(cancel);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('keeps_focus_in_confirmation_while_switch_is_pending', async () => {
    const call = vi.fn().mockResolvedValueOnce(confirmation('A')).mockImplementationOnce(() => new Promise(() => {}));
    const {result} = await renderLive({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    fireEvent.click(result.getByRole('button', {name: 'Switch'})); await act(async () => {});
    const dialog = result.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', {name: 'Confirm cancellation'}) as HTMLButtonElement;
    const cancel = within(dialog).getByRole('button', {name: 'Cancel'});
    fireEvent.click(confirm); await act(async () => {});
    expect(confirm.disabled).toBe(true);
    expect(document.activeElement).toBe(cancel);
    expect(call).toHaveBeenCalledTimes(2);
    expect(fireEvent.keyDown(cancel, {key: 'Tab', shiftKey: true})).toBe(false);
    expect(document.activeElement).toBe(cancel);
    expect(fireEvent.keyDown(cancel, {key: 'Tab'})).toBe(false);
    expect(document.activeElement).toBe(cancel);
  });

  it('eligible_and_disabled_switch_states', async () => {
    const call = vi.fn(() => new Promise(() => {}));
    const {result} = await renderLive({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    const button = result.getByRole('button', {name: 'Switch'}) as HTMLButtonElement;
    expect(button.disabled).toBe(false); fireEvent.click(button);
    expect(call).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'codex-gpt'); expect(button.disabled).toBe(true);
  });
  it('active_resume_makes_available_when_backend_reports_it', async () => {
    const held = {...live, availability: 'limit_reached', quotaHolds: {'opencode-sonnet': null}};
    const resume = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', option: 'opencode-sonnet', cleared: true, activeAgent: 'opencode-sonnet'}});
    const {result} = await renderLive({overview: [{ok: true, data: data(held)}, {ok: true, data: data({...held, availability: 'idle', quotaHolds: {}})}], calls: {resumeMemberAgent: resume}});
    fireEvent.click(result.getByRole('button', {name: 'Resume'})); await act(async () => {});
    expect(result.getByText('Quota hold cleared for active option OpenCode Sonnet; quota was not verified. Availability is shown from refreshed backend state.')).toBeTruthy();
    expect(result.getAllByText('Available').length).toBeGreaterThan(0);
  });
  it('active_resume_keeps_refreshed_quota_limit_and_other_holds', async () => {
    const held = {...live, availability: 'limit_reached', quotaHolds: {'opencode-sonnet': null, 'codex-gpt': null}};
    const refreshed = {...held, quotaHolds: {'codex-gpt': null}};
    const resume = vi.fn().mockResolvedValue(ok({teamId: 't', memberId: 'dev', agentId: 'a', option: 'opencode-sonnet', cleared: true, activeAgent: 'opencode-sonnet'}));
    const switchCall = vi.fn();
    const {result, fake} = await renderLive({overview: [ok(data(held)), ok(data(refreshed))], calls: {resumeMemberAgent: resume, switchMemberAgent: switchCall}});
    const actions = within(result.getByRole('region', {name: 'Live agent actions for dev'}));
    const rows = actions.getAllByRole('listitem');
    fireEvent.click(within(rows[0]!).getByRole('button', {name: 'Resume'}));
    await flush();
    expect(resume).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'opencode-sonnet');
    expect(switchCall).not.toHaveBeenCalled();
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(result.getByText('Quota hold cleared for active option OpenCode Sonnet; quota was not verified. Availability is shown from refreshed backend state.')).toBeTruthy();
    expect(actions.getByText(/limit_reached/)).toBeTruthy();
    const updatedRows = actions.getAllByRole('listitem');
    expect(within(updatedRows[0]!).queryByRole('button', {name: 'Resume'})).toBeNull();
    expect(within(updatedRows[1]!).getByRole('button', {name: 'Resume'})).toBeTruthy();
  });
  it('disconnected_stale_missing_and_permission_errors', async () => {
    const call = vi.fn().mockResolvedValue({ok: false, error: {code: 'PERMISSION_DENIED', message: 'Denied exactly', remediation: 'Ask an administrator.', retryable: false}});
    const {result} = await renderLive({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    fireEvent.click(result.getByRole('button', {name: 'Switch'})); await act(async () => {});
    expect(result.container.textContent).toContain('PERMISSION_DENIED: Denied exactly'); expect(result.getByText('Ask an administrator.')).toBeTruthy();
    result.unmount();
    const fake = fakeManagement({overview: [{ok: true, data: data()}]});
    const disconnected = render(<TeamsScreen workspace={workspaceA} management={fake.api} connection={{state: 'lost', error: null, distro: null, command: 'serve'}} />);
    await act(async () => {});
    await openTab(disconnected, 'Members');
    openMember('dev');
    expect((disconnected.getByRole('button', {name: 'Switch'}) as HTMLButtonElement).disabled).toBe(true);
    expect(disconnected.container.textContent).toContain('Backend disconnected; live actions are disabled.');
    disconnected.unmount();
    const unavailable = await renderLive({overview: [{ok: true, data: data()}], agents: [{ok: false, error: {code: 'ERROR', message: 'Unavailable', retryable: false}}]});
    expect((unavailable.result.getByRole('button', {name: 'Switch'}) as HTMLButtonElement).disabled).toBe(true);
    expect(unavailable.result.container.textContent).toContain('Agent catalog unavailable; switching is disabled.');
  });
  it('actions_are_scoped_to_team_and_member', async () => {
    const other = team({id: 'other-team', name: 'Other Team', runtime: {state: 'running', teamId: 'other', status: 'running'}, members: [member({runtime: live})]});
    const first = data().teams[0]!;
    const call = vi.fn(() => new Promise(() => {}));
    const {result} = await renderLive({overview: [{ok: true, data: overviewFixture([first, other])}], calls: {switchMemberAgent: call}});
    fireEvent.click(result.getByRole('button', {name: 'Switch'}));
    fireEvent.click(card(result.getByRole('region', {name: 'Workspace teams'}), 'Other Team'));
    await openTab(result, 'Members');
    openMember('dev');
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
    const {result, fake} = await renderLive({overview: [{ok: true, data: initial}, read, {ok: true, data: done}], calls: {switchMemberAgent: call}});
    vi.useFakeTimers();
    try {
      fireEvent.click(result.getByRole('button', {name: 'Switch'}));
      fireEvent.click(result.getByRole('button', {name: 'Back to members'}));
      openMember('qa');
      fireEvent.click(result.getByRole('button', {name: 'Switch'}));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(fake.overview).toHaveBeenCalledTimes(2);
      await act(async () => { resolveRead({ok: true, data: done}); });
      expect(fake.overview).toHaveBeenCalledTimes(3);
      expect(result.queryByText(/Settings refresh was superseded/)).toBeNull();
      expect(result.getByText('Switch to Codex GPT completed.')).toBeTruthy();
      fireEvent.click(result.getByRole('button', {name: 'Back to members'}));
      openMember('dev');
      expect(result.getByText('Switch to Codex GPT completed.')).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(fake.overview).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
  it('confirmed_error_preserves_assignment_data', async () => {
    const call = vi.fn().mockResolvedValue(confirmation('assignment-A'));
    const {result} = await renderLive({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    fireEvent.click(result.getByRole('button', {name: 'Switch'})); await act(async () => {});
    fireEvent.click(result.getByRole('button', {name: 'Confirm cancellation'})); await act(async () => {});
    expect(result.getByRole('alert').textContent).toContain('assignment-A');
  });
  it('pending_completed_and_failed_results', async () => {
    const old = {state: 'completed' as const, requestedAgent: 'codex-gpt', assignmentId: null, code: null, message: null, at: 'old'};
    const pending = {...live, pendingAgent: 'codex-gpt', lastSwitch: {...old, state: 'pending' as const, at: 'new'}};
    const done = {...live, lastSwitch: {...old, at: 'new'}};
    const call = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', activeAgent: 'codex-gpt', provider: 'p'}});
    const {result, fake} = await renderLive({overview: [{ok: true, data: data({...live, lastSwitch: old})}, {ok: true, data: data({...live, lastSwitch: old})}, {ok: true, data: data(pending)}, {ok: true, data: data(done)}], calls: {switchMemberAgent: call}});
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

  it('polling_ignores_a_new_terminal_result_for_another_target', async () => {
    const old = {state: 'completed' as const, requestedAgent: 'codex-gpt', assignmentId: null, code: null, message: null, at: 'old'};
    const unrelated = {...old, requestedAgent: 'opencode-sonnet', at: 'new'};
    const matching = {...old, at: 'newer'};
    const call = vi.fn().mockResolvedValue(ok({teamId: 't', memberId: 'dev', agentId: 'a', activeAgent: 'codex-gpt', provider: 'p'}));
    const {result, fake} = await renderLive({overview: [ok(data({...live, lastSwitch: old})), ok(data({...live, lastSwitch: old})), ok(data({...live, lastSwitch: unrelated})), ok(data({...live, lastSwitch: matching}))], calls: {switchMemberAgent: call}});
    vi.useFakeTimers();
    try {
      fireEvent.click(result.getByRole('button', {name: 'Switch'}));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(fake.overview).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(fake.overview).toHaveBeenCalledTimes(3);
      expect(result.getByText('Switch to OpenCode Sonnet completed.')).toBeTruthy();
      expect((result.getByRole('button', {name: 'Switch'}) as HTMLButtonElement).disabled).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(fake.overview).toHaveBeenCalledTimes(4);
      expect(result.getByText('Switch to Codex GPT completed.')).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(fake.overview).toHaveBeenCalledTimes(4);
      expect(call).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'codex-gpt');
    } finally { vi.useRealTimers(); }
  });

  it('resume_bad_request_preserves_all_backend_error_details', async () => {
    const held = {...live, quotaHolds: {'codex-gpt': null}};
    const error = {code: 'BAD_REQUEST', message: 'Hold could not be cleared.', remediation: 'Inspect the hold.', data: {option: 'codex-gpt', reason: 'invalid'}, retryable: false};
    const resume = vi.fn().mockResolvedValue({ok: false, error});
    const {result} = await renderLive({overview: [ok(data(held))], calls: {resumeMemberAgent: resume}});
    fireEvent.click(result.getByRole('button', {name: 'Resume'}));
    await flush();
    const alert = result.getByRole('alert');
    expect(alert.textContent).toContain('BAD_REQUEST: Hold could not be cleared.');
    expect(alert.textContent).toContain('Inspect the hold.');
    expect(alert.textContent).toContain(JSON.stringify(error.data));
    expect(resume).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'codex-gpt');
    expect(result.queryByRole('dialog')).toBeNull();
  });

  it('failed_projection_stops_polling_and_preserves_backend_details', async () => {
    const failed = {...live, lastSwitch: {state: 'failed' as const, requestedAgent: 'codex-gpt', assignmentId: null, code: 'PROVIDER_UNAVAILABLE', message: 'Provider unavailable', at: 'new'}};
    const call = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', pendingAgent: 'codex-gpt', assignmentId: 'a', cancellation: 'requested'}});
    const {result, fake} = await renderLive({overview: [{ok: true, data: data()}, {ok: true, data: data(failed)}], calls: {switchMemberAgent: call}});
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
    const {result, fake} = await renderLive({overview: [{ok: true, data: data()}, {ok: true, data: data(pending)}], calls: {switchMemberAgent: call}});
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
    const {result, fake} = await renderLive({overview: [{ok: true, data: data()}, {ok: true, data: data(pending)}, {ok: false, error}], calls: {switchMemberAgent: call}});
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
    const {result} = await renderLive({overview: [{ok: true, data: data(held)}], calls: {resumeMemberAgent: resume}});
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
    const {result} = await renderLive({overview: [{ok: true, data: data(held)}, refresh], calls: {resumeMemberAgent: resume, switchMemberAgent: switchCall}});
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
    const {result} = await renderLive({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    fireEvent.click(result.getByRole('button', {name: 'Switch'})); await act(async () => {});
    expect(result.getByRole('alert').textContent).toContain(payload);
    expect(result.getByRole('alert').querySelector('img')).toBeNull();
  });
  it('provider_unavailable_is_rendered_verbatim', async () => {
    const call = vi.fn().mockResolvedValue({ok: false, error: {code: 'PROVIDER_UNAVAILABLE', message: "Provider 'codex' is not ready: offline", remediation: 'Start the provider.', retryable: false}});
    const {result} = await renderLive({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
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
      const {result} = await renderLive({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
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
    const {result} = await renderLive({overview: [{ok: true, data: data(held)}], calls: {resumeMemberAgent: resume}});
    fireEvent.click(result.getByRole('button', {name: 'Resume'}));
    await act(async () => {});
    expect(result.getByRole('alert').textContent).toContain("INTERNAL: The member's quota holds are invalid; no hold was cleared.");
    expect(result.getByRole('alert').textContent).toContain('Inspect holds.');
    expect(result.getByRole('button', {name: 'Resume'})).toBeTruthy();
  });
  it('changed_assignment_refocuses_confirmation', async () => {
    const call = vi.fn().mockResolvedValueOnce(confirmation('A')).mockResolvedValueOnce(confirmation('B'));
    const {result} = await renderLive({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    fireEvent.click(result.getByRole('button', {name: 'Switch'})); await act(async () => {});
    fireEvent.click(result.getByRole('button', {name: 'Confirm cancellation'})); await act(async () => {});
    expect(document.activeElement).toBe(result.getByRole('button', {name: 'Cancel'}));
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('disabled_states_and_missing_catalog_are_visible', async () => {
    for (const [runtime, reason] of [
      [{...live, stale: true}, 'Live member state is stale; refresh before switching or resuming.'],
      [{...live, paneState: 'dead'}, "The member's pane is not alive."],
      [{...live, pendingAgent: 'codex-gpt'}, 'A switch is already pending for this member.'],
      [{...live, quotaHolds: {'codex-gpt': null}}, "Agent 'codex-gpt' is on quota hold."],
    ] as const) {
      const {result} = await renderLive({overview: [{ok: true, data: data(runtime)}]});
      expect((result.getByRole('button', {name: 'Switch'}) as HTMLButtonElement).disabled).toBe(true);
      expect(result.getAllByText(reason).length).toBeGreaterThan(0);
      result.unmount();
    }
    const {result} = await renderLive({overview: [{ok: true, data: data()}], agents: [{ok: true, data: catalogFixture({agents: []})}]});
    expect((result.getByRole('button', {name: 'Switch'}) as HTMLButtonElement).disabled).toBe(true);
    expect(result.getByText("Agent 'codex-gpt' is missing from the catalog.")).toBeTruthy();
  });
  it('inline_member_has_no_live_actions', async () => {
    const inline = member({agentMode: 'inline', source: 'inline', runtime: live});
    const {result} = await renderLive({overview: [{ok: true, data: overviewFixture([team({runtime: {state: 'running', teamId: 't', status: 'running'}, members: [inline]})])}]});
    expect(result.queryByRole('button', {name: 'Switch'})).toBeNull();
    expect(result.queryByRole('button', {name: 'Resume'})).toBeNull();
  });
  it('refresh_failure_after_switch_preserves_backend_error', async () => {
    const call = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', activeAgent: 'codex-gpt', provider: 'p'}});
    const {result, fake} = await renderLive({overview: [{ok: true, data: data()}, {ok: false, error: {code: 'REFRESH_ERROR', message: 'Read failed', remediation: 'Retry the read.', retryable: true}}], calls: {switchMemberAgent: call}});
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
    const {result, fake} = await renderLive({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
    vi.useFakeTimers();
    try {
      fireEvent.click(result.getByRole('button', {name: 'Switch'}));
      await act(async () => {});
      result.unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(fake.overview).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('late_switch_response_after_unmount_does_not_start_polling_or_open_confirmation', async () => {
    const response = deferred<ReturnType<typeof confirmation>>();
    const call = vi.fn(() => response.promise);
    const {result, fake} = await renderLive({overview: [ok(data())], calls: {switchMemberAgent: call}});
    vi.useFakeTimers();
    try {
      fireEvent.click(result.getByRole('button', {name: 'Switch'}));
      result.unmount();
      await act(async () => { response.resolve(confirmation('late-assignment')); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(call).toHaveBeenCalledTimes(1);
      expect(fake.overview).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('workspace_change_dismisses_confirmation_without_cancel_request', async () => {
    const call = vi.fn().mockResolvedValue(confirmation('assignment-A'));
    const {result, fake} = await renderLive({overview: [ok(data())], calls: {switchMemberAgent: call}});
    fireEvent.click(result.getByRole('button', {name: 'Switch'}));
    await flush();
    expect(result.getByRole('dialog').textContent).toContain('assignment-A');
    result.rerender(<TeamsScreen workspace={{...workspaceA, id: 'ws-b'}} management={fake.api} />);
    await flush();
    expect(result.queryByRole('dialog')).toBeNull();
    expect(call).toHaveBeenCalledTimes(1);
    expect(fake.overview).toHaveBeenLastCalledWith('ws-b');
  });

  it('workspace_change_cancels_outstanding_switch_poll_timer', async () => {
    const call = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', activeAgent: 'codex-gpt', provider: 'p'}});
    const {result, fake} = await renderLive({overview: [{ok: true, data: data()}], calls: {switchMemberAgent: call}});
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
    const {result} = await renderLive({overview: [{ok: true, data: data(held)}, {ok: true, data: data({...held, quotaHolds: {}})}], calls: {resumeMemberAgent: resume}});
    expect(result.getByText("Agent 'missing' is missing from the catalog.")).toBeTruthy();
    fireEvent.click(result.getByRole('button', {name: 'Resume'}));
    await act(async () => {});
    expect(resume).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'missing');
    expect(result.getByText('Quota hold cleared for inactive option missing; quota was not verified. The live agent and assignment were not changed.')).toBeTruthy();
  });

  it('live_actions_use_frozen_options_and_runtime_metadata', async () => {
    const runtime = {...live, configuredAgents: ['opencode-sonnet', 'removed', 'codex-gpt'], provider: 'actual-provider', model: 'actual-model', reasoning: 'high', quotaHolds: {removed: null, extra: null}};
    const saved = member({runtime, defaultAgent: 'saved-only', provider: 'saved-provider', model: 'saved-model'});
    const {result} = await renderLive({overview: [{ok: true, data: overviewFixture([team({runtime: {state: 'running', teamId: 't', status: 'running'}, members: [saved]})])}]});
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

  it('hold_only_catalog_option_with_unknown_frozen_eligibility_can_resume', async () => {
    const held = {...live, configuredAgents: null, quotaHolds: {'codex-gpt': '2026-01-02T03:04:00Z'}};
    const resume = vi.fn().mockResolvedValue(ok({teamId: 't', memberId: 'dev', agentId: 'a', option: 'codex-gpt', cleared: true, activeAgent: 'opencode-sonnet'}));
    const switchCall = vi.fn();
    const {result} = await renderLive({overview: [ok(data(held)), ok(data({...held, quotaHolds: {}}))], calls: {resumeMemberAgent: resume, switchMemberAgent: switchCall}});
    const actions = within(result.getByRole('region', {name: 'Live agent actions for dev'}));
    expect(actions.getByText('Live agent eligibility is unavailable.')).toBeTruthy();
    expect(actions.getByText(/Resets at 2026-01-02 03:04 UTC/)).toBeTruthy();
    expect(actions.queryByRole('button', {name: 'Switch'})).toBeNull();
    fireEvent.click(actions.getByRole('button', {name: 'Resume'}));
    await flush();
    expect(resume).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'codex-gpt');
    expect(switchCall).not.toHaveBeenCalled();
    expect(result.getByText('Quota hold cleared for inactive option Codex GPT; quota was not verified. The live agent and assignment were not changed.')).toBeTruthy();
  });

  it('pending_switch_disables_resume_of_an_inactive_hold', async () => {
    const held = {...live, pendingAgent: 'codex-gpt', quotaHolds: {'codex-gpt': null}};
    const resume = vi.fn().mockResolvedValue({ok: true, data: {teamId: 't', memberId: 'dev', agentId: 'a', option: 'codex-gpt', cleared: false, activeAgent: 'opencode-sonnet'}});
    const {result} = await renderLive({overview: [{ok: true, data: data(held)}], calls: {resumeMemberAgent: resume}});
    expect((result.getByRole('button', {name: 'Switch'}) as HTMLButtonElement).disabled).toBe(true);
    const button = result.getByRole('button', {name: 'Resume'}) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button); await act(async () => {});
    expect(resume).not.toHaveBeenCalled();
    expect(result.getByText('Switch to Codex GPT pending.')).toBeTruthy();
  });

});

describe('T-082 live controls', () => {
  const live = { ...twoTeams().teams[1]!.members[0]!.runtime!, configuredAgents: ['opencode-sonnet', 'codex-gpt'], activeAgent: 'opencode-sonnet', paneState: 'alive', availability: 'idle' };
  const data = (runtime = live) => overviewFixture([team({ runtime: { state: 'running', teamId: RUN_TEAM_ID, status: 'running' }, members: [member({ runtime })] })]);
  const accepted = { ok: true as const, data: { teamId: 't', memberId: 'dev', agentId: 'a', activeAgent: 'codex-gpt', provider: 'p' } };
  const needsConfirmation = (id: string) => ({ ok: false as const, error: { code: 'BAD_REQUEST', message: 'Member has an active assignment; confirm cancellation of this assignment to switch.', retryable: false, data: { assignmentId: id } } });
  async function renderLive(opts: Parameters<typeof fakeManagement>[0] = {}, connection?: ConnectionStatus) {
    const out = await renderScreen(opts, connection);
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    openMember('dev');
    await flush();
    return out;
  }
  const switchButton = () => screen.getByRole('button', { name: 'Switch' }) as HTMLButtonElement;

  it('disconnected_unavailable_and_stale_runtime_disable_live_actions', async () => {
    const switchMemberAgent = vi.fn(); const resumeMemberAgent = vi.fn();
    const held = { ...live, quotaHolds: { 'codex-gpt': null } };
    const first = await renderLive({ overview: [ok(data(held))], calls: { switchMemberAgent, resumeMemberAgent } }, connectionFixture('lost'));
    expect(screen.getAllByText(/Backend disconnected; live actions are disabled\./).length).toBeGreaterThan(0);
    expect(button('Resume').disabled).toBe(true);
    first.result.unmount();
    const stale = await renderLive({ overview: [ok(data({ ...held, stale: true }))], calls: { switchMemberAgent, resumeMemberAgent } });
    expect(screen.getAllByText(/stale/i).length).toBeGreaterThan(0);
    expect(button('Resume').disabled).toBe(true);
    stale.result.unmount();
    const failed = await renderLive({ overview: [ok(data()), managementError('READ_FAILED', 'unreadable')], calls: { switchMemberAgent, resumeMemberAgent } });
    expect(switchButton().disabled).toBe(false);
    fireEvent.click(button('Refresh')); await flush();
    expect(screen.getByRole('region', { name: 'dev' })).toBeTruthy();
    expect(switchButton().disabled).toBe(true);
    fireEvent.click(switchButton());
    expect(failed.fake.overview).toHaveBeenCalledTimes(2);
    expect(switchMemberAgent).not.toHaveBeenCalled(); expect(resumeMemberAgent).not.toHaveBeenCalled();
  });

  it('rapid_switch_resume_and_board_clicks_send_one_typed_call', async () => {
    const holdSwitch = deferred<typeof accepted>();
    const switchMemberAgent = vi.fn(() => holdSwitch.promise);
    const runBoard = vi.fn(() => new Promise(() => {}));
    await renderLive({ overview: [ok(data())], calls: { switchMemberAgent, runBoard } });
    fireEvent.click(switchButton()); fireEvent.click(switchButton());
    expect(switchMemberAgent).toHaveBeenCalledTimes(1);
    expect(switchMemberAgent).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'codex-gpt');
    expect(switchButton().disabled).toBe(true);
    cleanup();
    const holdResume = deferred<{ ok: true; data: { teamId: string; memberId: string; agentId: string; option: string; cleared: boolean; activeAgent: string } }>();
    const resumeMemberAgent = vi.fn(() => holdResume.promise);
    await renderLive({ overview: [ok(data({ ...live, quotaHolds: { 'codex-gpt': null } }))], calls: { resumeMemberAgent } });
    fireEvent.click(button('Resume')); fireEvent.click(button('Resume'));
    expect(resumeMemberAgent).toHaveBeenCalledTimes(1);
    expect(resumeMemberAgent).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'codex-gpt');
    cleanup();
    await renderScreen({ overview: [ok(data())], calls: { runBoard } });
    fireEvent.click(boardButton('Run board')); fireEvent.click(boardButton('Run board'));
    expect(runBoard).toHaveBeenCalledTimes(1);
    expect(runBoard).toHaveBeenCalledWith('ws-a', RUN_TEAM_ID);
  });

  it('assigned_switch_dialog_traps_focus_escapes_and_restores_opener', async () => {
    const switchMemberAgent = vi.fn().mockResolvedValue(needsConfirmation('assignment-A'));
    await renderLive({ overview: [ok(data())], calls: { switchMemberAgent } });
    const opener = switchButton(); opener.focus();
    await userEvent.keyboard('{Enter}'); await flush();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe('Confirm cancellation');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent).toContain('assignment-A');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' }); const confirm = within(dialog).getByRole('button', { name: 'Confirm cancellation' });
    expect(document.activeElement).toBe(cancel);
    await userEvent.tab(); expect(document.activeElement).toBe(confirm);
    await userEvent.tab(); expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.tab({ shift: true }); expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(switchMemberAgent).toHaveBeenCalledTimes(1);
    expect(switchMemberAgent).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'codex-gpt');
  });

  it('stale_overview_disables_an_open_assignment_confirmation', async () => {
    const switchMemberAgent = vi.fn().mockResolvedValue(needsConfirmation('assignment-A'));
    await renderLive({ overview: [ok(data()), managementError('READ_FAILED', 'overview unavailable'), ok(data())], calls: { switchMemberAgent } });
    fireEvent.click(switchButton()); await flush();
    fireEvent.click(button('Refresh')); await flush();
    const confirm = button('Confirm cancellation');
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(switchMemberAgent).toHaveBeenCalledTimes(1);
    fireEvent.click(button('Retry')); await flush();
    expect(button('Confirm cancellation').disabled).toBe(false);
  });

  it('changed_assignment_requires_fresh_confirmation', async () => {
    const switchMemberAgent = vi.fn().mockResolvedValueOnce(needsConfirmation('A')).mockResolvedValueOnce(needsConfirmation('B')).mockResolvedValue(accepted);
    await renderLive({ overview: [ok(data())], calls: { switchMemberAgent } });
    fireEvent.click(switchButton()); await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' })); await flush();
    expect(switchMemberAgent).toHaveBeenNthCalledWith(2, 'ws-a', 'dev-team', 'dev', 'codex-gpt', { cancelActive: true, assignmentId: 'A' });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('B'); expect(dialog.textContent).not.toContain('assignment A');
    expect(within(dialog).getByRole('alert').textContent).toContain('fresh confirmation is required');
    expect(switchMemberAgent).toHaveBeenCalledTimes(2);
  });

  it('known_and_unknown_holds_resume_active_and_inactive_options_truthfully', async () => {
    const resumeMemberAgent = vi.fn().mockResolvedValue({ ok: true, data: { teamId: 't', memberId: 'dev', agentId: 'a', option: 'codex-gpt', cleared: true, activeAgent: 'opencode-sonnet' } });
    const held = { ...live, quotaHolds: { 'codex-gpt': '2099-01-02T03:04:00Z', 'opencode-sonnet': null } };
    await renderLive({ overview: [ok(data(held)), ok(data({ ...held, quotaHolds: { 'opencode-sonnet': null } }))], calls: { resumeMemberAgent } });
    expect(screen.getByText(/Resets at 2099-01-02 03:04 UTC/)).toBeTruthy();
    expect(screen.getByText(/Reset time unknown/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Resume' })).toHaveLength(2);
    const inactive = screen.getAllByRole('listitem').find(li => li.textContent!.includes('Codex GPT') && li.querySelector('button'))!;
    fireEvent.click(within(inactive).getByRole('button', { name: 'Resume' })); await flush();
    expect(resumeMemberAgent).toHaveBeenCalledTimes(1);
    expect(resumeMemberAgent).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'codex-gpt');
    expect(screen.getByText('Quota hold cleared for inactive option Codex GPT; quota was not verified. The live agent and assignment were not changed.')).toBeTruthy();
  });

  it('disconnect_and_unmount_clear_polling_without_late_updates', async () => {
    const switchMemberAgent = vi.fn().mockResolvedValue(accepted);
    const fake = fakeManagement({ overview: [ok(data())], calls: { switchMemberAgent } });
    const ui = (state: 'connected' | 'lost') => <TeamsScreen workspace={workspaceA} management={fake.api} connection={connectionFixture(state)} />;
    const result = render(ui('connected')); await flush();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' })); openMember('dev'); await flush();
    vi.useFakeTimers();
    try {
      fireEvent.click(switchButton()); await flush();
      result.rerender(ui('lost')); await flush();
      await act(async () => { await vi.advanceTimersByTimeAsync(SWITCH_REFRESH_INTERVAL_MS * (SWITCH_REFRESH_LIMIT + 2)); });
      expect(fake.overview).toHaveBeenCalledTimes(1);
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(screen.getByRole('alert').textContent).toContain('DISCONNECTED');
      result.rerender(ui('connected')); await flush();
      expect(fake.overview).toHaveBeenCalledTimes(2);
      fireEvent.click(switchButton()); await flush();
      result.unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(SWITCH_REFRESH_INTERVAL_MS * (SWITCH_REFRESH_LIMIT + 2)); });
      expect(fake.overview).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('switch_polling_matches_requested_agent_and_handles_failure_and_timeout', async () => {
    const switchMemberAgent = vi.fn().mockResolvedValue(accepted);
    const withSwitch = (state: 'pending' | 'completed' | 'failed', agent = 'codex-gpt') => ok(data({ ...live, lastSwitch: switchEvidence(state, agent) }));
    vi.useFakeTimers();
    try {
      const other = await renderLive({ overview: [ok(data()), withSwitch('completed', 'opencode-sonnet'), withSwitch('completed', 'codex-gpt')], calls: { switchMemberAgent } });
      fireEvent.click(switchButton()); await flush();
      await act(async () => { await vi.advanceTimersByTimeAsync(SWITCH_REFRESH_INTERVAL_MS); });
      expect(other.fake.overview).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(SWITCH_REFRESH_INTERVAL_MS); });
      expect(other.fake.overview).toHaveBeenCalledTimes(3);
      await act(async () => { await vi.advanceTimersByTimeAsync(SWITCH_REFRESH_INTERVAL_MS * 3); });
      expect(other.fake.overview).toHaveBeenCalledTimes(3);
      expect(switchMemberAgent).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'codex-gpt');
      other.result.unmount();
      const timeout = await renderLive({ overview: [ok(data()), withSwitch('pending')], calls: { switchMemberAgent } });
      fireEvent.click(switchButton()); await flush();
      await act(async () => { await vi.advanceTimersByTimeAsync(SWITCH_REFRESH_INTERVAL_MS * (SWITCH_REFRESH_LIMIT + 3)); });
      expect(timeout.fake.overview).toHaveBeenCalledTimes(1 + SWITCH_REFRESH_LIMIT);
      expect(screen.getByText('Switch accepted; completion is still pending. Refresh to check again.')).toBeTruthy();
      expect(screen.queryByText(/completed/)).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('board_run_stop_preserve_runtime_id_conflict_and_pending_results', async () => {
    const runBoard = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'BOARD_ALREADY_RUNNING', message: 'Another team owns the board.', retryable: false } }).mockResolvedValue({ ok: true, data: { board: { workspace: '/work/alpha', status: 'running', teamId: RUN_TEAM_ID }, rules: 3 } });
    const stopBoard = vi.fn().mockResolvedValue({ ok: false, error: { code: 'PENDING', message: 'The command was recorded but the coordinator has not answered yet.', retryable: true, data: { idempotencyKey: 'k-00000001' } } });
    const running = team({ runtime: { state: 'running', teamId: RUN_TEAM_ID, status: 'running' } });
    await renderScreen({ overview: [ok(overviewFixture([running]))], boardSettings: [boardOk(runner({ status: 'not_bound', coordinatorRunning: true })), boardOk(runner({ status: 'not_bound', coordinatorRunning: true })), boardOk(runningRunner())], calls: { runBoard, stopBoard } });
    fireEvent.click(boardButton('Run board')); fireEvent.click(boardButton('Run board')); await flush();
    expect(runBoard).toHaveBeenCalledTimes(1);
    expect(runBoard).toHaveBeenLastCalledWith('ws-a', RUN_TEAM_ID);
    expect(screen.getByRole('alert').textContent).toContain('BOARD_ALREADY_RUNNING');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    fireEvent.click(boardButton('Run board')); await flush();
    expect(runBoard).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status').textContent).toContain('Board is running');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(stopBoard).not.toHaveBeenCalled();
  });
});
