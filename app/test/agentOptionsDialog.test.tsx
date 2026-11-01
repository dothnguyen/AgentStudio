// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OverviewMember, OverviewTeam, ResolvedAgentOption } from '../src/renderer/api';
import { TeamsHarness } from './teamsHarness';
import { workspaceA } from './dashboardFixtures';
import { fakeManagement, member, openMember, overviewFixture, team } from './teamsFixtures';
import { AGENT_OPTIONS_INTRO, INLINE_AGENT_EXPLANATION } from '../src/renderer/teams/agentOptionsModel';

afterEach(cleanup);

const ok = <T,>(data: T) => ({ ok: true as const, data });
const flush = () => act(async () => {});
const savedResult = () => ok({
  team: { id: 'dev-team', name: 'Dev Team', members: [] },
  member: { id: 'dev', name: 'dev', role: 'Developer' },
  appliesOnNextStart: true,
  problems: [],
});

const opencode: ResolvedAgentOption = { id: 'opencode-sonnet', name: 'OpenCode Sonnet', provider: 'opencode', model: 'claude-sonnet', reasoning: 'low', description: null, state: 'ok' };
const codex: ResolvedAgentOption = { id: 'codex-gpt', name: 'Codex GPT', provider: 'codex', model: 'gpt-6', reasoning: null, description: null, state: 'ok' };
const gone: ResolvedAgentOption = { id: 'gone', name: 'Gone Agent', provider: null, model: null, reasoning: null, description: null, state: 'missing' };
const spare: ResolvedAgentOption = { id: 'spare', name: 'Spare Agent', provider: 'claude', model: null, reasoning: null, description: null, state: 'ok' };

function liveRuntime(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'agent-lead', availability: 'idle', paneState: 'alive', provider: 'opencode', model: 'claude-sonnet',
    reasoning: null, stale: false, configuredAgents: ['opencode-sonnet', 'codex-gpt'], activeAgent: 'opencode-sonnet',
    quotaHolds: {}, pendingAgent: null, lastSwitch: null, assignment: null,
    ...overrides,
  };
}

function catalogMember(options: ResolvedAgentOption[] = [opencode, codex], overrides: Partial<OverviewMember> = {}): OverviewMember {
  return member({
    memberId: 'dev', name: 'dev', role: 'Developer',
    agentMode: 'ordered_catalog', agentOptions: options, defaultAgent: options[0]?.id ?? null,
    runtime: liveRuntime() as never,
    presence: 'idle', work: { state: 'none' },
    ...overrides,
  });
}

function overview(m: OverviewMember): OverviewTeam {
  return overviewFixture([team({ runtime: { state: 'running', teamId: 't-1', status: 'running' }, members: [m] })]);
}

async function mount(data: OverviewTeam, calls: Parameters<typeof fakeManagement>[0]['calls'] = {}, onOpenAgents?: () => void) {
  const fake = fakeManagement({ overview: [ok(data)], calls });
  const user = userEvent.setup();
  render(<TeamsHarness workspace={workspaceA} management={fake.api} onOpenAgents={onOpenAgents} />);
  await flush();
  return { fake, user };
}

function detailFor(name = 'dev'): HTMLElement {
  return openMember(name);
}

async function openDialog(user: ReturnType<typeof userEvent.setup>, name = 'dev'): Promise<HTMLElement> {
  const detail = detailFor(name);
  await flush();
  await user.click(within(detail).getByRole('button', { name: 'Edit agent options' }));
  return screen.getByRole('dialog', { name: 'Edit agent options' });
}

function optionsList(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('list', { name: 'Agent options' });
}

function ids(dialog: HTMLElement): (string | null)[] {
  return within(optionsList(dialog)).queryAllByRole('listitem').map(row => row.getAttribute('data-agent-id'));
}

describe('Edit agent options dialog', () => {
  it('opens at 600px with the intro, Default tag and footer note', async () => {
    const { user } = await mount(overview(catalogMember()));
    const dialog = await openDialog(user);
    expect(dialog.getAttribute('style')).toContain('width: min(600px, 100%)');
    expect(within(dialog).getByText(AGENT_OPTIONS_INTRO)).toBeTruthy();
    expect(within(dialog).getByText('Applies on next team start')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(ids(dialog)).toEqual(['opencode-sonnet', 'codex-gpt']);
    const rows = within(optionsList(dialog)).getAllByRole('listitem');
    expect(rows[0]!.querySelector('.member-agent-options-position')!.textContent).toBe('1');
    expect(rows[1]!.querySelector('.member-agent-options-position')!.textContent).toBe('2');
    expect(rows[0]!.querySelector('.member-agent-options-mark')!.textContent).toBe('OP');
    expect(rows[1]!.querySelector('.member-agent-options-mark')!.textContent).toBe('CO');
    expect(rows[0]!.querySelector('.member-agent-options-tag.is-default')!.textContent).toBe('Default');
    expect(rows[1]!.querySelector('.member-agent-options-tag.is-default')).toBeNull();
    expect(rows[0]!.textContent).toContain('OpenCode Sonnet');
    expect(rows[0]!.textContent).toContain('opencode · claude-sonnet · Reasoning: low');
    expect(within(rows[0]!).getByRole('button', { name: 'Move OpenCode Sonnet up' })).toHaveProperty('disabled', true);
    expect(within(rows[1]!).getByRole('button', { name: 'Move Codex GPT down' })).toHaveProperty('disabled', true);
  });

  it('reorders, announces the move, keeps focus in the row and saves only the agent list', async () => {
    const updateMember = vi.fn().mockResolvedValue(savedResult());
    const { user } = await mount(overview(catalogMember()), { updateMember });
    const dialog = await openDialog(user);
    const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: 'Move Codex GPT up' }));
    expect(ids(dialog)).toEqual(['codex-gpt', 'opencode-sonnet']);
    expect(within(dialog).getByText('Codex GPT moved to position 1')).toBeTruthy();
    const rows = within(optionsList(dialog)).getAllByRole('listitem');
    expect(rows[0]!.querySelector('.member-agent-options-position')!.textContent).toBe('1');
    expect(rows[1]!.querySelector('.member-agent-options-position')!.textContent).toBe('2');
    expect(rows[0]!.querySelector('.member-agent-options-tag.is-default')!.textContent).toBe('Default');
    expect(document.activeElement).toBe(within(rows[0]!).getByRole('button', { name: 'Move Codex GPT down' }));
    expect(save.disabled).toBe(false);

    await user.click(save);
    await flush();
    expect(updateMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', { agents: ['codex-gpt', 'opencode-sonnet'] });
    expect(screen.queryByRole('dialog', { name: 'Edit agent options' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit agent options' }));
    expect(screen.getByText(/^Saved dev\./)).toBeTruthy();
  });

  it('removes an option, moves focus to the next row control and saves the remaining option', async () => {
    const updateMember = vi.fn().mockResolvedValue(savedResult());
    const { user } = await mount(overview(catalogMember()), { updateMember });
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Remove Codex GPT' }));
    expect(ids(dialog)).toEqual(['opencode-sonnet']);
    expect(within(dialog).getByText('Removed Codex GPT.')).toBeTruthy();
    // The removed row is gone and the remaining single row has no enabled
    // reorder/remove control, so focus lands on the next actionable control.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: /^Add Codex GPT/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await flush();
    expect(updateMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', { agents: ['opencode-sonnet'] });
  });

  it('cannot remove the only option', async () => {
    const { user } = await mount(overview(catalogMember([opencode])));
    const dialog = await openDialog(user);
    const row = within(optionsList(dialog)).getAllByRole('listitem')[0]!;
    expect(within(row).getByRole('button', { name: 'Remove OpenCode Sonnet' })).toHaveProperty('disabled', true);
    expect(within(row).getByRole('button', { name: 'Move OpenCode Sonnet up' })).toHaveProperty('disabled', true);
    expect(within(row).getByRole('button', { name: 'Move OpenCode Sonnet down' })).toHaveProperty('disabled', true);
  });

  it('adds a catalog agent below the list and saves it', async () => {
    const updateMember = vi.fn().mockResolvedValue(savedResult());
    const { user } = await mount(overview(catalogMember([opencode])), { updateMember });
    const dialog = await openDialog(user);
    const add = within(dialog).getByRole('button', { name: /^Add Codex GPT/ });
    expect(add.textContent).toContain('codex · gpt-6');
    await user.click(add);
    expect(ids(dialog)).toEqual(['opencode-sonnet', 'codex-gpt']);
    expect(within(dialog).getByText('Added Codex GPT.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await flush();
    expect(updateMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', { agents: ['opencode-sonnet', 'codex-gpt'] });
  });

  it('blocks Save while an option is missing from the catalog until it is removed', async () => {
    const { user } = await mount(overview(catalogMember([opencode, gone])));
    const dialog = await openDialog(user);
    const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(within(dialog).getByText('Missing from catalog')).toBeTruthy();
    expect(within(dialog).getByText('Remove or replace missing catalog agents before saving.')).toBeTruthy();
    expect(optionsList(dialog).getAttribute('aria-describedby')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Remove Gone Agent' }));
    expect(save.disabled).toBe(false);
  });

  it('disables Save again when a reorder is undone', async () => {
    const { user } = await mount(overview(catalogMember()));
    const dialog = await openDialog(user);
    const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Move OpenCode Sonnet down' }));
    expect(save.disabled).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Move OpenCode Sonnet up' }));
    expect(ids(dialog)).toEqual(['opencode-sonnet', 'codex-gpt']);
    expect(save.disabled).toBe(true);
  });

  it('keeps the dialog open and focuses the error when saving fails', async () => {
    const updateMember = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'members[0].agents[1] is unknown', retryable: false, data: { problems: [{ path: 'members[0].agents[1]', message: 'unknown agent' }] } },
    });
    const { user } = await mount(overview(catalogMember()), { updateMember });
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Move Codex GPT up' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await flush();
    expect(screen.getByRole('dialog', { name: 'Edit agent options' })).toBeTruthy();
    const error = dialog.querySelector<HTMLElement>('.member-agent-options-error')!;
    expect(error.textContent).toContain('Member was not saved.');
    expect(error.textContent).toContain('BAD_REQUEST');
    expect(error.textContent).toContain('members[0].agents[1]: unknown agent');
    expect(document.activeElement).toBe(error);
    // The edited draft is kept so the user can correct it and retry.
    expect(ids(dialog)).toEqual(['codex-gpt', 'opencode-sonnet']);
    // The dialog owns the failure; the page feedback line does not repeat it.
    expect(screen.getAllByText('Member was not saved.')).toHaveLength(1);
  });

  it('stays open and busy while the save is in flight', async () => {
    const updateMember = vi.fn(() => new Promise(() => {}));
    const { user } = await mount(overview(catalogMember()), { updateMember });
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Move Codex GPT up' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(updateMember).toHaveBeenCalledTimes(1);
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
    // Busy dialogs ignore Escape; the write result decides what happens next.
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Edit agent options' })).toBeTruthy();
  });

  it('shows the inline agent and switches to the catalog list', async () => {
    const updateMember = vi.fn().mockResolvedValue(savedResult());
    const inline = member({
      memberId: 'dev', name: 'dev', role: 'Developer', source: 'inline', agentMode: 'inline',
      agentOptions: [], defaultAgent: null, agentDefId: null, agentDefState: null,
      provider: 'codex', model: null, reasoning: null, runtime: null, work: { state: 'unavailable', reason: 'not_started' },
    });
    const { user } = await mount(overviewFixture([team({ members: [inline] })]), { updateMember });
    const dialog = await openDialog(user);
    const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(within(dialog).getByText('Inline agent')).toBeTruthy();
    expect(within(dialog).getByText('codex · model not set')).toBeTruthy();
    expect(within(dialog).getByText(INLINE_AGENT_EXPLANATION)).toBeTruthy();
    expect(save.disabled).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: 'Use catalog agents' }));
    expect(ids(dialog)).toEqual([]);
    expect(within(dialog).getByText('Choose at least one agent.')).toBeTruthy();
    expect(save.disabled).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: /^Add OpenCode Sonnet/ }));
    await user.click(save);
    await flush();
    expect(updateMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', { agents: ['opencode-sonnet'] });
  });

  it('links to the Agents catalog', async () => {
    const onOpenAgents = vi.fn();
    const { user } = await mount(overview(catalogMember()), {}, onOpenAgents);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Manage Agents catalog' }));
    expect(onOpenAgents).toHaveBeenCalledTimes(1);
  });

  it('announces moves in an aria-live polite region', async () => {
    const { user } = await mount(overview(catalogMember()));
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Move Codex GPT up' }));
    const region = dialog.querySelector('.teams-visually-hidden[aria-live="polite"]');
    expect(region?.textContent).toBe('Codex GPT moved to position 1');
  });

  it('discards the draft on Cancel and returns focus to Edit options', async () => {
    const { user } = await mount(overview(catalogMember()));
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Move Codex GPT up' }));
    expect(ids(dialog)).toEqual(['codex-gpt', 'opencode-sonnet']);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit agent options' }));

    await user.click(screen.getByRole('button', { name: 'Edit agent options' }));
    const reopened = screen.getByRole('dialog', { name: 'Edit agent options' });
    expect(ids(reopened)).toEqual(['opencode-sonnet', 'codex-gpt']);
    expect((within(reopened).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('moves focus to the next row when the removed row disappears', async () => {
    const { user } = await mount(overview(catalogMember([opencode, codex, spare])));
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Remove OpenCode Sonnet' }));
    expect(ids(dialog)).toEqual(['codex-gpt', 'spare']);
    // The first remaining option becomes the default.
    expect(within(optionsList(dialog)).getAllByRole('listitem')[0]!.querySelector('.member-agent-options-tag.is-default')!.textContent).toBe('Default');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Remove Codex GPT' }));
  });

  it('blocks Save when the agent catalog is unavailable', async () => {
    const fake = fakeManagement({
      overview: [ok(overview(catalogMember()))],
      agents: [{ ok: false, error: { code: 'CATALOG_DOWN', message: 'catalog unavailable', retryable: true } }],
    });
    const user = userEvent.setup();
    render(<TeamsHarness workspace={workspaceA} management={fake.api} />);
    await flush();
    const dialog = await openDialog(user);
    expect(within(dialog).getByText('Agent catalog unavailable; options cannot be saved.')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).queryByRole('button', { name: /^Add / })).toBeNull();
  });

  it('hides add buttons when every catalog agent is already an option', async () => {
    const { user } = await mount(overview(catalogMember([opencode, codex, spare])));
    const dialog = await openDialog(user);
    expect(within(dialog).queryByRole('button', { name: /^Add / })).toBeNull();
    expect(within(dialog).getByText('All catalog agents are already options.')).toBeTruthy();
  });
});
