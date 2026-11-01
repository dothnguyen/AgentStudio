// @vitest-environment jsdom
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { TeamsCaptureApp, isFixtureScreenReady, openFixtureTeam } from '../capture/TeamsCaptureApp';
import {
  CAPTURE_READ_ONLY,
  CLAUDE_AGENT_ID,
  CODEX_AGENT_ID,
  TEAMS_V4_MEMBER_IDS,
  TEAMS_V4_RUNTIME_ID,
  TEAMS_V4_TEAM_NAME,
  TEAMS_V4_WORKSPACE,
  createTeamsOverviewV4Apis,
  teamsOverviewV4BoardSettings,
  teamsOverviewV4Catalog,
  teamsOverviewV4Overview,
  teamsOverviewV4Roles,
  teamsOverviewV4TeamDetail,
} from '../capture/teamsOverviewV4Fixture';

const appDir = path.join(__dirname, '..');
const read = (relativePath: string) => fs.readFileSync(path.join(appDir, relativePath), 'utf8');

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.captureReady;
  delete document.documentElement.dataset.captureError;
});

async function renderCapture(): Promise<HTMLElement> {
  render(<TeamsCaptureApp />);
  await waitFor(() => expect(document.documentElement.dataset.captureReady).toBe('true'), { timeout: 3000 });
  const main = document.querySelector('main');
  expect(main).not.toBeNull();
  return main!;
}

describe('Teams v4 capture fixture', () => {
  it('fixture data matches the v4 sample', () => {
    const team = teamsOverviewV4Overview().teams[0]!;
    expect(team.members.map((member) => member.memberId)).toEqual([...TEAMS_V4_MEMBER_IDS]);
    expect(team.members.map((member) => member.role)).toEqual(['TeamLead', 'Developer', 'Developer', 'Developer', 'Reviewer', 'QA']);
    expect(TEAMS_V4_RUNTIME_ID.slice(0, 8) + '…' + TEAMS_V4_RUNTIME_ID.slice(-8)).toBe('b4597175…f9548168');
    expect(teamsOverviewV4BoardSettings().runner.teamId).toBe(TEAMS_V4_RUNTIME_ID);
    expect(team.members.filter((member) => member.runtime !== null && member.runtime.activeAgent !== member.defaultAgent).map((member) => member.memberId))
      .toEqual(['lead']);
  });

  it('fixture catalog, roles, team detail and dashboard match the v4 sample', () => {
    const catalog = teamsOverviewV4Catalog();
    expect(catalog.workspace).toBe(TEAMS_V4_WORKSPACE.path);
    expect(catalog.agents.map((agent) => agent.id)).toEqual([CLAUDE_AGENT_ID, CODEX_AGENT_ID]);
    expect(catalog.agents.map((agent) => agent.name)).toEqual(['Claude Opus 5.5 medium', 'Codex 5.6 Sol medium']);
    expect(catalog.editorOptions.providers.map((provider) => provider.id)).toEqual(['claude', 'codex']);

    expect(teamsOverviewV4Roles().items.map((role) => role.name)).toEqual(['TeamLead', 'Developer', 'Reviewer', 'QA']);

    const detail = teamsOverviewV4TeamDetail();
    expect(detail.team.members.map((member) => member.id)).toEqual([...TEAMS_V4_MEMBER_IDS]);
    expect(detail.members[0]!.agents).toEqual([CLAUDE_AGENT_ID, CODEX_AGENT_ID]);
    expect(detail.members[1]).not.toHaveProperty('agents');
    expect(detail.active).toEqual({ teamId: TEAMS_V4_RUNTIME_ID, status: 'running' });

    const board = teamsOverviewV4BoardSettings();
    expect(board.runner.teamDefId).toBe('dev-team');
    expect(board.roles.items.map((role) => role.id)).toEqual(['TeamLead', 'Developer', 'Reviewer', 'QA']);
  });

  it('fixture calls return fresh objects so writes cannot leak between renders', () => {
    const firstOverview = teamsOverviewV4Overview();
    firstOverview.teams[0]!.members[0]!.name = 'changed';
    expect(teamsOverviewV4Overview().teams[0]!.members[0]!.name).toBe('lead');

    const firstCatalog = teamsOverviewV4Catalog();
    firstCatalog.agents[0]!.name = 'changed';
    expect(teamsOverviewV4Catalog().agents[0]!.name).toBe('Claude Opus 5.5 medium');

    const firstBoard = teamsOverviewV4BoardSettings();
    firstBoard.roles.items[0]!.description = 'changed';
    expect(teamsOverviewV4BoardSettings().roles.items[0]!.description).toBe('Plans and refines stories.');

    const firstRoles = teamsOverviewV4Roles();
    firstRoles.items[0]!.name = 'changed';
    expect(teamsOverviewV4Roles().items[0]!.name).toBe('TeamLead');

    const firstDetail = teamsOverviewV4TeamDetail();
    firstDetail.members[0]!.name = 'changed';
    expect(teamsOverviewV4TeamDetail().members[0]!.name).toBe('lead');

    const apis = createTeamsOverviewV4Apis();
    expect(apis.management).not.toBe(createTeamsOverviewV4Apis().management);
    expect(apis.dashboard).not.toBe(createTeamsOverviewV4Apis().dashboard);
  });

  it('capture app opens the fixture team in the real shell and marks ready', async () => {
    render(<TeamsCaptureApp />);
    await waitFor(() => expect(document.documentElement.dataset.captureReady).toBe('true'), { timeout: 3000 });

    const row = document.querySelector<HTMLButtonElement>('ul[aria-label="Workspace teams"] button');
    expect(row?.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(TEAMS_V4_TEAM_NAME);
  });

  it('renders the six member rows with live agents, Switched, status and work', async () => {
    render(<TeamsCaptureApp />);
    await waitFor(() => expect(document.documentElement.dataset.captureReady).toBe('true'), { timeout: 3000 });

    const rows = [...document.querySelectorAll<HTMLElement>('.teams-member-row:not(.teams-member-row-static)')];
    expect(rows.map((row) => row.querySelector('[data-member-row]')?.getAttribute('data-member-row'))).toEqual([...TEAMS_V4_MEMBER_IDS]);

    const lead = rows[0]!.textContent ?? '';
    expect(lead).toContain('Codex 5.6 Sol medium');
    expect(lead).toContain('Switched');
    expect(lead).toContain('codex · gpt-5.6-sol · medium');
    expect(lead).toContain('Available');
    expect(lead).toContain('Idle');

    for (const row of rows.slice(1)) {
      const text = row.textContent ?? '';
      expect(text).toContain('Claude Opus 5.5 medium');
      expect(text).toContain('claude · claude-opus-5-5 · medium');
      expect(text).toContain('Available');
      expect(text).toContain('Idle');
      expect(text).not.toContain('Switched');
    }
  });

  it('renders the header from the fixture', async () => {
    const main = await renderCapture();
    const text = main.textContent ?? '';
    expect(text).toContain('dev-team');
    expect(text).toContain('b4597175…f9548168');
    expect(text).toContain('Definition valid');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rename team' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More team actions' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: 'Teams' })).toBeNull();
  });

  it('renders the summary cards and running banner', async () => {
    const main = await renderCapture();
    const text = main.textContent ?? '';
    expect(text).toContain('Runtime');
    expect(text).toContain('Availability');
    expect(text).toContain('Board');
    expect(text).toContain('/ 6 available');
    expect(text).toContain('The team is running. Member edits apply on next start; stop the team to remove members or delete it.');
    expect(screen.getByRole('button', { name: /Stop board/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Run board/ })).toBeNull();
  });

  it('capture entry imports the same styles and fonts as the app', () => {
    const main = read('src/renderer/main.tsx');
    const capture = read('capture/teamsCapture.tsx');
    for (const match of main.matchAll(/^import ['"]([^'"]+)['"];$/gm)) {
      const specifier = match[1]!;
      const expected = specifier.startsWith('./') ? `../src/renderer/${specifier.slice(2)}` : specifier;
      expect(capture).toContain(`import '${expected}';`);
    }
  });

  it('capture writes are read-only', async () => {
    expect(await createTeamsOverviewV4Apis().management.stopBoard('agent-studio')).toEqual(CAPTURE_READ_ONLY);
  });

  it('every write method is read-only and every read answers with the fixture', async () => {
    const { management, dashboard } = createTeamsOverviewV4Apis();
    const writes = [
      'createAgent', 'updateAgent', 'deleteAgent', 'createTeam', 'renameTeam', 'deleteTeam',
      'addMember', 'updateMember', 'removeMember', 'updateBoardSettings', 'createRole', 'updateRole',
      'updateRoleInstructions', 'deleteRole', 'runBoard', 'switchMemberAgent', 'resumeMemberAgent', 'stopBoard',
      'resetUsage', 'retryRun', 'cancelRun', 'retryTicket', 'unblockTicket', 'approveCommand', 'rejectCommand',
      'cancelCommand',
    ];
    const api = management as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const name of writes) {
      await expect(api[name]!('agent-studio')).resolves.toEqual(CAPTURE_READ_ONLY);
    }

    await expect(management.overview('agent-studio')).resolves.toMatchObject({ ok: true, data: { workspace: TEAMS_V4_WORKSPACE.path } });
    await expect(management.agents('agent-studio')).resolves.toMatchObject({ ok: true, data: { version: 1 } });
    await expect(management.team('agent-studio', 'dev-team')).resolves.toMatchObject({ ok: true, data: { team: { id: 'dev-team' } } });
    await expect(management.validateTeam('agent-studio', 'dev-team')).resolves.toMatchObject({ ok: true, data: { ready: true } });
    await expect(management.boardSettings('agent-studio')).resolves.toMatchObject({ ok: true, data: { runner: { status: 'running' } } });
    await expect(management.roles('agent-studio')).resolves.toMatchObject({ ok: true, data: { state: 'ok' } });

    const teams = await dashboard.teams('agent-studio');
    expect(teams.ok).toBe(true);
    if (teams.ok) {
      expect(teams.data.teams[0]!.members).toBe(6);
      expect(teams.data.teams[0]!.runtime?.availability.idle).toBe(6);
    }
    await expect(dashboard.board('agent-studio')).resolves.toMatchObject({ ok: true, data: { currentPhase: { slug: 'phase-05' } } });
    await expect(dashboard.activity('agent-studio')).resolves.toMatchObject({ ok: true, data: { dbId: 'capture' } });
  });

  it('opens the fixture team only when the sidebar row is enabled and ready', () => {
    expect(openFixtureTeam(document.createElement('div'))).toBe(false);

    const list = document.createElement('ul');
    list.setAttribute('aria-label', 'Workspace teams');
    const row = document.createElement('button');
    let clicks = 0;
    row.addEventListener('click', () => { clicks += 1; });
    list.append(row);
    const root = document.createElement('div');
    root.append(list);

    expect(openFixtureTeam(root)).toBe(true);
    expect(clicks).toBe(1);

    row.disabled = true;
    expect(openFixtureTeam(root)).toBe(false);
    expect(clicks).toBe(1);
  });

  it('is ready only with the team heading and every fixture member row', () => {
    const root = document.implementation.createHTMLDocument('capture');
    for (const id of TEAMS_V4_MEMBER_IDS) {
      const row = root.createElement('div');
      row.setAttribute('data-member-row', id);
      root.body.append(row);
    }
    expect(isFixtureScreenReady(root)).toBe(false);

    const heading = root.createElement('h1');
    heading.id = 'teams-detail-title';
    heading.textContent = TEAMS_V4_TEAM_NAME;
    root.body.append(heading);
    expect(isFixtureScreenReady(root)).toBe(true);

    heading.textContent = 'Teams';
    expect(isFixtureScreenReady(root)).toBe(false);

    heading.textContent = TEAMS_V4_TEAM_NAME;
    root.querySelector('[data-member-row]')!.remove();
    expect(isFixtureScreenReady(root)).toBe(false);
  });
});
