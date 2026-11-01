// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamsHarness } from './teamsHarness';
import { workspaceA } from './dashboardFixtures';
import {
  boardSettingsFixture,
  connectionFixture,
  deferred,
  fakeManagement,
  member,
  overviewFixture,
  routingSettingsFixture,
  team,
} from './teamsFixtures';
import type { AttentionCommandRequest, AttentionRun, BlockedTicket, ConnectionStatus, OverviewTeam } from '../src/renderer/api';

afterEach(cleanup);

const flush = () => act(async () => {});
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: string, message: string) => ({ ok: false as const, error: { code, message, retryable: false } });
const RUNTIME_ID = 'b4597175-1111-2222-3333-4444f9548168';

function heldMember(id: string, provider: string, optionId: string): ReturnType<typeof member> {
  return member({
    memberId: id,
    name: id,
    agentOptions: [{ id: optionId, name: optionId, provider, model: null, reasoning: null, description: null, state: 'ok' }],
    runtime: {
      agentId: `agent-${id}`, availability: 'busy', paneState: 'alive', provider, model: null, reasoning: null,
      stale: false, configuredAgents: [optionId], activeAgent: optionId, quotaHolds: { [optionId]: '2026-01-01T01:00:00Z' },
      pendingAgent: null, lastSwitch: null, assignment: null,
    },
  });
}

function runningTeam(overrides: Partial<OverviewTeam> = {}): OverviewTeam {
  return team({
    runtime: { state: 'running', teamId: RUNTIME_ID, status: 'running' },
    members: [heldMember('claude-dev', 'claude', 'claude-opus'), heldMember('codex-dev', 'codex', 'codex-gpt')],
    ...overrides,
  });
}

const blockedTicket: BlockedTicket = {
  key: 'T-090', title: 'Finish the Teams overview states', reason: 'ROUND_LIMIT:qa-ready',
  returnStatus: 'qa-ready', memberId: 'claude-dev', updatedAt: '2026-01-01T00:00:00Z',
};

const pausedRun = (id: string): AttentionRun => ({
  workflowRunId: id, status: 'paused', stage: 'develop', memberId: 'claude-dev', ticketKey: 'T-091',
  assignmentId: `as-${id}`, assignmentStatus: 'paused', diagnosticCode: 'NEEDS_INPUT', delegating: false,
});

const commandRequest = (overrides: Partial<AttentionCommandRequest> = {}): AttentionCommandRequest => ({
  id: 'cmd-1', command: 'app-dev-dependency-add', status: 'requested', reason: 'needs a package',
  workflowRunId: 'run-1', memberId: 'claude-dev', ...overrides,
});

async function renderTeam(opts: Parameters<typeof fakeManagement>[0] & { connection?: ConnectionStatus } = {}) {
  const { connection, ...fakeOpts } = opts;
  const fake = fakeManagement(fakeOpts);
  render(<TeamsHarness workspace={workspaceA} management={fake.api} connection={connection} />);
  await flush();
  return fake;
}

const menuTrigger = () => screen.getByRole('button', { name: 'More team actions' });
const item = (name: string | RegExp) => screen.getByRole('menuitem', { name });
function openMenu(): void { fireEvent.click(menuTrigger()); }

describe('team actions menu: reset usage', () => {
  it('resets the selected provider and reports the cleared and switched members', async () => {
    const resetUsage = vi.fn(async () => ok({
      teamId: RUNTIME_ID, provider: 'claude',
      members: [{ memberId: 'claude-dev', cleared: ['claude-opus'], activeAgent: 'claude-opus', switched: true }],
    }));
    await renderTeam({ overview: [ok(overviewFixture([runningTeam()]))], calls: { resetUsage } });
    openMenu(); await flush();
    fireEvent.click(item('Reset usage limits')); await flush();
    fireEvent.click(item('Claude')); await flush();
    await waitFor(() => expect(resetUsage).toHaveBeenCalledWith('ws-a', 'dev-team', 'claude'));
    expect(screen.getByRole('status').textContent).toBe('Reset claude usage limits: 1 member cleared, 1 switched to claude-opus.');
  });

  it('calls All providers once per provider that has holds, in order', async () => {
    const resetUsage = vi.fn(async (_ws: string, _team: string, provider: string) => ok({
      teamId: RUNTIME_ID, provider, members: [],
    }));
    await renderTeam({ overview: [ok(overviewFixture([runningTeam()]))], calls: { resetUsage } });
    openMenu(); await flush();
    fireEvent.click(item('Reset usage limits')); await flush();
    fireEvent.click(item('All providers')); await flush();
    await waitFor(() => expect(resetUsage).toHaveBeenCalledTimes(2));
    expect(resetUsage.mock.calls.map((call) => call[2])).toEqual(['claude', 'codex']);
  });

  it('keeps resetting the remaining providers after one fails and reports the later result', async () => {
    const resetUsage = vi.fn()
      .mockResolvedValueOnce(fail('USAGE_RESET_FAILED', 'The provider could not be reset.'))
      .mockResolvedValueOnce(ok({ teamId: RUNTIME_ID, provider: 'codex', members: [] }));
    await renderTeam({ overview: [ok(overviewFixture([runningTeam()]))], calls: { resetUsage } });
    openMenu(); await flush();
    fireEvent.click(item('Reset usage limits')); await flush();
    fireEvent.click(item('All providers')); await flush();
    await waitFor(() => expect(resetUsage).toHaveBeenCalledTimes(2));
    expect(resetUsage.mock.calls.map((call) => call[2])).toEqual(['claude', 'codex']);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Reset codex usage limits: 0 members cleared.'));
  });

  it('keeps the menu closed and shows the backend message when a reset fails', async () => {
    const resetUsage = vi.fn(async () => fail('USAGE_RESET_FAILED', 'The team is not running.'));
    await renderTeam({ overview: [ok(overviewFixture([runningTeam()]))], calls: { resetUsage } });
    openMenu(); await flush();
    fireEvent.click(item('Reset usage limits')); await flush();
    fireEvent.click(item('Claude')); await flush();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('USAGE_RESET_FAILED: The team is not running.'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('team actions menu: blocked tickets', () => {
  it('unblocks to the ticket return status', async () => {
    const unblockTicket = vi.fn(async () => ok({ ticket: { key: 'T-090', status: 'qa-ready' } }));
    const overview = overviewFixture([runningTeam()], { blockedTickets: [blockedTicket] });
    await renderTeam({ overview: [ok(overview)], boardSettings: [ok(routingSettingsFixture())], calls: { unblockTicket } });
    openMenu(); await flush();
    fireEvent.click(item('Blocked tickets (1)')); await flush();
    fireEvent.click(item(/^T-090/)); await flush();
    fireEvent.click(item('Unblock to qa-ready')); await flush();
    await waitFor(() => expect(unblockTicket).toHaveBeenCalledWith('ws-a', 'T-090', 'qa-ready'));
    expect(screen.getByRole('status').textContent).toBe('Unblocked T-090 to qa-ready.');
  });

  it('unblocks to a chosen board status without the return shortcut', async () => {
    const unblockTicket = vi.fn(async () => ok({ ticket: { key: 'T-090', status: 'dev-ready' } }));
    const overview = overviewFixture([runningTeam()], { blockedTickets: [{ ...blockedTicket, returnStatus: null }] });
    await renderTeam({ overview: [ok(overview)], boardSettings: [ok(routingSettingsFixture())], calls: { unblockTicket } });
    openMenu(); await flush();
    fireEvent.click(item('Blocked tickets (1)')); await flush();
    fireEvent.click(item(/^T-090/)); await flush();
    fireEvent.click(item('Unblock to…')); await flush();
    fireEvent.click(item('Unblock to dev-ready')); await flush();
    await waitFor(() => expect(unblockTicket).toHaveBeenCalledWith('ws-a', 'T-090', 'dev-ready'));
  });
});

describe('team actions menu: retry paused runs', () => {
  it('asks for confirmation first and then retries each run in order', async () => {
    const retryRun = vi.fn(async () => ok({
      workflowRunId: 'run-1', assignmentId: 'as-1', action: 'retry' as const, status: 'retried' as const,
    }));
    const data = runningTeam({
      attention: {
        runs: [pausedRun('run-1'), { ...pausedRun('run-2'), ticketKey: 'T-092' }],
        commandRequests: [],
        truncated: { runs: false, commandRequests: false },
      },
    });
    await renderTeam({ overview: [ok(overviewFixture([data]))], calls: { retryRun } });
    openMenu(); await flush();
    fireEvent.click(item('Retry paused runs (2)…')); await flush();
    const dialog = screen.getByRole('alertdialog', { name: 'Retry paused runs?' });
    expect(dialog.textContent).toContain('T-091 · stage develop · NEEDS_INPUT');
    expect(dialog.textContent).toContain('T-092 · stage develop · NEEDS_INPUT');
    expect(dialog.querySelectorAll('li')).toHaveLength(2);
    expect(retryRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry runs' })); await flush();
    await waitFor(() => expect(retryRun).toHaveBeenCalledTimes(2));
    expect(retryRun.mock.calls.map((call) => call[1])).toEqual(['run-1', 'run-2']);
    expect(screen.getByRole('status').textContent).toBe('Retried 2 paused runs.');
    expect(document.activeElement).toBe(menuTrigger());
  });

  it('reports a backend failure while retrying paused runs', async () => {
    const retryRun = vi.fn(async () => fail('RETRY_FAILED', 'The run is not paused.'));
    const data = runningTeam({
      attention: { runs: [pausedRun('run-1')], commandRequests: [], truncated: { runs: false, commandRequests: false } },
    });
    await renderTeam({ overview: [ok(overviewFixture([data]))], calls: { retryRun } });
    openMenu(); await flush();
    fireEvent.click(item('Retry paused runs (1)…')); await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Retry runs' })); await flush();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('RETRY_FAILED: The run is not paused.'));
    expect(retryRun).toHaveBeenCalledWith('ws-a', 'run-1');
  });

  it('keeps retrying later paused runs after one fails and reports the count', async () => {
    const retryRun = vi.fn()
      .mockResolvedValueOnce(fail('RETRY_FAILED', 'The run is not paused.'))
      .mockResolvedValueOnce(ok({ workflowRunId: 'run-2', assignmentId: 'as-run-2', action: 'retry' as const, status: 'retried' as const }));
    const data = runningTeam({
      attention: { runs: [pausedRun('run-1'), pausedRun('run-2')], commandRequests: [], truncated: { runs: false, commandRequests: false } },
    });
    await renderTeam({ overview: [ok(overviewFixture([data]))], calls: { retryRun } });
    openMenu(); await flush();
    fireEvent.click(item('Retry paused runs (2)…')); await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Retry runs' })); await flush();
    await waitFor(() => expect(retryRun).toHaveBeenCalledTimes(2));
    expect(retryRun.mock.calls.map((call) => call[1])).toEqual(['run-1', 'run-2']);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Retried 1 of 2 paused runs.'));
  });
});

describe('team actions menu: command approvals', () => {
  it('approves a request and keeps reject and cancel behind their confirmations', async () => {
    const approveCommand = vi.fn(async () => ok({ requestId: 'cmd-1', status: 'approved' }));
    const rejectCommand = vi.fn(async () => ok({ requestId: 'cmd-1', status: 'rejected' }));
    const cancelCommand = vi.fn(async () => ok({ requestId: 'cmd-2', status: 'cancelled' }));
    const data = runningTeam({
      attention: {
        runs: [pausedRun('run-1'), { ...pausedRun('run-2'), ticketKey: 'T-092' }],
        commandRequests: [commandRequest(), commandRequest({ id: 'cmd-2', command: 'app-deps-install', status: 'running', workflowRunId: 'run-2' })],
        truncated: { runs: false, commandRequests: false },
      },
    });
    await renderTeam({ overview: [ok(overviewFixture([data]))], calls: { approveCommand, rejectCommand, cancelCommand } });
    openMenu(); await flush();
    fireEvent.click(item('Command approvals (2)')); await flush();
    fireEvent.click(item('app-dev-dependency-add · T-091')); await flush();
    fireEvent.click(item('Approve')); await flush();
    await waitFor(() => expect(approveCommand).toHaveBeenCalledWith('ws-a', 'cmd-1'));
    expect(screen.getByRole('status').textContent).toBe('Approved app-dev-dependency-add.');

    openMenu(); await flush();
    fireEvent.click(item('Command approvals (2)')); await flush();
    fireEvent.click(item('app-dev-dependency-add · T-091')); await flush();
    fireEvent.click(item('Reject…')); await flush();
    expect(rejectCommand).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'not needed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject command' })); await flush();
    await waitFor(() => expect(rejectCommand).toHaveBeenCalledWith('ws-a', 'cmd-1', 'not needed'));
    expect(screen.getByRole('status').textContent).toBe('Rejected app-dev-dependency-add.');

    openMenu(); await flush();
    fireEvent.click(item('Command approvals (2)')); await flush();
    fireEvent.click(item('app-deps-install · T-092')); await flush();
    fireEvent.click(item('Cancel running command…')); await flush();
    expect(cancelCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel command' })); await flush();
    await waitFor(() => expect(cancelCommand).toHaveBeenCalledWith('ws-a', 'cmd-2', undefined));
    expect(screen.getByRole('status').textContent).toBe('Cancelled app-deps-install.');
  });

  it('rejects without a reason when the optional field is left blank', async () => {
    const rejectCommand = vi.fn(async () => ok({ requestId: 'cmd-1', status: 'rejected' }));
    const data = runningTeam({
      attention: {
        runs: [pausedRun('run-1')],
        commandRequests: [commandRequest()],
        truncated: { runs: false, commandRequests: false },
      },
    });
    await renderTeam({ overview: [ok(overviewFixture([data]))], calls: { rejectCommand } });
    openMenu(); await flush();
    fireEvent.click(item('Command approvals (1)')); await flush();
    fireEvent.click(item('app-dev-dependency-add · T-091')); await flush();
    fireEvent.click(item('Reject…')); await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Reject command' })); await flush();
    await waitFor(() => expect(rejectCommand).toHaveBeenCalledWith('ws-a', 'cmd-1', undefined));
    expect(screen.getByRole('status').textContent).toBe('Rejected app-dev-dependency-add.');
  });

  it('hides Command approvals when there are no requests', async () => {
    await renderTeam({ overview: [ok(overviewFixture([runningTeam()]))] });
    openMenu(); await flush();
    expect(screen.queryByRole('menuitem', { name: /Command approvals/ })).toBeNull();
  });

  it('keeps the menu closed and shows the backend message when approving fails', async () => {
    const approveCommand = vi.fn(async () => fail('COMMAND_UNAVAILABLE', 'The command was already handled.'));
    const data = runningTeam({
      attention: {
        runs: [pausedRun('run-1')],
        commandRequests: [commandRequest()],
        truncated: { runs: false, commandRequests: false },
      },
    });
    await renderTeam({ overview: [ok(overviewFixture([data]))], calls: { approveCommand } });
    openMenu(); await flush();
    fireEvent.click(item('Command approvals (1)')); await flush();
    fireEvent.click(item('app-dev-dependency-add · T-091')); await flush();
    fireEvent.click(item('Approve')); await flush();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('COMMAND_UNAVAILABLE: The command was already handled.'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('team actions menu: copy', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  });

  it('loads the attach command only when the item is selected, then copies it', async () => {
    const attachInfo = vi.fn(async () => ok({
      sessionName: 'agent-studio-dev-team', wsl: 'wsl.exe -d Ubuntu -- tmux attach -t agent-studio-dev-team',
      windowsTerminal: 'wt.exe wsl.exe -d Ubuntu -- tmux attach -t agent-studio-dev-team',
      powershell: 'tmux attach', keys: {},
    }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await renderTeam({ overview: [ok(overviewFixture([runningTeam()]))], calls: { attachInfo } });
    openMenu(); await flush();
    fireEvent.click(item('Copy')); await flush();
    expect(attachInfo).not.toHaveBeenCalled();
    fireEvent.click(item('Attach command (WSL)')); await flush();
    await waitFor(() => expect(attachInfo).toHaveBeenCalledWith('ws-a', RUNTIME_ID));
    expect(writeText).toHaveBeenCalledWith('wsl.exe -d Ubuntu -- tmux attach -t agent-studio-dev-team');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied Attach command (WSL)'));
  });

  it('copies the Windows Terminal attach command', async () => {
    const attachInfo = vi.fn(async () => ok({
      sessionName: 'agent-studio-dev-team', wsl: 'wsl.exe -d Ubuntu -- tmux attach -t agent-studio-dev-team',
      windowsTerminal: 'wt.exe wsl.exe -d Ubuntu -- tmux attach -t agent-studio-dev-team',
      powershell: 'tmux attach', keys: {},
    }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await renderTeam({ overview: [ok(overviewFixture([runningTeam()]))], calls: { attachInfo } });
    openMenu(); await flush();
    fireEvent.click(item('Copy')); await flush();
    fireEvent.click(item('Attach command (Windows Terminal)')); await flush();
    await waitFor(() => expect(attachInfo).toHaveBeenCalledWith('ws-a', RUNTIME_ID));
    expect(writeText).toHaveBeenCalledWith('wt.exe wsl.exe -d Ubuntu -- tmux attach -t agent-studio-dev-team');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied Attach command (Windows Terminal)'));
  });

  it('reports attach-info failures as feedback', async () => {
    const attachInfo = vi.fn(async () => fail('SESSION_NOT_FOUND', 'The tmux session has ended.'));
    await renderTeam({ overview: [ok(overviewFixture([runningTeam()]))], calls: { attachInfo } });
    openMenu(); await flush();
    fireEvent.click(item('Copy')); await flush();
    fireEvent.click(item('Attach command (Windows Terminal)')); await flush();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('SESSION_NOT_FOUND: The tmux session has ended.'));
  });

  it('copies the team id from the Copy submenu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await renderTeam({ overview: [ok(overviewFixture([runningTeam()]))] });
    openMenu(); await flush();
    fireEvent.click(item('Copy')); await flush();
    fireEvent.click(item('Team id')); await flush();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied Team id'));
    expect(writeText).toHaveBeenCalledWith('dev-team');
  });

  it('announces a copied team id on a stopped team whose header has no runtime row', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const stopped = team({ runtime: { state: 'stopped', teamId: null, status: 'stopped' } });
    await renderTeam({ overview: [ok(overviewFixture([stopped]))] });
    expect(screen.queryByRole('button', { name: 'Copy runtime id' })).toBeNull();
    openMenu(); await flush();
    fireEvent.click(item('Copy')); await flush();
    fireEvent.click(item('Team id')); await flush();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied Team id'));
    expect(writeText).toHaveBeenCalledWith('dev-team');
  });
});

describe('team actions menu: global lock', () => {
  it('cannot open while another write is pending or the connection is lost', async () => {
    await renderTeam({ overview: [ok(overviewFixture([runningTeam()]))], boardSettings: [ok(boardSettingsFixture())] });
    expect((menuTrigger() as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    await renderTeam({ overview: [ok(overviewFixture([runningTeam()]))], connection: connectionFixture('lost') });
    expect((menuTrigger() as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables the trigger while a menu action is still writing', async () => {
    const pending = deferred<{ ok: true; data: { teamId: string; provider: string; members: [] } }>();
    const resetUsage = vi.fn(() => pending.promise);
    await renderTeam({ overview: [ok(overviewFixture([runningTeam()]))], calls: { resetUsage } });
    openMenu(); await flush();
    fireEvent.click(item('Reset usage limits')); await flush();
    fireEvent.click(item('Claude')); await flush();
    await waitFor(() => expect(resetUsage).toHaveBeenCalled());
    expect((menuTrigger() as HTMLButtonElement).disabled).toBe(true);
    pending.resolve(ok({ teamId: RUNTIME_ID, provider: 'claude', members: [] }));
    await flush();
    await waitFor(() => expect((menuTrigger() as HTMLButtonElement).disabled).toBe(false));
  });
});
