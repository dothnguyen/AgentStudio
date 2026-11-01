import { describe, expect, it, vi } from 'vitest';
import {
  buildStopPlan,
  TeamStopSequence,
  WAITING_CANCELLED_TEXT,
  WAITING_WITHOUT_BOARD_TEXT,
  pausedConfirmationText,
  STOP_NOW_BLOCKED_TEXT,
  waitingStatusText,
  type StopClock,
  type StopRefresh,
  type StopSequenceState,
} from '../src/renderer/teams/teamStopModel';
import type {
  AttentionCommandRequest,
  AttentionRun,
  BoardRunResult,
  BoardRunner,
  ManagementResult,
  TeamOverview,
  TeamStartResult,
} from '../src/renderer/api';
import { boardSettingsFixture, member, overviewFixture, runner, team } from './teamsFixtures';

const RUNTIME = '123e4567-e89b-42d3-a456-426614174000';
const WORKSPACE = '/work/alpha';
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: string, message: string) => ({ ok: false as const, error: { code, message, retryable: false } });

function run(overrides: Partial<AttentionRun> = {}): AttentionRun {
  return {
    workflowRunId: 'run-1', status: 'running', stage: 'develop', memberId: 'dev', ticketKey: 'T-091',
    assignmentId: 'as-1', assignmentStatus: 'running', diagnosticCode: null, delegating: false, ...overrides,
  };
}

function command(overrides: Partial<AttentionCommandRequest> = {}): AttentionCommandRequest {
  return {
    id: 'cmd-1', command: 'app-dev-dependency-add', status: 'requested', reason: null,
    workflowRunId: 'run-1', memberId: 'dev', ...overrides,
  };
}

function teamWith(runs: AttentionRun[], commands: AttentionCommandRequest[] = []): TeamOverview {
  return overviewFixture([team({
    id: 'dev-team', name: 'Dev Team',
    runtime: { state: 'running', teamId: RUNTIME, status: 'running' },
    members: [member({ memberId: 'dev', name: 'dev' }), member({ memberId: 'qa', name: 'qa' })],
    attention: { runs, commandRequests: commands, truncated: { runs: false, commandRequests: false } },
  })]);
}

function runningRunner(): BoardRunner {
  return runner({ status: 'running', teamId: RUNTIME, teamDefId: 'dev-team', runStatus: 'running' });
}

function fakeClock(): {
  clock: StopClock;
  advance(ms: number): void;
  pending(): number;
} {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    clock: {
      now: () => now,
      setTimeout: (callback, ms) => {
        const id = next++;
        timers.set(id, { at: now + ms, callback });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (handle) => { timers.delete(handle as unknown as number); },
    },
    advance(ms) {
      now += ms;
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
    },
    pending: () => timers.size,
  };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function setup(input: {
  mode?: 'stop' | 'restart';
  overview: TeamOverview;
  runner?: BoardRunner | null;
  refreshes?: TeamOverview[];
  stopBoard?: () => Promise<ManagementResult<BoardRunResult>>;
  stopTeam?: () => Promise<ManagementResult<{ teamId: string; stopped: true }>>;
  startTeam?: () => Promise<ManagementResult<TeamStartResult>>;
}) {
  const clock = fakeClock();
  const overviewTeam = input.overview.teams[0]!;
  const plan = buildStopPlan(overviewTeam, input.overview, input.runner ?? null);
  const refreshes = [...(input.refreshes ?? [])];
  const stopBoard = vi.fn(input.stopBoard ?? (async () => ok({ board: { workspace: WORKSPACE, status: 'stopped' as const, teamId: null } })));
  const stopTeam = vi.fn(input.stopTeam ?? (async () => ok({ teamId: RUNTIME, stopped: true as const })));
  const startTeam = vi.fn(input.startTeam ?? (async () => ok({
    teamId: RUNTIME, name: 'Dev Team', workspace: WORKSPACE, agents: [],
    attach: { sessionName: 's', wsl: 'w', windowsTerminal: 't', powershell: 'p', keys: {} },
  })));
  const refresh = vi.fn(async (): Promise<ManagementResult<StopRefresh>> => {
    const next = refreshes.length > 0 ? refreshes.shift()! : input.overview;
    return ok({ overview: next, runner: input.runner ?? null });
  });
  const states: StopSequenceState[] = [];
  const sequence = new TeamStopSequence({
    mode: input.mode ?? 'stop',
    teamDefId: 'dev-team',
    runtimeTeamId: RUNTIME,
    teamName: 'Dev Team',
    plan,
    deps: { stopBoard, stopTeam, startTeam, refresh, clock: clock.clock, pollMs: 2000 },
    onChange: (state) => states.push(state),
  });
  return { sequence, states, clock, stopBoard, stopTeam, startTeam, refresh, plan };
}

describe('buildStopPlan', () => {
  it('reports an idle team with no board', () => {
    const plan = buildStopPlan(team({ runtime: { state: 'running', teamId: RUNTIME, status: 'running' } }), null, runner({ status: 'stopped' }));
    expect(plan).toEqual({ working: [], paused: [], commands: [], boardRunning: false, idle: true });
  });

  it('lists running and queued work, paused runs, pending commands and the board', () => {
    const data = teamWith(
      [run(), run({ workflowRunId: 'run-2', status: 'queued', memberId: 'qa', ticketKey: 'T-090', stage: 'qa_tests' }),
        run({ workflowRunId: 'run-3', status: 'paused', memberId: 'qa', ticketKey: 'T-092', stage: 'review', diagnosticCode: 'NEEDS_INPUT' })],
      [command()],
    );
    const plan = buildStopPlan(data.teams[0]!, data, runningRunner());
    expect(plan.working).toEqual([
      { memberName: 'dev', ticketKey: 'T-091', stage: 'develop', status: 'running' },
      { memberName: 'qa', ticketKey: 'T-090', stage: 'qa_tests', status: 'queued' },
    ]);
    expect(plan.paused).toEqual([{ memberName: 'qa', ticketKey: 'T-092', stage: 'review', diagnosticCode: 'NEEDS_INPUT' }]);
    expect(plan.commands).toEqual([{ command: 'app-dev-dependency-add', memberName: 'dev' }]);
    expect(plan.boardRunning).toBe(true);
    expect(plan.idle).toBe(false);
  });

  it('does not treat another team\'s board as this team\'s board', () => {
    const data = teamWith([run()]);
    const plan = buildStopPlan(data.teams[0]!, data, runner({ status: 'running', teamId: 'c4597175-1111-2222-3333-4444f9548168' }));
    expect(plan.boardRunning).toBe(false);
    expect(buildStopPlan(data.teams[0]!, null, runner({ status: 'running', teamId: null, teamDefId: null })).boardRunning).toBe(false);
  });

  it('falls back to the member id, or a placeholder, when a run names no known member', () => {
    const data = teamWith([
      run({ memberId: 'ghost' }),
      run({ workflowRunId: 'run-2', memberId: null, ticketKey: null, stage: null }),
    ]);
    const plan = buildStopPlan(data.teams[0]!, null, runner({ status: 'stopped' }));
    expect(plan.working.map((entry) => entry.memberName)).toEqual(['ghost', 'unknown member']);
  });

  it('reads the board runner from the BoardSettings when no runner is passed', () => {
    const data = teamWith([run()]);
    const fromSettings = buildStopPlan(data.teams[0]!, boardSettingsFixture(runningRunner()));
    expect(fromSettings.boardRunning).toBe(true);

    const fromOverview = buildStopPlan(data.teams[0]!, { ...data, runner: runningRunner() } as unknown as TeamOverview);
    expect(fromOverview.boardRunning).toBe(true);
  });

  it('matches the board by definition id when the runner has no runtime team id', () => {
    const data = teamWith([run()]);
    const plan = buildStopPlan(data.teams[0]!, null, runner({ status: 'running', teamId: null, teamDefId: 'dev-team' }));
    expect(plan.boardRunning).toBe(true);
  });

  it('formats the live waiting line and the paused confirmation', () => {
    const data = teamWith([
      run(),
      run({ workflowRunId: 'run-2', memberId: 'qa', ticketKey: 'T-090', stage: 'qa_tests' }),
      run({ workflowRunId: 'run-3', status: 'paused', ticketKey: 'T-093' }),
    ]);
    const plan = buildStopPlan(data.teams[0]!, data, runningRunner());
    expect(waitingStatusText(plan, 12_000)).toBe('Waiting for dev (T-091 · develop) and qa (T-090 · qa_tests) to finish… (waiting 12s)');
    expect(plan.paused.length).toBe(1);
    expect(pausedConfirmationText(plan)).toBe('1 paused run will be cancelled and its ticket blocked: T-093');
  });

  it('joins three or more members in the waiting line', () => {
    const data = teamWith([
      run(),
      run({ workflowRunId: 'run-2', memberId: 'qa', ticketKey: 'T-090', stage: 'qa_tests' }),
      run({ workflowRunId: 'run-3', memberId: 'ghost', ticketKey: 'T-092', stage: 'review' }),
    ]);
    const plan = buildStopPlan(data.teams[0]!, data, runningRunner());
    expect(waitingStatusText(plan, 1000)).toBe('Waiting for dev (T-091 · develop), qa (T-090 · qa_tests) and ghost (T-092 · review) to finish… (waiting 1s)');
  });

  it('uses the plural ticket wording for several paused runs', () => {
    const data = teamWith([
      run({ workflowRunId: 'run-2', status: 'paused', ticketKey: 'T-093' }),
      run({ workflowRunId: 'run-3', status: 'paused', ticketKey: 'T-094' }),
    ]);
    const plan = buildStopPlan(data.teams[0]!, data, runningRunner());
    expect(pausedConfirmationText(plan)).toBe('2 paused runs will be cancelled and their tickets blocked: T-093 · T-094');
  });
});

describe('TeamStopSequence: safe stop', () => {
  it('stops the board, waits until running work finishes, then stops the team', async () => {
    const working = teamWith([run(), run({ workflowRunId: 'run-2', memberId: 'qa', ticketKey: 'T-090', stage: 'qa_tests' })]);
    const idle = teamWith([]);
    const fake = setup({ overview: working, runner: runningRunner(), refreshes: [working, working, idle, idle] });
    fake.sequence.chooseSafe();
    await flush();
    expect(fake.stopBoard).toHaveBeenCalledTimes(1);
    expect(fake.sequence.snapshot.phase).toBe('waiting');
    expect(fake.sequence.snapshot.statusText).toContain('Waiting for dev (T-091 · develop) and qa (T-090 · qa_tests)');
    expect(fake.stopTeam).not.toHaveBeenCalled();

    fake.clock.advance(2000); await flush();
    expect(fake.sequence.snapshot.phase).toBe('waiting');
    fake.clock.advance(2000); await flush();
    expect(fake.sequence.snapshot.phase).toBe('waiting');
    fake.clock.advance(2000); await flush();
    expect(fake.stopTeam).toHaveBeenCalledWith(RUNTIME);
    expect(fake.sequence.snapshot.phase).toBe('done');
    expect(fake.sequence.snapshot.feedback).toEqual({ kind: 'success', text: 'Stopped Dev Team.' });
    expect(fake.clock.pending()).toBe(0);
  });

  it('does not stop a board that is not running, but still waits for running work', async () => {
    const working = teamWith([run()]);
    const idle = teamWith([]);
    const fake = setup({ overview: working, runner: runner({ status: 'stopped' }), refreshes: [working, idle, idle] });
    fake.sequence.chooseSafe(); await flush();
    expect(fake.stopBoard).not.toHaveBeenCalled();
    expect(fake.sequence.snapshot.phase).toBe('waiting');
    expect(fake.stopTeam).not.toHaveBeenCalled();

    fake.clock.advance(2000); await flush();
    expect(fake.stopTeam).toHaveBeenCalledWith(RUNTIME);
    expect(fake.sequence.snapshot.phase).toBe('done');
  });

  it('stops the board and then the team when nothing is running', async () => {
    const idle = teamWith([]);
    const fake = setup({ overview: idle, runner: runningRunner() });
    fake.sequence.chooseSafe(); await flush();
    expect(fake.stopBoard).toHaveBeenCalledTimes(1);
    expect(fake.stopTeam).toHaveBeenCalledWith(RUNTIME);
    expect(fake.sequence.snapshot.feedback).toEqual({ kind: 'success', text: 'Stopped Dev Team.' });
  });

  it('ignores a second safe-path click so the board is stopped once', async () => {
    const working = teamWith([run()]);
    const fake = setup({ overview: working, runner: runningRunner() });
    fake.sequence.chooseSafe();
    fake.sequence.chooseSafe(); await flush();
    expect(fake.stopBoard).toHaveBeenCalledTimes(1);
    expect(fake.sequence.snapshot.phase).toBe('waiting');
  });

  it('aborting before any click never calls the backend', async () => {
    const fake = setup({ overview: teamWith([run()]), runner: runningRunner() });
    fake.sequence.abort();
    expect(fake.sequence.snapshot.phase).toBe('aborted');
    expect(fake.sequence.active).toBe(false);
    fake.sequence.chooseSafe();
    fake.sequence.stopNow(); await flush();
    expect(fake.stopBoard).not.toHaveBeenCalled();
    expect(fake.stopTeam).not.toHaveBeenCalled();
    expect(fake.startTeam).not.toHaveBeenCalled();
  });

  it('shows how long it has been waiting and updates as members finish', async () => {
    const two = teamWith([run(), run({ workflowRunId: 'run-2', memberId: 'qa', ticketKey: 'T-090' })]);
    const one = teamWith([run()]);
    const fake = setup({ overview: two, runner: runningRunner(), refreshes: [one] });
    fake.sequence.chooseSafe(); await flush();
    fake.clock.advance(2000); await flush();
    expect(fake.sequence.snapshot.statusText).toContain('Waiting for dev (T-091 · develop) to finish… (waiting 2s)');
  });

  it('keeps waiting without a timeout and reports the elapsed time', async () => {
    const working = teamWith([run()]);
    const fake = setup({ overview: working, runner: runningRunner() });
    fake.sequence.chooseSafe(); await flush();
    for (let i = 0; i < 30; i++) {
      fake.clock.advance(2000);
      await flush();
    }
    expect(fake.sequence.snapshot.phase).toBe('waiting');
    expect(fake.sequence.snapshot.statusText).toContain('(waiting 60s)');
    expect(fake.stopTeam).not.toHaveBeenCalled();
    expect(fake.clock.pending()).toBe(1);
  });

  it('ignores Stop now while the board is still stopping', async () => {
    let release!: () => void;
    const data = teamWith([run()]);
    const fake = setup({
      overview: data, runner: runningRunner(),
      stopBoard: () => new Promise<ManagementResult<BoardRunResult>>((resolve) => {
        release = () => resolve(ok({ board: { workspace: WORKSPACE, status: 'stopped' as const, teamId: null } }));
      }),
    });
    fake.sequence.chooseSafe(); await flush();
    expect(fake.sequence.snapshot.phase).toBe('stopping-board');
    fake.sequence.stopNow(); await flush();
    expect(fake.stopTeam).not.toHaveBeenCalled();
    release(); await flush();
    expect(fake.sequence.snapshot.phase).toBe('waiting');
    expect(fake.stopTeam).not.toHaveBeenCalled();
  });

  it('does not stop the team when the board stop fails', async () => {
    const data = teamWith([run()]);
    const fake = setup({
      overview: data, runner: runningRunner(),
      stopBoard: async () => fail('BOARD_STOP_FAILED', 'The board is not ours.'),
    });
    fake.sequence.chooseSafe(); await flush();
    expect(fake.stopBoard).toHaveBeenCalledTimes(1);
    expect(fake.stopTeam).not.toHaveBeenCalled();
    expect(fake.sequence.snapshot.phase).toBe('aborted');
    expect(fake.sequence.snapshot.feedback).toMatchObject({ kind: 'error', code: 'BOARD_STOP_FAILED', message: 'The board is not ours.' });
  });

  it('ignores paused runs while waiting, then asks once before stopping', async () => {
    const working = teamWith([run(), run({ workflowRunId: 'run-2', status: 'paused', ticketKey: 'T-093' })]);
    const pausedOnly = teamWith([run({ workflowRunId: 'run-2', status: 'paused', ticketKey: 'T-093' })]);
    const fake = setup({ overview: working, runner: runningRunner(), refreshes: [pausedOnly, pausedOnly, pausedOnly] });
    fake.sequence.chooseSafe(); await flush();
    fake.clock.advance(2000); await flush();
    expect(fake.sequence.snapshot.phase).toBe('confirm-paused');
    expect(fake.stopTeam).not.toHaveBeenCalled();

    fake.sequence.confirmPaused(); await flush();
    expect(fake.stopTeam).toHaveBeenCalledWith(RUNTIME);
    expect(fake.sequence.snapshot.phase).toBe('done');
  });

  it('ignores Stop now while it is waiting, and stops once the work finishes', async () => {
    const idle = teamWith([]);
    const fake = setup({ overview: teamWith([run()]), runner: runningRunner(), refreshes: [idle, idle] });
    fake.sequence.chooseSafe(); await flush();
    expect(fake.sequence.snapshot.phase).toBe('waiting');
    fake.sequence.stopNow(); await flush();
    expect(fake.stopTeam).not.toHaveBeenCalled();
    expect(fake.sequence.snapshot.phase).toBe('waiting');

    fake.clock.advance(2000); await flush();
    expect(fake.stopTeam).toHaveBeenCalledTimes(1);
  });

  it('ignores Confirm paused outside the paused confirmation', async () => {
    const fake = setup({ overview: teamWith([run()]), runner: runningRunner() });
    expect(fake.sequence.snapshot.phase).toBe('confirm');
    fake.sequence.confirmPaused(); await flush();
    expect(fake.sequence.snapshot.phase).toBe('confirm');
    expect(fake.stopTeam).not.toHaveBeenCalled();
  });

  it('ignores the safe path while the paused confirmation is open', async () => {
    const working = teamWith([run(), run({ workflowRunId: 'run-2', status: 'paused', ticketKey: 'T-093' })]);
    const pausedOnly = teamWith([run({ workflowRunId: 'run-2', status: 'paused', ticketKey: 'T-093' })]);
    const fake = setup({ overview: working, runner: runningRunner(), refreshes: [pausedOnly, pausedOnly, pausedOnly] });
    fake.sequence.chooseSafe(); await flush();
    fake.clock.advance(2000); await flush();
    expect(fake.sequence.snapshot.phase).toBe('confirm-paused');

    fake.sequence.chooseSafe(); await flush();
    expect(fake.sequence.snapshot.phase).toBe('confirm-paused');
    expect(fake.stopTeam).not.toHaveBeenCalled();
  });

  it('goes back to waiting when new work appears before the stop call', async () => {
    const working = teamWith([run()]);
    const idle = teamWith([]);
    const newWork = teamWith([run({ workflowRunId: 'run-9', ticketKey: 'T-099' })]);
    const fake = setup({ overview: working, runner: runningRunner(), refreshes: [idle, newWork, idle, idle] });
    fake.sequence.chooseSafe(); await flush();
    fake.clock.advance(2000); await flush();
    // The first poll saw no running work, the re-read saw new work: wait again.
    expect(fake.sequence.snapshot.phase).toBe('waiting');
    expect(fake.stopTeam).not.toHaveBeenCalled();
    fake.clock.advance(2000); await flush();
    fake.clock.advance(2000); await flush();
    expect(fake.stopTeam).toHaveBeenCalledTimes(1);
  });

  it('cancelling the wait leaves the board stopped and never stops the team', async () => {
    const working = teamWith([run()]);
    const fake = setup({ overview: working, runner: runningRunner() });
    fake.sequence.chooseSafe(); await flush();
    fake.sequence.cancelWaiting(); await flush();
    expect(fake.sequence.snapshot.phase).toBe('aborted');
    expect(fake.sequence.snapshot.feedback).toEqual({ kind: 'success', text: WAITING_CANCELLED_TEXT });
    fake.clock.advance(10_000); await flush();
    expect(fake.stopTeam).not.toHaveBeenCalled();
    expect(fake.stopBoard).toHaveBeenCalledTimes(1);
  });

  it('does not claim the board stays stopped when it was not running', async () => {
    const working = teamWith([run()]);
    const fake = setup({ overview: working, runner: runner({ status: 'stopped' }) });
    fake.sequence.chooseSafe(); await flush();
    fake.sequence.cancelWaiting(); await flush();
    expect(fake.stopBoard).not.toHaveBeenCalled();
    expect(fake.sequence.snapshot.feedback).toEqual({ kind: 'success', text: WAITING_WITHOUT_BOARD_TEXT });
    expect(fake.stopTeam).not.toHaveBeenCalled();
  });

  it('says the board stays stopped when cancelling the paused confirmation', async () => {
    const working = teamWith([run(), run({ workflowRunId: 'run-2', status: 'paused', ticketKey: 'T-093' })]);
    const pausedOnly = teamWith([run({ workflowRunId: 'run-2', status: 'paused', ticketKey: 'T-093' })]);
    const fake = setup({ overview: working, runner: runningRunner(), refreshes: [pausedOnly, pausedOnly, pausedOnly] });
    fake.sequence.chooseSafe(); await flush();
    fake.clock.advance(2000); await flush();
    expect(fake.sequence.snapshot.phase).toBe('confirm-paused');
    fake.sequence.cancel(); await flush();
    expect(fake.sequence.snapshot.phase).toBe('aborted');
    expect(fake.sequence.snapshot.feedback).toEqual({ kind: 'success', text: WAITING_CANCELLED_TEXT });
    expect(fake.stopTeam).not.toHaveBeenCalled();
  });

  it('aborting while the board stop is in flight never calls stopTeam', async () => {
    let release!: () => void;
    const data = teamWith([run()]);
    const fake = setup({
      overview: data, runner: runningRunner(),
      stopBoard: () => new Promise<ManagementResult<BoardRunResult>>((resolve) => {
        release = () => resolve(ok({ board: { workspace: WORKSPACE, status: 'stopped' as const, teamId: null } }));
      }),
    });
    fake.sequence.chooseSafe(); await flush();
    fake.sequence.abort(); await flush();
    release(); await flush();
    expect(fake.sequence.snapshot.phase).toBe('aborted');
    expect(fake.stopTeam).not.toHaveBeenCalled();
  });

  it('aborting during the wait (unmount, workspace switch or disconnect) never calls stopTeam', async () => {
    const working = teamWith([run()]);
    const fake = setup({ overview: working, runner: runningRunner() });
    fake.sequence.chooseSafe(); await flush();
    fake.clock.advance(2000); await flush();
    fake.sequence.abort();
    fake.clock.advance(10_000); await flush();
    expect(fake.stopTeam).not.toHaveBeenCalled();
    expect(fake.clock.pending()).toBe(0);
  });

  it('aborts when the team stops by itself during the wait', async () => {
    const working = teamWith([run()]);
    const stopped = overviewFixture([team({
      id: 'dev-team', name: 'Dev Team',
      runtime: { state: 'stopped', teamId: RUNTIME, status: 'stopped' },
      members: [member({ memberId: 'dev', name: 'dev' })],
    })]);
    const fake = setup({ overview: working, runner: runningRunner(), refreshes: [stopped] });
    fake.sequence.chooseSafe(); await flush();
    fake.clock.advance(2000); await flush();
    expect(fake.sequence.snapshot.phase).toBe('aborted');
    expect(fake.stopTeam).not.toHaveBeenCalled();
  });

  it('restarts after the safe stop by calling startTeam', async () => {
    const idle = teamWith([]);
    const fake = setup({ mode: 'restart', overview: idle, runner: runner({ status: 'stopped' }) });
    fake.sequence.chooseSafe(); await flush();
    expect(fake.stopTeam).toHaveBeenCalledWith(RUNTIME);
    expect(fake.startTeam).toHaveBeenCalledWith('dev-team');
    expect(fake.sequence.snapshot.feedback).toEqual({ kind: 'success', text: 'Restarted Dev Team.' });
  });

  it('stops a running board before restarting an idle team', async () => {
    const idle = teamWith([]);
    const fake = setup({ mode: 'restart', overview: idle, runner: runningRunner() });
    fake.sequence.chooseSafe(); await flush();
    expect(fake.stopBoard).toHaveBeenCalledTimes(1);
    expect(fake.stopTeam).toHaveBeenCalledWith(RUNTIME);
    expect(fake.startTeam).toHaveBeenCalledWith('dev-team');
    expect(fake.sequence.snapshot.boardStopped).toBe(true);
    expect(fake.sequence.snapshot.feedback).toEqual({ kind: 'success', text: 'Restarted Dev Team.' });
  });
});

describe('TeamStopSequence: stop now and failures', () => {
  it('stops immediately and says tickets are blocked', async () => {
    const data = teamWith([run()]);
    const fake = setup({ overview: data, runner: runningRunner() });
    fake.sequence.stopNow(); await flush();
    expect(fake.stopBoard).not.toHaveBeenCalled();
    expect(fake.stopTeam).toHaveBeenCalledWith(RUNTIME);
    expect(fake.sequence.snapshot.feedback).toEqual({
      kind: 'success', text: `Stopped Dev Team. ${STOP_NOW_BLOCKED_TEXT}`,
    });
  });

  it('mentions blocked tickets when only paused runs would be cancelled', async () => {
    const pausedOnly = teamWith([run({ status: 'paused', ticketKey: 'T-093' })]);
    const fake = setup({ overview: pausedOnly, runner: runningRunner() });
    fake.sequence.stopNow(); await flush();
    expect(fake.sequence.snapshot.feedback).toEqual({
      kind: 'success', text: `Stopped Dev Team. ${STOP_NOW_BLOCKED_TEXT}`,
    });
  });

  it('does not mention blocked tickets when stopping an idle team', async () => {
    const fake = setup({ overview: teamWith([]), runner: runner({ status: 'stopped' }) });
    fake.sequence.stopNow(); await flush();
    expect(fake.sequence.snapshot.feedback).toEqual({ kind: 'success', text: 'Stopped Dev Team.' });
  });

  it('reports a team stop failure and ends the sequence', async () => {
    const fake = setup({
      overview: teamWith([]), runner: runner({ status: 'stopped' }),
      stopTeam: async () => fail('CLEANUP_INCOMPLETE', 'The session was preserved.'),
    });
    fake.sequence.stopNow(); await flush();
    expect(fake.sequence.snapshot.phase).toBe('aborted');
    expect(fake.sequence.snapshot.feedback).toMatchObject({ kind: 'error', code: 'CLEANUP_INCOMPLETE', message: 'The session was preserved.' });
    expect(fake.startTeam).not.toHaveBeenCalled();
  });

  it('reports a start failure after a successful stop during restart', async () => {
    const fake = setup({
      mode: 'restart', overview: teamWith([]), runner: runner({ status: 'stopped' }),
      startTeam: async () => fail('PROVIDER_UNAVAILABLE', 'Provider not ready.'),
    });
    fake.sequence.stopNow(); await flush();
    expect(fake.stopTeam).toHaveBeenCalledWith(RUNTIME);
    expect(fake.sequence.snapshot.phase).toBe('aborted');
    expect(fake.sequence.snapshot.feedback).toMatchObject({ kind: 'error', code: 'PROVIDER_UNAVAILABLE' });
  });

  it('reports a refresh failure during the wait and ends the sequence', async () => {
    const working = teamWith([run()]);
    const fake = setup({ overview: working, runner: runningRunner() });
    fake.refresh.mockResolvedValueOnce(fail('OVERVIEW_FAILED', 'The overview could not be read.'));
    fake.sequence.chooseSafe(); await flush();
    fake.clock.advance(2000); await flush();
    expect(fake.sequence.snapshot.phase).toBe('aborted');
    expect(fake.sequence.snapshot.feedback).toMatchObject({ kind: 'error', code: 'OVERVIEW_FAILED' });
    expect(fake.stopTeam).not.toHaveBeenCalled();
  });
});
