// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState, type JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamStopDialog } from '../src/renderer/teams/TeamStopDialog';
import type { PausedRun, StopPlan, StopSequenceState, WorkingRun } from '../src/renderer/teams/teamStopModel';

afterEach(cleanup);

const flush = () => act(async () => {});

const working = (overrides: Partial<WorkingRun> = {}): WorkingRun => ({
  memberName: 'dev', ticketKey: 'T-091', stage: 'develop', status: 'running', ...overrides,
});
const paused = (overrides: Partial<PausedRun> = {}): PausedRun => ({
  memberName: 'qa', ticketKey: 'T-090', stage: 'qa_tests', diagnosticCode: 'ROUND_LIMIT', ...overrides,
});

function plan(overrides: Partial<StopPlan> = {}): StopPlan {
  const base: StopPlan = { working: [], paused: [], commands: [], boardRunning: false, idle: true };
  const merged = { ...base, ...overrides };
  return { ...merged, idle: merged.working.length === 0 && merged.paused.length === 0 && merged.commands.length === 0 };
}

function state(overrides: Partial<StopSequenceState> = {}): StopSequenceState {
  return {
    mode: 'stop', teamName: 'Dev Team', phase: 'confirm', plan: plan(), statusText: null,
    feedback: null, waitingSince: null, boardStopped: false, ...overrides,
  };
}

function setup(overrides: Partial<StopSequenceState> = {}) {
  const actions = {
    onChooseSafe: vi.fn(), onStopNow: vi.fn(), onCancelWaiting: vi.fn(), onConfirmPaused: vi.fn(), onCancel: vi.fn(),
  };
  render(<TeamStopDialog teamName="Dev Team" state={state(overrides)} {...actions} />);
  return actions;
}

describe('TeamStopDialog', () => {
  it('asks to stop an idle team with Cancel focused first', async () => {
    const actions = setup();
    const dialog = screen.getByRole('alertdialog', { name: 'Stop Dev Team?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('No member has running work.');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop team' })).toBeTruthy();
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['Cancel', 'Stop team']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop team' }));
    expect(actions.onStopNow).toHaveBeenCalledTimes(1);
  });

  it('lists who is working on what, paused runs and pending commands, with the safe path as the primary action', async () => {
    setup({
      phase: 'confirm',
      plan: plan({
        working: [working(), working({ memberName: 'qa', ticketKey: 'T-090', stage: 'qa_tests' })],
        paused: [paused()],
        commands: [{ command: 'app-dev-dependency-add', memberName: 'dev' }],
        boardRunning: true,
      }),
    });
    const dialog = screen.getByRole('alertdialog', { name: 'Stop Dev Team?' });
    expect(dialog.textContent).toContain('Stopping while members work cancels their runs; every affected ticket becomes blocked until someone unblocks it.');
    expect(screen.getByRole('list', { name: 'Running work' }).textContent).toContain('dev · T-091 · develop · running');
    expect(screen.getByRole('list', { name: 'Running work' }).textContent).toContain('qa · T-090 · qa_tests · running');
    expect(screen.getByRole('list', { name: 'Paused runs' }).textContent).toContain('qa · T-090 · qa_tests · ROUND_LIMIT');
    expect(screen.getByRole('list', { name: 'Pending command requests' }).textContent).toContain('app-dev-dependency-add · dev');
    const safe = screen.getByRole('button', { name: 'Stop the board and wait for running work to finish, then stop the team' });
    expect(safe.className).toContain('ui-confirm-confirm');
    expect(safe.className).not.toContain('danger');
    const stopNow = screen.getByRole('button', { name: 'Stop now (cancel running work)' });
    expect(stopNow.className).toContain('team-stop-now');
    expect(stopNow.className).toContain('ui-confirm-confirm-danger');
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Stop the board and wait for running work to finish, then stop the team',
      'Stop now (cancel running work)',
      'Cancel',
    ]);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).not.toBe(stopNow);
  });

  it('does not offer the safe path when nothing is running but work is paused or waiting for a command', () => {
    const actions = setup({
      phase: 'confirm',
      plan: plan({
        paused: [paused()],
        commands: [{ command: 'app-dev-dependency-add', memberName: 'dev' }],
        boardRunning: true,
      }),
    });
    const dialog = screen.getByRole('alertdialog', { name: 'Stop Dev Team?' });
    expect(dialog.textContent).toContain('Stopping while members work cancels their runs');
    expect(screen.queryByRole('button', { name: /Stop the board and wait for running work/ })).toBeNull();
    const stopNow = screen.getByRole('button', { name: 'Stop now (cancel running work)' });
    expect(stopNow.className).toContain('ui-confirm-confirm-danger');
    fireEvent.click(stopNow);
    expect(actions.onStopNow).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('uses Restart wording for a restart', () => {
    setup({
      mode: 'restart',
      phase: 'confirm',
      plan: plan({ working: [working()], boardRunning: true }),
    });
    const dialog = screen.getByRole('alertdialog', { name: 'Restart Dev Team?' });
    expect(dialog.textContent).toContain('Stopping while members work cancels their runs');
    expect(screen.getByRole('button', { name: 'Stop the board and wait for running work to finish, then restart the team' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restart now (cancel running work)' })).toBeTruthy();
  });

  it('says Restart team when restarting an idle team', () => {
    const actions = setup({ mode: 'restart' });
    expect(screen.getByRole('alertdialog', { name: 'Restart Dev Team?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart team' }));
    // An idle restart still stops a running board before starting again.
    expect(actions.onChooseSafe).toHaveBeenCalledTimes(1);
    expect(actions.onStopNow).not.toHaveBeenCalled();
  });

  it('does not claim the board was stopped when it was not running', () => {
    setup({
      phase: 'waiting',
      plan: plan({ working: [working()], boardRunning: false }),
      statusText: 'Waiting for dev (T-091 · develop) to finish… (waiting 1s)',
      boardStopped: false,
    });
    expect(screen.getByRole('alertdialog').textContent).toContain('The board is not running for this team.');
  });

  it('says the board is stopped after stopping it', () => {
    setup({
      phase: 'waiting',
      plan: plan({ working: [working()], boardRunning: true }),
      statusText: 'Waiting for dev (T-091 · develop) to finish… (waiting 1s)',
      boardStopped: true,
    });
    expect(screen.getByRole('alertdialog').textContent).toContain('The board is stopped.');
  });

  it('shows each backend write in a polite status with no action while it runs', () => {
    const phases = [
      ['stopping-board', 'Stopping the board…'],
      ['stopping-team', 'Stopping the team…'],
      ['starting-team', 'Starting the team…'],
    ] as const;
    for (const [phase, text] of phases) {
      setup({ phase, plan: plan({ working: [working()], boardRunning: true }) });
      const dialog = screen.getByRole('alertdialog', { name: 'Stopping Dev Team…' });
      const status = screen.getByRole('status');
      expect(dialog.contains(status)).toBe(true);
      expect(status.getAttribute('aria-live')).toBe('polite');
      expect(status.textContent).toBe(text);
      expect(screen.queryAllByRole('button')).toHaveLength(0);
      cleanup();
    }
  });

  it('uses Restart wording while a restart is in progress', () => {
    setup({ mode: 'restart', phase: 'starting-team', plan: plan({ working: [working()], boardRunning: true }) });
    expect(screen.getByRole('alertdialog', { name: 'Restarting Dev Team…' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Starting the team…');
  });

  it('shows the live waiting line and only offers Cancel waiting', async () => {
    const actions = setup({
      phase: 'waiting',
      plan: plan({ working: [working()], boardRunning: true }),
      statusText: 'Waiting for dev (T-091 · develop) to finish… (waiting 4s)',
      waitingSince: 0,
    });
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('Waiting for dev (T-091 · develop) to finish… (waiting 4s)');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel waiting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel waiting' }));
    expect(actions.onCancelWaiting).toHaveBeenCalledTimes(1);
  });

  it('cancels only the waiting when Escape is pressed', async () => {
    const user = userEvent.setup();
    const actions = setup({
      phase: 'waiting',
      plan: plan({ working: [working()], boardRunning: true }),
      statusText: 'Waiting for dev (T-091 · develop) to finish… (waiting 0s)',
    });
    await user.keyboard('{Escape}'); await flush();
    expect(actions.onCancelWaiting).toHaveBeenCalledTimes(1);
    expect(actions.onCancel).not.toHaveBeenCalled();
  });

  it('asks once more about paused runs', () => {
    const actions = setup({
      phase: 'confirm-paused',
      plan: plan({ paused: [paused(), paused({ ticketKey: 'T-093' })] }),
    });
    expect(screen.getByRole('alertdialog', { name: 'Stop Dev Team?' }).textContent)
      .toContain('2 paused runs will be cancelled and their tickets blocked: T-090 · T-093');
    expect(within(screen.getByRole('alertdialog')).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['Stop team', 'Cancel']);
    fireEvent.click(screen.getByRole('button', { name: 'Stop team' }));
    expect(actions.onConfirmPaused).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('keeps Tab inside the dialog and Escape cancels', async () => {
    const user = userEvent.setup();
    const actions = setup({ phase: 'confirm', plan: plan({ working: [working()], boardRunning: true }) });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await user.tab({ shift: true });
    expect(screen.getByRole('alertdialog').contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}'); await flush();
    expect(actions.onCancel).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the menu trigger when it closes', async () => {
    function Harness(): JSX.Element {
      const [open, setOpen] = useState(true);
      const trigger = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button type="button" ref={trigger}>More team actions</button>
          {open && (
            <TeamStopDialog
              teamName="Dev Team"
              state={state()}
              returnFocusRef={trigger}
              onChooseSafe={() => undefined}
              onStopNow={() => undefined}
              onCancelWaiting={() => undefined}
              onConfirmPaused={() => undefined}
              onCancel={() => setOpen(false)}
            />
          )}
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); await flush();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More team actions' }));
  });
});
