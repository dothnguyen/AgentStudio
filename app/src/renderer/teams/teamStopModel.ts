import type {
  BoardRunResult,
  BoardRunner,
  BoardSettings,
  ManagementResult,
  OverviewTeam,
  TeamOverview,
  TeamStartResult,
  TeamStopResult,
} from '../api';
import { errorFeedback, thrownError, type WriteFeedback } from './teamEditModel';

export type StopMode = 'stop' | 'restart';

export interface WorkingRun {
  memberName: string;
  ticketKey: string | null;
  stage: string | null;
  status: 'running' | 'queued';
}

export interface PausedRun {
  memberName: string;
  ticketKey: string | null;
  stage: string | null;
  diagnosticCode: string | null;
}

export interface PendingCommand {
  command: string;
  memberName: string;
}

export interface StopPlan {
  working: WorkingRun[];
  paused: PausedRun[];
  commands: PendingCommand[];
  boardRunning: boolean;
  idle: boolean;
}

function memberName(team: OverviewTeam, memberId: string | null): string {
  if (memberId === null) return 'unknown member';
  const found = team.members.find((entry) => entry.memberId === memberId);
  return found?.name ?? memberId;
}

function boardRunner(overview: TeamOverview | BoardSettings | null | undefined, runner: BoardRunner | null | undefined): BoardRunner | null {
  if (runner !== undefined) return runner;
  if (overview !== null && overview !== undefined && 'runner' in overview) return overview.runner;
  return null;
}

/** True when the board runner belongs to this runtime team. */
export function boardRunsThisTeam(team: OverviewTeam, runner: BoardRunner | null): boolean {
  if (runner === null || runner.status !== 'running') return false;
  if (runner.teamId !== null) return runner.teamId === team.runtime.teamId;
  if (runner.teamDefId !== null) return runner.teamDefId === team.id;
  return false;
}

/**
 * What a team stop would affect right now. `overview` may be the TeamOverview
 * or the BoardSettings; pass the runner explicitly when both are available.
 */
export function buildStopPlan(
  team: OverviewTeam,
  overview: TeamOverview | BoardSettings | null | undefined = null,
  runner: BoardRunner | null | undefined = undefined,
): StopPlan {
  const working: WorkingRun[] = [];
  const paused: PausedRun[] = [];
  for (const run of team.attention.runs) {
    if (run.status === 'running' || run.status === 'queued') {
      working.push({
        memberName: memberName(team, run.memberId),
        ticketKey: run.ticketKey,
        stage: run.stage,
        status: run.status,
      });
    } else if (run.status === 'paused') {
      paused.push({
        memberName: memberName(team, run.memberId),
        ticketKey: run.ticketKey,
        stage: run.stage,
        diagnosticCode: run.diagnosticCode,
      });
    }
  }
  const commands = team.attention.commandRequests.map((request) => ({
    command: request.command,
    memberName: memberName(team, request.memberId),
  }));
  return {
    working,
    paused,
    commands,
    boardRunning: boardRunsThisTeam(team, boardRunner(overview, runner)),
    idle: working.length === 0 && paused.length === 0 && commands.length === 0,
  };
}

function workLine(run: WorkingRun): string {
  return `${run.memberName} (${run.ticketKey ?? 'no ticket'} · ${run.stage ?? 'unknown stage'})`;
}

export function waitingStatusText(plan: StopPlan, elapsedMs: number): string {
  const lines = plan.working.map(workLine);
  const list = lines.length <= 2
    ? lines.join(' and ')
    : `${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]}`;
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `Waiting for ${list} to finish… (waiting ${seconds}s)`;
}

export function pausedConfirmationText(plan: StopPlan): string {
  const keys = plan.paused.map((run) => run.ticketKey ?? 'unknown ticket').join(' · ');
  const count = plan.paused.length;
  const tickets = count === 1 ? 'its ticket' : 'their tickets';
  return `${count} paused run${count === 1 ? '' : 's'} will be cancelled and ${tickets} blocked: ${keys}`;
}

export const WAITING_CANCELLED_TEXT = 'Stopped waiting. The board stays stopped; use Run board to resume claiming.';
export const WAITING_WITHOUT_BOARD_TEXT = 'Stopped waiting. The team is still running.';

/** The notice after ending the wait: only mention the board when this sequence stopped it. */
export function waitingCancelledText(boardStopped: boolean): string {
  return boardStopped ? WAITING_CANCELLED_TEXT : WAITING_WITHOUT_BOARD_TEXT;
}

export const STOP_NOW_BLOCKED_TEXT = 'Tickets that had running work are now blocked; use Blocked tickets ▸ to unblock them.';

export type StopPhase =
  | 'confirm'
  | 'stopping-board'
  | 'waiting'
  | 'confirm-paused'
  | 'stopping-team'
  | 'starting-team'
  | 'done'
  | 'aborted';

export interface StopSequenceState {
  mode: StopMode;
  teamName: string;
  phase: StopPhase;
  plan: StopPlan;
  statusText: string | null;
  feedback: WriteFeedback | null;
  waitingSince: number | null;
  /** True once this sequence successfully stopped the board. */
  boardStopped: boolean;
}

export interface StopRefresh {
  overview: TeamOverview;
  runner: BoardRunner | null;
}

export interface StopClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface StopSequenceDeps {
  stopBoard(): Promise<ManagementResult<BoardRunResult>>;
  stopTeam(teamId: string): Promise<ManagementResult<TeamStopResult>>;
  startTeam(teamDefId: string): Promise<ManagementResult<TeamStartResult>>;
  refresh(): Promise<ManagementResult<StopRefresh>>;
  clock?: StopClock;
  pollMs?: number;
}

export interface StopSequenceOptions {
  mode: StopMode;
  teamDefId: string;
  runtimeTeamId: string;
  teamName: string;
  plan: StopPlan;
  deps: StopSequenceDeps;
  onChange(state: StopSequenceState): void;
}

const REAL_CLOCK: StopClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * Drives the safe stop/restart sequence. Every backend write happens after the
 * click that authorised it; abort() cancels the sequence without calling
 * team.stop, which is what an unmount, a workspace switch or a lost connection
 * must do.
 */
export class TeamStopSequence {
  private readonly clock: StopClock;
  private readonly pollMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private aborted = false;
  private pausedConfirmed = false;
  private state: StopSequenceState;

  constructor(private readonly options: StopSequenceOptions) {
    this.clock = options.deps.clock ?? REAL_CLOCK;
    this.pollMs = options.deps.pollMs ?? 2000;
    this.state = {
      mode: options.mode,
      teamName: options.teamName,
      phase: 'confirm',
      plan: options.plan,
      statusText: null,
      feedback: null,
      waitingSince: null,
      boardStopped: false,
    };
  }

  get snapshot(): StopSequenceState {
    return this.state;
  }

  get active(): boolean {
    return !this.aborted && this.state.phase !== 'done' && this.state.phase !== 'aborted';
  }

  private set(patch: Partial<StopSequenceState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onChange(this.state);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Ends the sequence without stopping the team. Safe to call repeatedly. */
  abort(): void {
    if (this.aborted || this.state.phase === 'done' || this.state.phase === 'aborted') return;
    this.aborted = true;
    this.clearTimer();
    this.set({ phase: 'aborted', statusText: null });
  }

  /** Remaining waiting ends, but the board stays stopped and the team keeps running. */
  cancelWaiting(): void {
    if (this.state.phase !== 'waiting') return;
    this.aborted = true;
    this.clearTimer();
    this.set({ phase: 'aborted', statusText: null, feedback: { kind: 'success', text: waitingCancelledText(this.state.boardStopped) } });
  }

  /** The user chose the safe path in the first dialog. */
  chooseSafe(): void {
    if (this.state.phase !== 'confirm') return;
    if (!this.state.plan.boardRunning) {
      void this.recheckBeforeStop();
      return;
    }
    this.set({ phase: 'stopping-board', statusText: 'Stopping the board…' });
    void (async () => {
      let result: ManagementResult<BoardRunResult>;
      try { result = await this.options.deps.stopBoard(); }
      catch (reason) { result = { ok: false, error: thrownError(reason) }; }
      if (this.aborted) return;
      if (!result.ok) {
        await this.refreshQuietly();
        if (this.aborted) return;
        this.aborted = true;
        this.set({ phase: 'aborted', statusText: null, feedback: errorFeedback('The board was not stopped.', result.error) });
        return;
      }
      this.set({ boardStopped: true });
      if (this.state.plan.working.length > 0) this.beginWaiting();
      else void this.recheckBeforeStop();
    })();
  }

  /** The user chose the danger action; stop (or restart) immediately. */
  stopNow(): void {
    if (this.state.phase !== 'confirm') return;
    this.clearTimer();
    void this.finalizeStop(true);
  }

  /** The user confirmed cancelling the paused runs as well. */
  confirmPaused(): void {
    if (this.state.phase !== 'confirm-paused') return;
    this.pausedConfirmed = true;
    void this.recheckBeforeStop();
  }

  /** Close without any backend write (the Cancel button). */
  cancel(): void {
    if (this.state.phase === 'confirm-paused') {
      // The board is already stopped; say so instead of closing silently.
      this.aborted = true;
      this.clearTimer();
      this.set({ phase: 'aborted', statusText: null, feedback: { kind: 'success', text: waitingCancelledText(this.state.boardStopped) } });
      return;
    }
    this.abort();
  }

  private beginWaiting(): void {
    if (this.aborted) return;
    this.clearTimer();
    const since = this.clock.now();
    this.set({
      phase: 'waiting',
      waitingSince: since,
      statusText: waitingStatusText(this.state.plan, 0),
    });
    this.schedulePoll();
  }

  private schedulePoll(): void {
    this.clearTimer();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, this.pollMs);
  }

  private async poll(): Promise<void> {
    if (this.aborted || this.state.phase !== 'waiting') return;
    const status = await this.refreshPlan();
    if (status !== 'ok' || this.aborted || this.state.phase !== 'waiting') return;
    if (this.state.plan.working.length > 0) {
      const since = this.state.waitingSince ?? this.clock.now();
      this.set({ statusText: waitingStatusText(this.state.plan, this.clock.now() - since) });
      this.schedulePoll();
      return;
    }
    this.clearTimer();
    await this.recheckBeforeStop();
  }

  private async refreshPlan(): Promise<'ok' | 'stale' | 'error'> {
    let result: ManagementResult<StopRefresh>;
    try { result = await this.options.deps.refresh(); }
    catch (reason) { result = { ok: false, error: thrownError(reason) }; }
    if (this.aborted) return 'stale';
    if (!result.ok) {
      this.aborted = true;
      this.clearTimer();
      this.set({ phase: 'aborted', statusText: null, feedback: errorFeedback('The team could not be refreshed.', result.error) });
      return 'error';
    }
    const { overview, runner } = result.data;
    const team = overview.teams.find((entry) => entry.runtime.teamId === this.options.runtimeTeamId);
    if (
      team === undefined
      || team.runtime.state !== 'running'
    ) {
      // The team stopped by itself (or was replaced): never call team.stop now.
      this.aborted = true;
      this.clearTimer();
      this.set({ phase: 'aborted', statusText: null });
      return 'stale';
    }
    this.set({ plan: buildStopPlan(team, overview, runner) });
    return 'ok';
  }

  private async recheckBeforeStop(): Promise<void> {
    if (this.aborted) return;
    const status = await this.refreshPlan();
    if (status !== 'ok' || this.aborted) return;
    if (this.state.plan.working.length > 0) {
      // A member claimed work after the dialog opened; wait again instead of stopping.
      this.beginWaiting();
      return;
    }
    if (this.state.plan.paused.length > 0 && !this.pausedConfirmed) {
      this.set({ phase: 'confirm-paused', statusText: null });
      return;
    }
    await this.finalizeStop(false);
  }

  private async finalizeStop(immediate: boolean): Promise<void> {
    if (this.aborted) return;
    const hadWork = this.state.plan.working.length > 0 || this.state.plan.paused.length > 0;
    this.set({ phase: 'stopping-team', statusText: null, feedback: null });
    let result: ManagementResult<TeamStopResult>;
    try { result = await this.options.deps.stopTeam(this.options.runtimeTeamId); }
    catch (reason) { result = { ok: false, error: thrownError(reason) }; }
    if (this.aborted) return;
    if (!result.ok) {
      await this.refreshQuietly();
      if (this.aborted) return;
      this.aborted = true;
      this.set({ phase: 'aborted', statusText: null, feedback: errorFeedback('The team was not stopped.', result.error) });
      return;
    }
    if (this.state.mode === 'restart') {
      this.set({ phase: 'starting-team' });
      let started: ManagementResult<TeamStartResult>;
      try { started = await this.options.deps.startTeam(this.options.teamDefId); }
      catch (reason) { started = { ok: false, error: thrownError(reason) }; }
      if (this.aborted) return;
      if (!started.ok) {
        await this.refreshQuietly();
        if (this.aborted) return;
        this.aborted = true;
        this.set({ phase: 'aborted', statusText: null, feedback: errorFeedback('The team was not restarted.', started.error) });
        return;
      }
      await this.refreshQuietly();
      if (this.aborted) return;
      this.aborted = true;
      this.set({ phase: 'done', statusText: null, feedback: { kind: 'success', text: `Restarted ${this.options.teamName}.` } });
      return;
    }
    await this.refreshQuietly();
    if (this.aborted) return;
    this.aborted = true;
    const blocked = immediate && hadWork ? ` ${STOP_NOW_BLOCKED_TEXT}` : '';
    this.set({ phase: 'done', statusText: null, feedback: { kind: 'success', text: `Stopped ${this.options.teamName}.${blocked}` } });
  }

  private async refreshQuietly(): Promise<void> {
    try { await this.options.deps.refresh(); } catch { /* the feedback already names the failure */ }
  }
}
