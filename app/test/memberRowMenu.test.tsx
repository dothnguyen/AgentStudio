// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamsHarness } from './teamsHarness';
import { workspaceA } from './dashboardFixtures';
import {
  deferred,
  fakeManagement,
  member,
  memberOpen,
  memberRow,
  overviewFixture,
  routingSettingsFixture,
  showMembers,
  team,
  RUN_TEAM_ID,
} from './teamsFixtures';
import { connectionFixture } from './teamsFixtures';
import type {
  AttentionCommandRequest,
  AttentionRun,
  BlockedTicket,
  ConnectionStatus,
  OverviewMember,
  OverviewTeam,
} from '../src/renderer/api';

afterEach(cleanup);

const flush = () => act(async () => {});
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: string, message: string, data?: unknown) => ({ ok: false as const, error: { code, message, retryable: false, ...(data === undefined ? {} : { data }) } });

const AGENT_OPTIONS = [
  { id: 'opencode-sonnet', name: 'OpenCode Sonnet', provider: 'opencode', model: 'sonnet', reasoning: null, description: null, state: 'ok' as const },
  { id: 'codex-gpt', name: 'Codex GPT', provider: 'codex', model: 'gpt-6', reasoning: null, description: null, state: 'ok' as const },
];

const pausedRun = (overrides: Partial<AttentionRun> = {}): AttentionRun => ({
  workflowRunId: 'run-1', status: 'paused', stage: 'develop', memberId: 'dev', ticketKey: 'T-091',
  assignmentId: 'as-1', assignmentStatus: 'paused', diagnosticCode: 'NEEDS_INPUT', delegating: false, ...overrides,
});

const commandRequest = (overrides: Partial<AttentionCommandRequest> = {}): AttentionCommandRequest => ({
  id: 'cmd-1', command: 'app-dev-dependency-add', status: 'requested', reason: 'needs a package',
  workflowRunId: 'run-1', memberId: 'dev', ...overrides,
});

const blockedTicket = (overrides: Partial<BlockedTicket> = {}): BlockedTicket => ({
  key: 'T-090', title: 'Finish the Teams overview states', reason: 'ROUND_LIMIT:qa-ready',
  returnStatus: 'qa-ready', memberId: 'dev', updatedAt: '2026-01-01T00:00:00Z', ...overrides,
});

function liveMember(overrides: Partial<OverviewMember> = {}): OverviewMember {
  return member({
    memberId: 'dev',
    name: 'dev',
    agentOptions: AGENT_OPTIONS,
    defaultAgent: 'opencode-sonnet',
    agentMode: 'ordered_catalog',
    runtime: {
      agentId: 'agent-dev', configuredAgents: ['opencode-sonnet', 'codex-gpt'], activeAgent: 'opencode-sonnet',
      quotaHolds: {}, pendingAgent: null, lastSwitch: null, assignment: null, availability: 'idle',
      paneState: 'alive', provider: 'opencode', model: 'sonnet', reasoning: null, stale: false,
    },
    presence: 'idle',
    work: { state: 'none' },
    ...overrides,
  });
}

function fixture(overrides: Partial<OverviewTeam> = {}): OverviewTeam {
  return team({
    runtime: { state: 'running', teamId: RUN_TEAM_ID, status: 'running' },
    members: [liveMember()],
    attention: { runs: [pausedRun()], commandRequests: [commandRequest()], truncated: { runs: false, commandRequests: false } },
    ...overrides,
  });
}

async function renderScreen(opts: {
  team?: OverviewTeam;
  blockedTickets?: BlockedTicket[];
  calls?: Parameters<typeof fakeManagement>[0]['calls'];
  connection?: ConnectionStatus;
  onViewRole?: (roleId: string) => void;
} = {}) {
  const fake = fakeManagement({
    overview: [ok(overviewFixture([opts.team ?? fixture()], { blockedTickets: opts.blockedTickets ?? [blockedTicket()] }))],
    boardSettings: [ok(routingSettingsFixture())],
    calls: opts.calls,
  });
  render(<TeamsHarness workspace={workspaceA} management={fake.api} connection={opts.connection} onViewRole={opts.onViewRole} />);
  await flush();
  return fake;
}

const actionsButton = (name = 'dev') => screen.getByRole('button', { name: `Actions for ${name}` }) as HTMLButtonElement;
const menuItem = (name: string | RegExp) => screen.getByRole('menuitem', { name });
async function openMenu(name = 'dev'): Promise<void> {
  fireEvent.click(actionsButton(name));
  await flush();
}
async function openSubmenu(name: string | RegExp): Promise<void> {
  fireEvent.click(menuItem(name));
  await flush();
}

describe('member row structure and opening the menu', () => {
  it('keeps the open button and the actions button as separate tab stops', async () => {
    await renderScreen();
    const open = memberOpen('dev');
    const actions = actionsButton('dev');
    expect(open).not.toBe(actions);
    expect(open.tabIndex).toBe(0);
    expect(actions.tabIndex).toBe(0);
    expect(open.getAttribute('aria-current')).toBeNull();
    expect(memberRow('dev').getAttribute('data-current')).toBeNull();
  });

  it('opens the menu with the actions button', async () => {
    await renderScreen();
    await openMenu();
    expect(screen.getByRole('menu', { name: 'Actions for dev' })).toBeTruthy();
    expect(document.activeElement).toBe(menuItem('Open details'));
  });

  it('describes the open button with the role, live agent, status and work cells', async () => {
    await renderScreen();
    const open = memberOpen('dev');
    const row = memberRow('dev');
    const ids = (open.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(ids.map((id) => document.getElementById(id)?.getAttribute('data-field'))).toEqual([
      'role', 'agent', 'availability', 'work',
    ]);
    expect(document.getElementById(ids[0]!)?.textContent).toContain('Developer');
    expect(document.getElementById(ids[1]!)?.textContent).toContain('OpenCode Sonnet');
    expect(document.getElementById(ids[2]!)?.textContent).not.toBe('');
    expect(document.getElementById(ids[3]!)?.textContent).toBe(row.querySelector('[data-field="work"]')?.textContent);
  });

  it('closes the menu with Escape and returns focus to the actions button', async () => {
    await renderScreen();
    await openMenu();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(actionsButton('dev'));
  });

  it('returns focus to the actions button after a right-click menu closes', async () => {
    await renderScreen();
    fireEvent.contextMenu(memberRow('dev'), { clientX: 120, clientY: 80 });
    await flush();
    expect(screen.getByRole('menu', { name: 'Actions for dev' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(actionsButton('dev'));
  });

  it('opens the menu at the pointer on right-click', async () => {
    await renderScreen();
    const row = memberRow('dev');
    fireEvent.contextMenu(row, { clientX: 120, clientY: 80 });
    await flush();
    const menu = screen.getByRole('menu', { name: 'Actions for dev' });
    expect(menu.style.left).toBe('124px');
    expect(menu.style.top).toBe('80px');
  });

  it('opens the menu with the Menu key and Shift+F10 on the open button', async () => {
    await renderScreen();
    const open = memberOpen('dev');
    open.focus();
    fireEvent.keyDown(open, { key: 'ContextMenu' });
    await flush();
    expect(screen.getByRole('menu', { name: 'Actions for dev' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(open);

    fireEvent.keyDown(open, { key: 'F10', shiftKey: true });
    await flush();
    expect(screen.getByRole('menu', { name: 'Actions for dev' })).toBeTruthy();
  });

  it('clicks anywhere on the row to open the detail but not through the menu button', async () => {
    await renderScreen();
    fireEvent.click(memberRow('dev').querySelector('[data-field="work"]')!);
    await flush();
    expect(screen.getByRole('region', { name: 'dev' })).toBeTruthy();
    cleanup();

    await renderScreen();
    await openMenu();
    expect(screen.queryByRole('region', { name: 'dev' })).toBeNull();
    expect(screen.getByRole('menu', { name: 'Actions for dev' })).toBeTruthy();
  });
});

describe('member row actions', () => {
  it('opens the detail from the Open details item', async () => {
    await renderScreen();
    await openMenu();
    fireEvent.click(menuItem('Open details'));
    await flush();
    expect(screen.getByRole('region', { name: 'dev' })).toBeTruthy();
  });

  it('resumes a held agent through the existing detail flow', async () => {
    const live = liveMember();
    const resumeMemberAgent = vi.fn(async () => ok({
      teamId: RUN_TEAM_ID, memberId: 'dev', agentId: 'agent-dev', option: 'codex-gpt', cleared: true, activeAgent: 'opencode-sonnet',
    }));
    await renderScreen({
      team: fixture({ members: [liveMember({ runtime: { ...live.runtime!, quotaHolds: { 'codex-gpt': null } } })] }),
      calls: { resumeMemberAgent },
    });
    await openMenu();
    await openSubmenu('Resume agent');
    fireEvent.click(menuItem('Codex GPT'));
    await flush();
    await waitFor(() => expect(resumeMemberAgent).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'codex-gpt'));
  });

  it('calls Retry stage directly and reports through the feedback line', async () => {
    const retryRun = vi.fn(async () => ok({ workflowRunId: 'run-1', assignmentId: 'as-2', action: 'retry' as const, status: 'retried' as const }));
    await renderScreen({ calls: { retryRun } });
    await openMenu();
    await openSubmenu('Current work');
    fireEvent.click(menuItem('Retry stage'));
    await flush();
    await waitFor(() => expect(retryRun).toHaveBeenCalledWith('ws-a', 'run-1'));
    expect(screen.getByRole('status').textContent).toBe('Retried the develop stage of T-091.');
  });

  it('asks for confirmation before requeueing the ticket', async () => {
    const retryTicket = vi.fn(async () => ok({ ticket: { key: 'T-091', status: 'dev-ready' } }));
    await renderScreen({ calls: { retryTicket } });
    await openMenu();
    await openSubmenu('Current work');
    fireEvent.click(menuItem('Requeue ticket…'));
    await flush();
    const dialog = screen.getByRole('alertdialog', { name: 'Requeue T-091?' });
    expect(dialog.textContent).toContain('Releases the claim and cancels the current run.');
    expect(retryTicket).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Requeue ticket' }));
    await flush();
    await waitFor(() => expect(retryTicket).toHaveBeenCalledWith('ws-a', 'T-091'));
    expect(screen.getByRole('status').textContent).toBe('Requeued T-091.');
  });

  it('asks for confirmation before stopping the run and blocking the ticket', async () => {
    const cancelRun = vi.fn(async () => ok({ workflowRunId: 'run-1', previousStatus: 'dev-ready', outcome: 'cancelled' as const, status: 'blocked' }));
    await renderScreen({ calls: { cancelRun } });
    await openMenu();
    await openSubmenu('Current work');
    fireEvent.click(menuItem('Stop run and block ticket…'));
    await flush();
    const dialog = screen.getByRole('alertdialog', { name: 'Stop the run for T-091?' });
    expect(dialog.textContent).toContain('The ticket becomes blocked');
    expect(cancelRun).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop run and block ticket' }));
    await flush();
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith('ws-a', 'run-1'));
    expect(screen.getByRole('status').textContent).toBe('Stopped the run for T-091; the ticket is blocked.');
  });

  it('names an untitled run in the stop confirmation', async () => {
    const cancelRun = vi.fn(async () => ok({ workflowRunId: 'run-1', previousStatus: 'dev-ready', outcome: 'cancelled' as const, status: 'blocked' }));
    const untitled = fixture({
      attention: { runs: [pausedRun({ ticketKey: null })], commandRequests: [], truncated: { runs: false, commandRequests: false } },
    });
    await renderScreen({ team: untitled, calls: { cancelRun } });
    await openMenu();
    await openSubmenu('Current work');
    fireEvent.click(menuItem('Stop run and block ticket…'));
    await flush();
    const dialog = screen.getByRole('alertdialog', { name: 'Stop the run?' });
    expect(dialog.textContent).toContain('The ticket becomes blocked');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop run and block ticket' }));
    await flush();
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith('ws-a', 'run-1'));
    expect(screen.getByRole('status').textContent).toBe('Stopped the run for run-1; the ticket is blocked.');
    // Confirming closes the dialog and returns focus to the row trigger.
    expect(document.activeElement).toBe(actionsButton('dev'));
  });

  it('disables saved-configuration actions for a runtime-only member with an id', async () => {
    const runtimeOnly = member({ memberId: 'live', name: 'live', source: 'runtime' });
    await renderScreen({ team: fixture({ members: [runtimeOnly] }) });
    await openMenu('live');
    const edit = menuItem('Edit configuration…');
    const remove = menuItem('Remove member…');
    expect(edit.getAttribute('aria-disabled')).toBe('true');
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    const reason = (edit.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(reason).toContain('runtime-only');
    fireEvent.click(edit);
    fireEvent.click(remove);
    await flush();
    expect(screen.queryByRole('region', { name: 'live' })).toBeNull();
  });

  it('switches the agent through the existing confirmation flow', async () => {
    const switchMemberAgent = vi.fn().mockResolvedValue(fail('BAD_REQUEST', 'Member has an active assignment; confirm cancellation of this assignment to switch.', { assignmentId: 'job-1' }));
    await renderScreen({ calls: { switchMemberAgent } });
    await openMenu();
    await openSubmenu('Switch agent');
    fireEvent.click(menuItem('Codex GPT'));
    await flush();
    await waitFor(() => expect(switchMemberAgent).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'codex-gpt'));
    const dialog = screen.getByRole('dialog', { name: 'Confirm cancellation' });
    expect(dialog.textContent).toContain('Switch dev to Codex GPT');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
  });

  it('unblocks to the return status and to a chosen board status', async () => {
    const unblockTicket = vi.fn(async () => ok({ ticket: { key: 'T-090', status: 'qa-ready' } }));
    await renderScreen({ calls: { unblockTicket } });
    await openMenu();
    await openSubmenu('Unblock');
    await openSubmenu(/^T-090/);
    fireEvent.click(menuItem('Unblock to qa-ready'));
    await flush();
    await waitFor(() => expect(unblockTicket).toHaveBeenCalledWith('ws-a', 'T-090', 'qa-ready'));
    cleanup();

    const unblockAgain = vi.fn(async () => ok({ ticket: { key: 'T-090', status: 'dev-ready' } }));
    await renderScreen({ blockedTickets: [{ ...blockedTicket(), returnStatus: null }], calls: { unblockTicket: unblockAgain } });
    await openMenu();
    await openSubmenu('Unblock');
    await openSubmenu(/^T-090/);
    await openSubmenu('Unblock to…');
    fireEvent.click(menuItem('Unblock to dev-ready'));
    await flush();
    await waitFor(() => expect(unblockAgain).toHaveBeenCalledWith('ws-a', 'T-090', 'dev-ready'));
  });

  it('approves command requests and asks before rejecting', async () => {
    const approveCommand = vi.fn(async () => ok({ requestId: 'cmd-1', status: 'approved' }));
    const rejectCommand = vi.fn(async () => ok({ requestId: 'cmd-1', status: 'rejected' }));
    await renderScreen({ calls: { approveCommand, rejectCommand } });
    await openMenu();
    await openSubmenu('Command requests');
    await openSubmenu('app-dev-dependency-add · T-091');
    fireEvent.click(menuItem('Approve'));
    await flush();
    await waitFor(() => expect(approveCommand).toHaveBeenCalledWith('ws-a', 'cmd-1'));
    expect(screen.getByRole('status').textContent).toBe('Approved app-dev-dependency-add.');

    await openMenu();
    await openSubmenu('Command requests');
    await openSubmenu('app-dev-dependency-add · T-091');
    fireEvent.click(menuItem('Reject…'));
    await flush();
    const dialog = screen.getByRole('alertdialog', { name: 'Reject command?' });
    expect(rejectCommand).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject command' }));
    await flush();
    await waitFor(() => expect(rejectCommand).toHaveBeenCalledWith('ws-a', 'cmd-1', undefined));
  });

  it('asks before cancelling a running command and reports it', async () => {
    const cancelCommand = vi.fn(async () => ok({ requestId: 'cmd-2', status: 'cancelled' }));
    const running = fixture({
      attention: {
        runs: [pausedRun()],
        commandRequests: [commandRequest({ id: 'cmd-2', command: 'app-deps-install', status: 'running' })],
        truncated: { runs: false, commandRequests: false },
      },
    });
    await renderScreen({ team: running, calls: { cancelCommand } });
    await openMenu();
    await openSubmenu('Command requests');
    await openSubmenu('app-deps-install · T-091');
    fireEvent.click(menuItem('Cancel running command…'));
    await flush();
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel running command?' });
    expect(dialog.textContent).toContain('The command stops and the run keeps going without its result.');
    expect(cancelCommand).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), { target: { value: 'no longer needed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel command' }));
    await flush();
    await waitFor(() => expect(cancelCommand).toHaveBeenCalledWith('ws-a', 'cmd-2', 'no longer needed'));
    expect(screen.getByRole('status').textContent).toBe('Cancelled app-deps-install.');
  });

  it('opens the member settings dialog with focus on its first field', async () => {
    await renderScreen();
    await openMenu();
    fireEvent.click(menuItem('Edit configuration…'));
    await flush();
    const dialog = await screen.findByRole('dialog', { name: 'Edit member settings' });
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Display name'));
  });

  it('consumes the Edit configuration intent once, so a later plain open is not an edit', async () => {
    await renderScreen();
    await openMenu();
    fireEvent.click(menuItem('Edit configuration…'));
    await flush();
    const dialog = await screen.findByRole('dialog', { name: 'Edit member settings' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await flush();
    const region = screen.getByRole('region', { name: 'dev' });
    expect(screen.queryByRole('dialog', { name: 'Edit member settings' })).toBeNull();
    fireEvent.click(within(region).getByRole('button', { name: 'Back to members' }));
    await flush();
    fireEvent.click(memberOpen('dev'));
    await flush();
    expect(screen.queryByRole('dialog', { name: 'Edit member settings' })).toBeNull();
    expect(within(screen.getByRole('region', { name: 'dev' })).getByRole('button', { name: 'Edit member settings' })).toBeTruthy();
  });

  it('opens the existing removal confirmation with focus on Cancel', async () => {
    await renderScreen();
    await openMenu();
    fireEvent.click(menuItem('Remove member…'));
    await flush();
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove dev?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel removing dev' }));
  });

  it('navigates to the member role in Roles', async () => {
    const onViewRole = vi.fn();
    await renderScreen({ onViewRole });
    await openMenu();
    fireEvent.click(menuItem('View role in Roles'));
    await flush();
    expect(onViewRole).toHaveBeenCalledWith('Developer');
  });

  it('copies and announces the requested ids', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      await renderScreen();
      await openMenu();
      await openSubmenu('Copy');
      fireEvent.click(menuItem('Ticket key'));
      await flush();
      expect(writeText).toHaveBeenCalledWith('T-091');
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied Ticket key'));
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    }
  });
});

describe('member row actions global lock', () => {
  it('disables mutating items while a write is pending but keeps the trigger usable', async () => {
    const pending = deferred<{ ok: true; data: { workflowRunId: string; assignmentId: string; action: 'retry'; status: 'retried' } }>();
    const retryRun = vi.fn(() => pending.promise);
    await renderScreen({ calls: { retryRun } });
    await openMenu();
    await openSubmenu('Current work');
    fireEvent.click(menuItem('Retry stage'));
    await flush();
    expect((actionsButton('dev')).disabled).toBe(false);
    await openMenu();
    expect(menuItem('Open details').getAttribute('aria-disabled')).toBeNull();
    const disabled = menuItem('Edit configuration…');
    expect(disabled.getAttribute('aria-disabled')).toBe('true');
    const ids = (disabled.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    expect(ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ')).toContain('Another change is in progress.');
    pending.resolve(ok({ workflowRunId: 'run-1', assignmentId: 'as-2', action: 'retry' as const, status: 'retried' as const }));
    await flush();
  });

  it('disables the actions trigger when the app is disconnected', async () => {
    await renderScreen({ connection: connectionFixture('lost') });
    expect(actionsButton('dev').disabled).toBe(true);
    // The native context menu is not suppressed when this menu cannot open.
    expect(fireEvent.contextMenu(memberRow('dev'))).toBe(true);
    await flush();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('disables the actions trigger and keeps the native menu while the overview is stale', async () => {
    const gate = deferred<{ ok: true; data: ReturnType<typeof overviewFixture> }>();
    const fake = fakeManagement({
      overview: [ok(overviewFixture([fixture()])), gate.promise],
      boardSettings: [ok(routingSettingsFixture())],
    });
    render(<TeamsHarness workspace={workspaceA} management={fake.api} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await flush();
    expect(screen.getByText('Team data is stale — showing previously loaded data.')).toBeTruthy();
    // read-only (stale) data: the trigger is disabled and the row keeps the
    // browser's own context menu because this menu cannot open.
    expect(actionsButton('dev').disabled).toBe(true);
    expect(fireEvent.contextMenu(memberRow('dev'))).toBe(true);
    await flush();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('returns focus to the actions button after a dialog closes', async () => {
    await renderScreen();
    await openMenu();
    await openSubmenu('Current work');
    fireEvent.click(menuItem('Requeue ticket…'));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await flush();
    expect(document.activeElement).toBe(actionsButton('dev'));
  });
});
