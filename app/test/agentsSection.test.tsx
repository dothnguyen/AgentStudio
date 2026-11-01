// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OverviewMember, OverviewTeam, ResolvedAgentOption } from '../src/renderer/api';
import { TeamsHarness } from './teamsHarness';
import { workspaceA } from './dashboardFixtures';
import { fakeManagement, member, openMember, overviewFixture, team } from './teamsFixtures';
import { AGENT_DIFFERS_NOTE, INLINE_AGENT_EXPLANATION, NO_RUNTIME_NOTE } from '../src/renderer/teams/agentOptionsModel';

afterEach(cleanup);

const ok = <T,>(data: T) => ({ ok: true as const, data });
const flush = () => act(async () => {});

const opencode: ResolvedAgentOption = { id: 'opencode-sonnet', name: 'OpenCode Sonnet', provider: 'opencode', model: 'claude-sonnet', reasoning: 'low', description: null, state: 'ok' };
const codex: ResolvedAgentOption = { id: 'codex-gpt', name: 'Codex GPT', provider: 'codex', model: 'gpt-6', reasoning: null, description: null, state: 'ok' };

function liveRuntime(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'agent-lead', availability: 'idle', paneState: 'alive', provider: 'opencode', model: 'claude-sonnet',
    reasoning: null, stale: false, configuredAgents: ['opencode-sonnet', 'codex-gpt'], activeAgent: 'opencode-sonnet',
    quotaHolds: {}, pendingAgent: null, lastSwitch: null, assignment: null,
    ...overrides,
  };
}

function catalogMember(overrides: Partial<OverviewMember> = {}): OverviewMember {
  return member({
    memberId: 'dev', name: 'dev', role: 'Developer',
    agentMode: 'ordered_catalog', agentOptions: [opencode, codex], defaultAgent: 'opencode-sonnet',
    runtime: liveRuntime() as never,
    presence: 'idle', work: { state: 'none' },
    ...overrides,
  });
}

function runningOverview(m: OverviewMember, runtime = { state: 'running', teamId: 't-1', status: 'running' }): OverviewTeam {
  return overviewFixture([team({ runtime: runtime as never, members: [m] })]);
}

async function mount(data: OverviewTeam, calls: Parameters<typeof fakeManagement>[0]['calls'] = {}, onOpenAgents?: () => void) {
  const fake = fakeManagement({ overview: [ok(data)], calls });
  render(<TeamsHarness workspace={workspaceA} management={fake.api} onOpenAgents={onOpenAgents} />);
  await flush();
  return { fake };
}

async function open(name = 'dev'): Promise<HTMLElement> {
  const detail = openMember(name);
  await flush();
  return detail;
}

function agentsCard(detail: HTMLElement): HTMLElement {
  return within(detail).getByRole('region', { name: 'Agents' });
}

describe('Agents card', () => {
  it('shows the live rows with Default and Live tags and the saved meta lines', async () => {
    await mount(runningOverview(catalogMember({ runtime: liveRuntime({ activeAgent: 'codex-gpt', provider: 'codex', model: 'gpt-6' }) as never })));
    const card = agentsCard(await open());
    expect(within(card).getByRole('heading', { name: 'Agents', level: 2 })).toBeTruthy();
    expect(card.textContent).toContain('The agent working as dev now, and the options offered at team start.');
    expect(within(card).getByRole('button', { name: 'Edit agent options' })).toBeTruthy();
    const rows = within(card).getAllByRole('listitem');
    expect(rows).toHaveLength(2);

    expect(rows[0]!.querySelector('.teams-agent-mark')!.textContent).toBe('OP');
    expect(rows[0]!.querySelector('.teams-agent-name')!.textContent).toContain('OpenCode Sonnet');
    expect(rows[0]!.querySelector('.teams-agent-tag.is-default')!.textContent).toBe('Default');
    expect(rows[0]!.querySelector('.teams-agent-tag.is-live')).toBeNull();
    expect(rows[0]!.querySelector('.teams-agent-meta')!.textContent).toBe('opencode · claude-sonnet · Reasoning: low');
    expect(within(rows[0]!).getByRole('button', { name: 'Switch live agent to OpenCode Sonnet' })).toBeTruthy();

    expect(rows[1]!.querySelector('.teams-agent-tag.is-default')).toBeNull();
    expect(rows[1]!.querySelector('.teams-agent-tag.is-live')!.textContent).toBe('Live');
    expect(rows[1]!.textContent).toContain('Active');
    expect(rows[1]!.querySelector('.teams-agent-meta')!.textContent).toBe('codex · gpt-6');
    expect(within(rows[1]!).queryByRole('button')).toBeNull();
    expect(rows[1]!.className).toContain('is-active');
  });

  it('marks the Default tag by saved order, not by the runtime list order', async () => {
    // The runtime lists Codex first, but the saved options still start with
    // OpenCode Sonnet, so OpenCode Sonnet keeps the Default tag.
    const runtime = liveRuntime({ configuredAgents: ['codex-gpt', 'opencode-sonnet'], activeAgent: 'opencode-sonnet' });
    await mount(runningOverview(catalogMember({ runtime: runtime as never })));
    const card = agentsCard(await open());
    const rows = within(card).getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain('Codex GPT');
    expect(rows[1]!.textContent).toContain('OpenCode Sonnet');
    const codexRow = rows[0]!;
    const opencodeRow = rows[1]!;
    expect(codexRow.querySelector('.teams-agent-tag.is-default')).toBeNull();
    expect(opencodeRow.querySelector('.teams-agent-tag.is-default')!.textContent).toBe('Default');
    expect(opencodeRow.querySelector('.teams-agent-tag.is-live')!.textContent).toBe('Live');
    expect(within(codexRow).getByRole('button', { name: 'Switch live agent to Codex GPT' })).toBeTruthy();
  });

  it('renders the live rows inside an ordered list', async () => {
    await mount(runningOverview(catalogMember()));
    const card = agentsCard(await open());
    const list = within(card).getByRole('list');
    expect(list.tagName).toBe('OL');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.closest('ol')).toBe(list);
    // The live agent here is the saved default, so the amber note is absent.
    expect(card.textContent).not.toContain(AGENT_DIFFERS_NOTE);
  });

  it('shows the existing Requesting status while a switch is in flight', async () => {
    const switchMemberAgent = vi.fn(() => new Promise(() => {}));
    await mount(runningOverview(catalogMember()), { switchMemberAgent });
    const card = agentsCard(await open());
    fireEvent.click(within(card).getByRole('button', { name: 'Switch live agent to Codex GPT' }));
    await flush();
    expect(within(card).getByText('Requesting…')).toBeTruthy();
  });

  it('shows the saved options read-only when the runtime has no switch options', async () => {
    const unknown = liveRuntime({ configuredAgents: null, quotaHolds: {}, activeAgent: 'opencode-sonnet' });
    await mount(runningOverview(catalogMember({ runtime: unknown as never })));
    const card = agentsCard(await open());
    const list = within(card).getByRole('list', { name: 'Saved agent options' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getAllByRole('listitem')[0]!.querySelector('.teams-agent-tag.is-default')!.textContent).toBe('Default');
    expect(within(card).queryByRole('button', { name: /Switch/ })).toBeNull();
    expect(card.textContent).toContain('Live agent eligibility is unavailable; switching is disabled. Recorded quota holds can still be resumed.');
  });

  it('marks a missing catalog agent and disables its Switch with the reason', async () => {
    const gone: ResolvedAgentOption = { id: 'gone', name: 'Gone Agent', provider: null, model: null, reasoning: null, description: null, state: 'missing' };
    await mount(runningOverview(catalogMember({
      agentOptions: [opencode, gone],
      runtime: liveRuntime({ configuredAgents: ['opencode-sonnet', 'gone'] }) as never,
    })));
    const card = agentsCard(await open());
    const row = within(card).getAllByRole('listitem').find(li => li.textContent!.includes('Gone Agent'))!;
    expect(row.querySelector('.teams-agent-tag.is-missing')!.textContent).toBe('Missing from catalog');
    const button = within(row).getByRole('button', { name: 'Switch live agent to Gone Agent' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(row.textContent).toContain("Agent 'gone' is missing from the catalog.");
  });

  it('switches an agent through the existing confirmation flow', async () => {
    const switchMemberAgent = vi.fn().mockResolvedValue({
      ok: false as const,
      error: { code: 'BAD_REQUEST', message: 'Member has an active assignment; confirm cancellation of this assignment to switch.', retryable: false, data: { assignmentId: 'assignment-A' } },
    });
    await mount(runningOverview(catalogMember({ runtime: liveRuntime({ activeAgent: 'codex-gpt' }) as never })), { switchMemberAgent });
    const card = agentsCard(await open());
    fireEvent.click(within(card).getByRole('button', { name: 'Switch live agent to OpenCode Sonnet' }));
    await flush();
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('OpenCode Sonnet');
    expect(dialog.textContent).toContain('assignment-A');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm cancellation' }));
    await flush();
    expect(switchMemberAgent).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'opencode-sonnet', { cancelActive: true, assignmentId: 'assignment-A' });
  });

  it('resumes a held agent through the existing resume flow', async () => {
    const resumeMemberAgent = vi.fn().mockResolvedValue(ok({ teamId: 't-1', memberId: 'dev', agentId: 'agent-lead', option: 'codex-gpt', cleared: true, activeAgent: 'opencode-sonnet' }));
    await mount(runningOverview(catalogMember({ runtime: liveRuntime({ quotaHolds: { 'codex-gpt': '2026-01-01T01:00:00Z' } }) as never })), { resumeMemberAgent });
    const card = agentsCard(await open());
    const row = within(card).getAllByRole('listitem')[1]!;
    expect(row.textContent).toContain('Resets at 2026-01-01 01:00 UTC');
    expect((within(row).getByRole('button', { name: 'Switch live agent to Codex GPT' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(row).getByRole('button', { name: 'Resume agent Codex GPT' }));
    await flush();
    expect(resumeMemberAgent).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', 'codex-gpt');
  });

  it('keeps disabled Switch buttons and shows the reason next to the row', async () => {
    await mount(runningOverview(catalogMember(), { state: 'stopped', teamId: 't-1', status: 'stopped' }));
    const card = agentsCard(await open());
    const button = within(card).getByRole('button', { name: 'Switch live agent to Codex GPT' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(within(card).getAllByText('The team is not running.').length).toBeGreaterThan(0);
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)!.textContent).toBe('The team is not running.');
  });

  it('shows the amber note only when the live agent differs from the saved default', async () => {
    await mount(runningOverview(catalogMember({ runtime: liveRuntime({ activeAgent: 'codex-gpt' }) as never })));
    expect(agentsCard(await open()).textContent).toContain(AGENT_DIFFERS_NOTE);
    cleanup();

    await mount(runningOverview(catalogMember()));
    expect(agentsCard(await open()).textContent).not.toContain(AGENT_DIFFERS_NOTE);
  });

  it('shows the saved options read-only when the member has no runtime record', async () => {
    const m = catalogMember({ runtime: null, presence: 'not_started', work: { state: 'unavailable', reason: 'not_started' } });
    await mount(overviewFixture([team({ members: [m] })]));
    const card = agentsCard(await open());
    const list = within(card).getByRole('list', { name: 'Saved agent options' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('.teams-agent-tag.is-default')!.textContent).toBe('Default');
    expect(rows[0]!.textContent).toContain('OpenCode Sonnet');
    expect(rows[1]!.textContent).toContain('Codex GPT');
    expect(within(card).queryByRole('button', { name: /Switch/ })).toBeNull();
    expect(card.textContent).toContain(NO_RUNTIME_NOTE);
    expect(within(card).getByRole('button', { name: 'Edit agent options' })).toBeTruthy();
  });

  it('shows the single inline agent and the inline explanation', async () => {
    const inline = member({
      memberId: 'lead', name: 'Inline Lead', role: 'TeamLead', source: 'inline', agentMode: 'inline',
      agentOptions: [], defaultAgent: null, agentDefId: null, agentDefState: null,
      provider: 'codex', model: null, reasoning: null, runtime: null,
    });
    await mount(overviewFixture([team({ members: [inline] })]));
    const card = agentsCard(await open('Inline Lead'));
    expect(card.textContent).toContain('Inline agent');
    expect(card.textContent).toContain('codex · model not set');
    expect(card.textContent).toContain(INLINE_AGENT_EXPLANATION);
    expect(card.textContent).not.toContain(AGENT_DIFFERS_NOTE);
    expect(within(card).queryByRole('button', { name: /Switch/ })).toBeNull();
    expect(within(card).getAllByRole('listitem')).toHaveLength(1);
  });
});
