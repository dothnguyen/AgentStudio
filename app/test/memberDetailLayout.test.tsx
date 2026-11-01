// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OverviewTeam } from '../src/renderer/api';
import { TeamsHarness } from './teamsHarness';
import { workspaceA } from './dashboardFixtures';
import { fakeManagement, member, openMember, overviewFixture, team } from './teamsFixtures';
import { MEMBER_DETAIL_TIMING_NOTE } from '../src/renderer/teams/teamEditModel';

afterEach(cleanup);

const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8').replace(/\s+/g, ' ');

const ok = <T,>(data: T) => ({ ok: true as const, data });

function liveRuntime(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'agent-lead', availability: 'idle', paneState: 'alive', provider: 'opencode', model: 'claude-sonnet',
    reasoning: null, stale: false, configuredAgents: ['opencode-sonnet', 'codex-gpt'], activeAgent: 'opencode-sonnet',
    quotaHolds: {}, pendingAgent: null, lastSwitch: null, assignment: { id: 'as-1', status: 'working', taskId: 'T-9' },
    ...overrides,
  };
}

function runningOverview(overrides: Parameters<typeof member>[0] = {}): OverviewTeam {
  return overviewFixture([team({
    runtime: { state: 'running', teamId: 't-1', status: 'running' },
    members: [member({ memberId: 'lead', name: 'Lead Developer', role: 'TeamLead', presence: 'idle', runtime: liveRuntime() as never, ...overrides })],
  })]);
}

async function mount(data: OverviewTeam, calls: Parameters<typeof fakeManagement>[0]['calls'] = {}) {
  const fake = fakeManagement({ overview: [ok(data)], calls });
  const view = render(<main><TeamsHarness workspace={workspaceA} management={fake.api} /></main>);
  await act(async () => {});
  return { fake, view };
}

async function open(name: string): Promise<HTMLElement> {
  const detail = openMember(name);
  await act(async () => {});
  return detail;
}

describe('member detail v7 layout', () => {
  it('renders the avatar, heading, role chip, availability pill and subline', async () => {
    await mount(runningOverview());
    const detail = await open('Lead Developer');
    expect(within(detail).getByRole('heading', { name: 'Lead Developer', level: 1 })).toBeTruthy();
    expect(detail.querySelector('.teams-member-hero-avatar')!.textContent).toBe('LD');
    expect(detail.querySelector('.teams-role-chip')!.textContent).toBe('TeamLead');
    expect(detail.querySelector('.teams-page-pill')!.textContent).toContain('Available');
    expect(detail.querySelector('.teams-member-subline')!.textContent).toBe('Member of Dev Team · id lead');
    expect(detail.querySelector('.teams-member-subline code.entity-id')!.textContent).toBe('lead');
    expect(within(detail).getByRole('button', { name: 'Back to members' })).toBeTruthy();
    expect(within(detail).getByRole('navigation', { name: 'Member location' }).textContent).toBe('Dev TeamMembersLead Developer');
  });

  it('shows the v7 notice row and omits the old timing note', async () => {
    await mount(runningOverview());
    const detail = await open('Lead Developer');
    const noticeNodes = Array.from(detail.querySelectorAll('.teams-member-notice'));
    const notices = noticeNodes.map(n => n.textContent);
    expect(notices[0]).toBe(MEMBER_DETAIL_TIMING_NOTE);
    expect(notices[0]).toBe('Name, role, permissions and agent options apply the next time the team starts. Switching the live agent and editing role instructions take effect on new work straight away.');
    expect(notices).toContain('This team is running. Stop it before deleting the team or removing members; other edits apply the next time it starts.');
    expect(detail.textContent).not.toContain('Changes to name, role, ticket permission, and saved agent options apply the next time the team starts.');
    expect(noticeNodes[0]!.querySelector('svg[data-icon="info"]')).not.toBeNull();
    expect(noticeNodes[0]!.querySelector('svg[data-icon="refresh"]')).toBeNull();
  });

  it('renders the existing extra notes as notice rows of the same style', async () => {
    await mount(runningOverview({ source: 'inline', agentMode: 'inline', agentOptions: [], defaultAgent: null, agentDefId: null, agentDefState: null }));
    const detail = await open('Lead Developer');
    const notices = Array.from(detail.querySelectorAll('.teams-member-notice'));
    const text = notices.map(n => n.textContent ?? '');
    expect(text).toContain(MEMBER_DETAIL_TIMING_NOTE);
    expect(text).toContain('Inline member');
    expect(text).toContain('This team is running. Stop it before deleting the team or removing members; other edits apply the next time it starts.');
    expect(notices.every(n => n.querySelector('svg[data-icon="info"]') !== null)).toBe(true);
  });

  it('renders the uneditable team note as a notice row', async () => {
    await mount(overviewFixture([team({
      definition: { state: 'unreadable', problems: [{ path: 'members', message: 'cannot read' }] } as never,
      members: [member({ memberId: 'lead', name: 'Lead Developer' })],
    })]));
    const detail = await open('Lead Developer');
    const notes = Array.from(detail.querySelectorAll('.teams-member-notice')).map(n => n.textContent);
    expect(notes).toContain("This team's definition could not be read; fix the file before editing it here.");
  });

  it('lays out a wrapping main column and a 320 to 400 px aside', () => {
    expect(css).toContain('.teams-member-detail { display: flex; flex-direction: column; gap: 22px; min-width: 0; max-width: 1120px; margin: 0 auto;');
    expect(css).toContain('.teams-member-main { flex: 999 1 560px; display: flex; flex-direction: column; gap: 22px; min-width: 0; }');
    expect(css).toContain('.teams-member-aside { flex: 1 1 320px; display: flex; flex-direction: column; gap: 22px; min-width: 0; max-width: 400px; }');
    expect(css).toContain('@media (max-width: 1240px) { .teams-member-layout { flex-direction: column; } .teams-member-main { width: 100%; flex: 1 1 auto; } .teams-member-aside { width: 100%; max-width: none; } }');
  });

  it('puts the Agents, Role instructions and status cards in their v7 columns', async () => {
    await mount(runningOverview());
    const detail = await open('Lead Developer');
    const layout = detail.querySelector('.teams-member-layout')!;
    const main = detail.querySelector('.teams-member-main')!;
    const aside = detail.querySelector('.teams-member-aside')!;
    expect(layout.children[0]).toBe(main);
    expect(layout.children[1]).toBe(aside);
    for (const card of ['Agents', 'Role instructions']) {
      expect(main.contains(within(detail).getByRole('region', { name: card }))).toBe(true);
    }
    expect(aside.contains(within(detail).getByRole('region', { name: 'Live status' }))).toBe(true);
    expect(aside.contains(within(detail).getByRole('region', { name: 'Member settings' }))).toBe(true);
    expect(aside.lastElementChild).toBe(within(detail).getByRole('region', { name: 'Remove member' }));
  });

  it('shows live status values from the shared member agent model', async () => {
    await mount(runningOverview());
    const detail = await open('Lead Developer');
    const status = within(detail).getByRole('region', { name: 'Live status' });
    expect(within(status).queryByRole('button')).toBeNull();
    expect(within(status).getByText('Availability')).toBeTruthy();
    expect(within(status).getByText('Available')).toBeTruthy();
    expect(within(status).getByText('as-1 · working · T-9')).toBeTruthy();
    expect(within(status).getByText('Running')).toBeTruthy();
    expect(within(status).getByText('opencode-sonnet · opencode · claude-sonnet')).toBeTruthy();
  });

  it('shows the model values for a busy member with no active assignment', async () => {
    await mount(runningOverview({
      presence: 'busy',
      runtime: liveRuntime({ availability: 'busy', assignment: null }) as never,
    }));
    const detail = await open('Lead Developer');
    const status = within(detail).getByRole('region', { name: 'Live status' });
    expect(within(status).getByText('busy')).toBeTruthy();
    expect(within(status).getByText('No active assignment')).toBeTruthy();
    expect(within(status).getByText('Running')).toBeTruthy();
    expect(detail.querySelector('.teams-member-title-row .teams-page-pill')!.textContent).toBe('Working');
  });

  it('shows the saved agent source as a notice row of the same style', async () => {
    await mount(runningOverview());
    const detail = await open('Lead Developer');
    const notices = Array.from(detail.querySelectorAll('.teams-member-notice'));
    const source = notices.find(n => n.textContent === 'Agent: opencode-sonnet');
    expect(source).toBeTruthy();
    expect(source!.querySelector('svg[data-icon="info"]')).not.toBeNull();
  });

  it('shows the stopped runtime state for a member that still has a runtime record', async () => {
    await mount(overviewFixture([team({
      runtime: { state: 'stopped', teamId: 't-old', status: 'stopped' },
      members: [member({
        memberId: 'lead', name: 'Lead Developer', presence: 'stopped',
        runtime: liveRuntime({ availability: 'idle', assignment: null }) as never,
      })],
    })]));
    const detail = await open('Lead Developer');
    const status = within(detail).getByRole('region', { name: 'Live status' });
    expect(within(status).getByText('Stopped')).toBeTruthy();
    expect(within(status).getByText('No active assignment')).toBeTruthy();
    expect(detail.querySelector('.teams-member-title-row .teams-page-pill')!.textContent).toBe('Stopped');
  });

  it('uses the existing sentence when the member has no runtime record', async () => {
    await mount(overviewFixture([team({ members: [member({ memberId: 'lead', name: 'Lead Developer', runtime: null })] })]));
    const detail = await open('Lead Developer');
    const status = within(detail).getByRole('region', { name: 'Live status' });
    expect(status.textContent).toContain('Live state is unavailable because this member has no running runtime record.');
    expect(status.querySelector('dl')).toBeNull();
    expect(detail.querySelector('.teams-member-title-row .teams-page-pill')).toBeNull();
  });

  it('confirms remove, closes on Escape and surfaces the backend refusal while running', async () => {
    const removeMember = vi.fn().mockResolvedValue({ ok: false, error: { code: 'TEAM_ALREADY_RUNNING', message: 'running', retryable: false } });
    const user = userEvent.setup();
    await mount(runningOverview(), { removeMember });
    const detail = await open('Lead Developer');
    const remove = within(detail).getByRole('button', { name: 'Remove Lead Developer' });
    const card = within(detail).getByRole('region', { name: 'Remove member' });
    expect(within(card).getByRole('heading', { name: 'Remove member', level: 2 })).toBeTruthy();
    expect(remove.textContent).toBe('Remove');
    expect(card.textContent).toContain('Stop the team before removing Lead Developer.');
    const status = within(detail).getByRole('region', { name: 'Live status' });
    expect(status.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(remove);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Remove Lead Developer?');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel removing Lead Developer' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(remove);
    await user.click(remove);
    await user.click(screen.getByRole('button', { name: 'Confirm remove Lead Developer' }));
    await act(async () => {});
    expect(removeMember).toHaveBeenCalledWith(workspaceA.id, 'dev-team', 'lead');
    expect(screen.getByRole('alert').textContent).toContain('Stop the team before deleting it or removing members.');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm remove Lead Developer' }));
  });

  it('hides the remove card for members that cannot be edited', async () => {
    await mount(overviewFixture([team({ members: [member({ memberId: 'rt', name: 'runtime-only', source: 'runtime', runtime: null, agentOptions: [] })] })]));
    const detail = await open('runtime-only');
    expect(within(detail).queryByRole('button', { name: 'Remove runtime-only' })).toBeNull();
  });

  it('saves and discards member settings through the single dialog', async () => {
    const updateMember = vi.fn().mockResolvedValue(ok({ team: { id: 'dev-team', name: 'Dev Team', members: [] }, member: { id: 'lead', name: 'Renamed', role: 'TeamLead' }, appliesOnNextStart: true, problems: [] }));
    const user = userEvent.setup();
    await mount(runningOverview(), { updateMember });
    const detail = await open('Lead Developer');
    expect(within(detail).getByRole('heading', { name: 'Member settings', level: 2 })).toBeTruthy();
    expect(within(detail).getByRole('heading', { name: 'Agents', level: 2 })).toBeTruthy();
    const edit = within(detail).getByRole('button', { name: 'Edit member settings' });

    await user.click(edit);
    const dialog = screen.getByRole('dialog', { name: 'Edit member settings' });
    await user.clear(within(dialog).getByLabelText('Display name'));
    await user.type(within(dialog).getByLabelText('Display name'), 'Renamed');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await act(async () => {});
    expect(updateMember).toHaveBeenCalledWith(workspaceA.id, 'dev-team', 'lead', { name: 'Renamed' });
    expect(document.activeElement).toBe(edit);

    await user.click(edit);
    const reopened = screen.getByRole('dialog', { name: 'Edit member settings' });
    await user.clear(within(reopened).getByLabelText('Display name'));
    await user.type(within(reopened).getByLabelText('Display name'), 'Discarded');
    await user.click(within(reopened).getByRole('button', { name: 'Cancel' }));
    expect(updateMember).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(edit);
  });

  it('shows the live agent switch inside the Agents card', async () => {
    await mount(runningOverview());
    const detail = await open('Lead Developer');
    const card = within(detail).getByRole('region', { name: 'Agents' });
    expect(within(card).getByRole('button', { name: 'Switch live agent to Codex GPT' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Edit agent options' })).toBeTruthy();
  });
});
