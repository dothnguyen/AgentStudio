import type { BoardRunResult, BoardRunner, ManagementError, OverviewTeam } from '../api';
import { errorFeedback, type WriteFeedback } from './teamEditModel';
import { RUNTIME_LABELS, teamLabel, type Tone } from './teamsModel';

export type BoardAction = 'run' | 'stop';

export interface BoardControlView {
  status: string;
  tone: Tone;
  detail: string | null;
  canRun: boolean;
  canStop: boolean;
  runHint: string | null;
}

export const STOPPED_NOTE = 'Running work finishes; no new tickets are claimed.';

export function boardControlView(team: OverviewTeam, runner: BoardRunner, connected: boolean): BoardControlView {
  const runnable = team.runtime.state === 'running' && team.runtime.teamId !== null;
  const here = runner.teamId !== null && runner.teamId === team.runtime.teamId;
  const hint = runnable
    ? null
    : `Start this team to run the board (team: ${RUNTIME_LABELS[team.runtime.state] ?? team.runtime.state}).`;
  const make = (
    status: string, tone: Tone, detail: string | null, canRun: boolean, canStop: boolean, runHint: string | null = null,
  ): BoardControlView => ({ status, tone, detail, canRun, canStop, runHint });

  if (!connected) {
    return make(
      'Board: Disconnected', 'danger',
      'The backend connection is not available; board state cannot be read or changed.', false, false,
    );
  }
  switch (runner.status) {
    case 'unavailable':
      return make(
        'Board: State unavailable', 'danger',
        runner.error?.message ?? 'Runtime state could not be read.', false, false,
      );
    case 'not_bound':
      return make('Board: Not running', 'muted', 'No team runs this board.', runnable, false, hint);
    case 'stopped':
      return make(
        'Board: Stopped', 'muted',
        here ? `This team ran the board last. ${STOPPED_NOTE}` : STOPPED_NOTE,
        runnable, false, hint,
      );
    case 'team_not_running':
      return make(
        'Board: Team not running', 'warning',
        `The bound team is ${runner.teamStatus ?? 'missing'}; no new tickets are claimed.`,
        runnable, true, hint,
      );
    case 'disconnected':
      return make(
        'Board: Disconnected', 'danger',
        'The coordinator is not running; the board cannot claim work or be controlled. Run: agent-studio coordinator start',
        false, false,
      );
    case 'running':
      return here
        ? make('Board: Running with this team', 'ok', null, false, true)
        : make(
          'Board: Running with another team', 'warning',
          `Team ${runner.teamDefId ?? runner.teamId ?? 'unknown'} runs this board. Stop it before running the board with this team.`,
          false, true,
        );
    default:
      return make(`Board: ${String(runner.status)}`, 'muted', null, false, false);
  }
}

export function boardResultText(action: BoardAction, team: OverviewTeam, result: BoardRunResult): string {
  if (action === 'run' && result.board.status === 'running') {
    return result.board.teamId === team.runtime.teamId
      ? `Board is running with ${teamLabel(team)}.`
      : `Board is running with team ${result.board.teamId ?? 'unknown'}.`;
  }
  if (action === 'stop' && result.board.status === 'stopped') return `Board stopped. ${STOPPED_NOTE}`;
  return `Board reported status "${result.board.status}".`;
}

export function boardErrorFeedback(action: BoardAction, error: ManagementError): WriteFeedback {
  const f = errorFeedback(action === 'run' ? 'Board did not start.' : 'Board did not stop.', error);
  if (f.kind !== 'error') return f;
  switch (error.code) {
    case 'BOARD_ALREADY_RUNNING':
      return { ...f, hint: 'Another team already runs this board. Stop the board first, then run it with this team.' };
    case 'TEAM_NOT_RUNNING':
      return { ...f, hint: 'The team or the board is not running. The board state has been refreshed.' };
    case 'PENDING':
      return { ...f, hint: 'The command was recorded but not confirmed yet. Check the refreshed board state before trying again.' };
    default:
      return f;
  }
}
