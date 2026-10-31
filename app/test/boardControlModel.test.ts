import { describe, expect, it } from 'vitest';
import { boardButtonAction, boardControlView, boardErrorFeedback, boardResultText } from '../src/renderer/teams/boardControlModel';
import { RUN_TEAM_ID, runner, team } from './teamsFixtures';

const NOTE = 'Running work finishes; no new tickets are claimed.';
const running = () => team({ runtime: { state: 'running', teamId: RUN_TEAM_ID, status: 'running' } });
const stoppedTeam = () => team({ runtime: { state: 'stopped', teamId: 'x', status: 'stopped' } });

describe('boardControlView', () => {
  it('view_disconnected_connection_disables_everything', () => {
    expect(boardControlView(running(), runner({ status: 'running', teamId: RUN_TEAM_ID }), false)).toEqual({
      status: 'Disconnected',
      tone: 'danger',
      detail: 'The backend connection is not available; board state cannot be read or changed.',
      canRun: false,
      canStop: false,
      runHint: null,
    });
  });

  it('view_unavailable_uses_runtime_error', () => {
    const v = boardControlView(running(), runner({ status: 'unavailable', error: { code: 'X', message: 'database locked' } }), true);
    expect(v.status).toBe('State unavailable');
    expect(v.detail).toBe('database locked');
    expect([v.canRun, v.canStop]).toEqual([false, false]);
    expect(boardControlView(running(), runner({ status: 'unavailable' }), true).detail).toBe('Runtime state could not be read.');
  });

  it('view_not_bound_running_team_can_run', () => {
    const v = boardControlView(running(), runner(), true);
    expect(v).toMatchObject({ status: 'Not running', canRun: true, canStop: false, runHint: null });
  });

  it('view_not_bound_stopped_team_has_hint', () => {
    const v = boardControlView(stoppedTeam(), runner(), true);
    expect(v.canRun).toBe(false);
    expect(v.runHint).toBe('Start this team to run the board (team: Stopped).');
  });

  it('view_stopped_board_last_run_here', () => {
    const here = boardControlView(running(), runner({ status: 'stopped', teamId: RUN_TEAM_ID }), true);
    expect(here.detail).toBe(`This team ran the board last. ${NOTE}`);
    expect(boardControlView(running(), runner({ status: 'stopped', teamId: 'other' }), true).detail).toBe(NOTE);
  });

  it('view_team_not_running_allows_takeover_and_stop', () => {
    const v = boardControlView(running(), runner({ status: 'team_not_running', teamId: 'old', teamStatus: 'stopped' }), true);
    expect(v).toMatchObject({
      tone: 'warning',
      detail: 'The bound team is stopped; no new tickets are claimed.',
      canRun: true,
      canStop: true,
    });
  });

  it('view_coordinator_disconnected', () => {
    expect(boardControlView(running(), runner({ status: 'disconnected' }), true)).toMatchObject({
      status: 'Disconnected',
      detail: 'The coordinator is not running; the board cannot claim work or be controlled. Run: agent-studio coordinator start',
      canRun: false,
      canStop: false,
    });
  });

  it('view_running_here_and_elsewhere', () => {
    expect(boardControlView(running(), runner({ status: 'running', teamId: RUN_TEAM_ID }), true))
      .toMatchObject({ status: 'Running', detail: 'With this team', tone: 'ok', canRun: false, canStop: true });
    expect(boardControlView(running(), runner({ status: 'running', teamId: 'o', teamDefId: 'release' }), true)).toMatchObject({
      status: 'Running',
      tone: 'warning',
      detail: 'Team release runs this board. Stop it before running the board with this team.',
      canRun: false,
      canStop: true,
    });
  });

  it('view_unknown_status_is_inert', () => {
    expect(boardControlView(running(), runner({ status: 'paused' as never }), true))
      .toMatchObject({ status: 'paused', canRun: false, canStop: false });
  });

  it('status_strings_use_the_short_v4_values', () => {
    const cases = [
      { r: runner({ status: 'unavailable' }), status: 'State unavailable' },
      { r: runner({ status: 'not_bound' }), status: 'Not running' },
      { r: runner({ status: 'stopped' }), status: 'Stopped' },
      { r: runner({ status: 'team_not_running', teamId: 'old' }), status: 'Team not running' },
      { r: runner({ status: 'disconnected' }), status: 'Disconnected' },
      { r: runner({ status: 'running', teamId: RUN_TEAM_ID }), status: 'Running' },
      { r: runner({ status: 'running', teamId: 'other' }), status: 'Running' },
      { r: runner({ status: 'paused' as never }), status: 'paused' },
    ];
    for (const c of cases) expect(boardControlView(running(), c.r, true).status, String(c.r.status)).toBe(c.status);
    expect(boardControlView(running(), runner({ status: 'running', teamId: RUN_TEAM_ID }), false).status).toBe('Disconnected');
  });
});

describe('board results and errors', () => {
  it('result_text_reflects_backend_outcome', () => {
    const t = team({ runtime: { state: 'running', teamId: 't-1', status: 'running' } });
    const res = (status: string, teamId: string | null) => ({ board: { workspace: '/w', status: status as never, teamId } });
    expect(boardResultText('run', t, res('running', 't-1'))).toBe('Board is running with Dev Team.');
    expect(boardResultText('run', t, res('running', 'z'))).toBe('Board is running with team z.');
    expect(boardResultText('stop', t, res('stopped', 't-1'))).toBe(`Board stopped. ${NOTE}`);
    expect(boardResultText('run', t, res('stopped', 't-1'))).toBe('Board reported status "stopped".');
  });

  it('error_feedback_titles_and_hints', () => {
    const err = (code: string, extra: object = {}) => ({ code, message: 'm', retryable: false, ...extra });
    expect(boardErrorFeedback('run', err('BOARD_ALREADY_RUNNING'))).toMatchObject({
      title: 'Board did not start.',
      hint: 'Another team already runs this board. Stop the board first, then run it with this team.',
    });
    expect(boardErrorFeedback('stop', err('TEAM_NOT_RUNNING'))).toMatchObject({
      title: 'Board did not stop.',
      hint: 'The team or the board is not running. The board state has been refreshed.',
    });
    expect(boardErrorFeedback('stop', err('PENDING'))).toMatchObject({
      hint: 'The command was recorded but not confirmed yet. Check the refreshed board state before trying again.',
    });
    expect(boardErrorFeedback('run', err('BACKEND_UNAVAILABLE', { remediation: 'Run: agent-studio coordinator start' })))
      .toMatchObject({ hint: null, remediation: 'Run: agent-studio coordinator start' });
    expect(boardErrorFeedback('run', err('BOARD_CONFIG_INVALID', { data: { problems: [{ path: 'rules[0]', message: 'bad' }] } })))
      .toMatchObject({ problems: ['rules[0]: bad'] });
  });
});

describe('selected runtime id', () => {
  it('view_selected_runtime_id_drives_relationship', () => {
    const t2 = team({ runtime: { state: 'running', teamId: 't-2', status: 'running' } });
    const other = boardControlView(t2, runner({ status: 'running', teamId: 't-1' }), true);
    expect(other.status).toBe('Running');
    expect([other.canRun, other.canStop]).toEqual([false, true]);
    expect(boardControlView(t2, runner({ status: 'running', teamId: 't-2' }), true).detail).toBe('With this team');
  });

  it('result_text_never_reports_pending_board_status_as_success', () => {
    const result = { board: { status: 'stopped' } } as unknown as Parameters<typeof boardResultText>[2];
    expect(boardResultText('run', running(), result)).toBe('Board reported status "stopped".');
  });
});

describe('boardButtonAction', () => {
  it('board_button_action_prefers_stop_then_run_else_none', () => {
    const v = (canRun: boolean, canStop: boolean) => ({ status: 's', tone: 'muted' as const, detail: null, runHint: null, canRun, canStop });
    expect(boardButtonAction(v(false, true))).toBe('stop');
    expect(boardButtonAction(v(true, true))).toBe('stop');
    expect(boardButtonAction(v(true, false))).toBe('run');
    expect(boardButtonAction(v(false, false))).toBeNull();
  });
});
