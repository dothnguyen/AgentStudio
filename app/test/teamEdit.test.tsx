// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamsScreen } from '../src/renderer/teams/TeamsScreen';
import { workspaceA } from './dashboardFixtures';
import {
  deferred,
  fakeManagement,
  member,
  overviewFixture,
  team,
  teamDefinition,
  twoTeams,
} from './teamsFixtures';

afterEach(cleanup);

async function renderScreen(opts: Parameters<typeof fakeManagement>[0] = {}) {
  const fake = fakeManagement(opts);
  const result = render(<TeamsScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  return { fake, result };
}

const flush = () => act(async () => {});
const click = async (name: string | RegExp) => {
  fireEvent.click(screen.getByRole('button', { name }));
  await flush();
};
const submitAddMember = async () => {
  fireEvent.click(within(screen.getByRole('form', { name: 'Add member' })).getByRole('button', { name: 'Add member' }));
  await flush();
};
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (error: { code: string; message: string; remediation?: string; data?: unknown }) =>
  ({ ok: false as const, error: { retryable: false, ...error } });
const cardPressed = (name: string) =>
  screen.getByRole('button', { name: new RegExp(`^${name}`) }).getAttribute('aria-pressed');

describe('team editing', () => {
  it('create_team_saves_and_selects_it', async () => {
    const createTeam = vi.fn(async () => ok({ team: teamDefinition({ id: 'qa-team', name: 'QA Team' }), problems: [] }));
    const after = overviewFixture([...twoTeams().teams, team({ id: 'qa-team', name: 'QA Team', members: [] })]);
    const { fake } = await renderScreen({
      overview: [ok(twoTeams()), ok(after)],
      calls: { createTeam },
    });
    await click('New team');
    expect(document.activeElement).toBe(screen.getByLabelText('Team name'));
    type('Team name', 'QA Team');
    await click('Create team');
    expect(createTeam).toHaveBeenCalledTimes(1);
    expect(createTeam).toHaveBeenCalledWith('ws-a', { name: 'QA Team' });
    expect(screen.getByRole('status').textContent).toContain('Created team "QA Team".');
    expect(cardPressed('QA Team')).toBe('true');
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(fake.agents).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('form', { name: 'New team' })).toBeNull();
  });

  it('rename_running_team_applies_on_next_start', async () => {
    const renameTeam = vi.fn(async () =>
      ok({ team: teamDefinition({ name: 'Core Team' }), problems: [], appliesOnNextStart: true }));
    await renderScreen({ calls: { renameTeam } });
    await click('Rename team');
    expect((screen.getByLabelText('Team name') as HTMLInputElement).value).toBe('Dev Team');
    type('Team name', 'Core Team');
    await click('Save name');
    expect(renameTeam).toHaveBeenCalledWith('ws-a', 'dev-team', 'Core Team');
    expect(screen.getByRole('status').textContent).toBe(
      'Renamed team to "Core Team". Changes apply the next time the team starts.',
    );
  });

  it('delete_team_needs_confirmation', async () => {
    const deleteTeam = vi.fn(async () => ok({ deleted: 'release' }));
    const { fake } = await renderScreen({ calls: { deleteTeam } });
    fireEvent.click(screen.getByRole('button', { name: /^Release Team/ }));
    await click('Delete team');
    expect(deleteTeam).not.toHaveBeenCalled();
    expect(screen.getByText('Delete team "Release Team"? Its definition file is removed.')).toBeTruthy();
    await click('Confirm delete');
    expect(deleteTeam).toHaveBeenCalledWith('ws-a', 'release');
    expect(screen.getByRole('status').textContent).toBe('Deleted team "Release Team".');
    expect(fake.overview).toHaveBeenCalledTimes(2);
  });

  it('add_member_with_catalog_agent', async () => {
    const addMember = vi.fn(async () => ok({
      team: teamDefinition(),
      member: { id: 'codex-gpt', name: 'Codex GPT', role: 'QA', agent: 'codex-gpt' },
      problems: [],
      appliesOnNextStart: true,
    }));
    await renderScreen({ calls: { addMember } });
    await click('Add member');
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'codex-gpt' } });
    type('Role', 'QA');
    await submitAddMember();
    expect(addMember).toHaveBeenCalledWith('ws-a', 'dev-team', { role: 'QA', agent: 'codex-gpt' });
    expect(screen.getByRole('status').textContent).toBe(
      'Added Codex GPT to Dev Team. Changes apply the next time the team starts.',
    );
  });

  it('edit_member_sends_only_changes', async () => {
    const updateMember = vi.fn(async () => ok({
      team: teamDefinition(),
      member: { id: 'dev', name: 'dev', role: 'Reviewer', agent: 'opencode-sonnet' },
      problems: [],
      appliesOnNextStart: false,
    }));
    await renderScreen({ calls: { updateMember } });
    await click('Edit dev');
    type('Role', 'Reviewer');
    await click('Save member');
    expect(updateMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', { role: 'Reviewer' });
    expect(screen.getByRole('status').textContent).toMatch(/^Saved dev\./);
  });

  it('edit_inline_member_switches_to_catalog_agent', async () => {
    const updateMember = vi.fn(async () => ok({
      team: teamDefinition(),
      member: { id: 'lead', name: 'lead', role: 'TeamLead', agent: 'spare' },
      problems: [],
      appliesOnNextStart: false,
    }));
    await renderScreen({ calls: { updateMember } });
    await click('Edit lead');
    const select = screen.getByLabelText('Agent') as HTMLSelectElement;
    expect(select.options[0]!.textContent).toBe('Keep inline provider (codex)');
    fireEvent.change(select, { target: { value: 'spare' } });
    await click('Save member');
    expect(updateMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'lead', { agent: 'spare' });
  });

  it('remove_member_after_confirmation', async () => {
    const removeMember = vi.fn(async () => ok({
      team: teamDefinition(),
      removed: { id: 'lead', name: 'lead', role: 'TeamLead' },
      problems: [],
    }));
    await renderScreen({ calls: { removeMember } });
    await click('Remove lead');
    expect(removeMember).not.toHaveBeenCalled();
    await click('Confirm remove lead');
    expect(removeMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'lead');
    expect(screen.getByRole('status').textContent).toBe('Removed lead from Dev Team.');
  });

  it('forms_are_keyboard_friendly', async () => {
    const createTeam = vi.fn(async () => ok({ team: teamDefinition({ id: 'x', name: 'X' }), problems: [] }));
    await renderScreen({ calls: { createTeam } });
    await click('New team');
    const form = screen.getByRole('form', { name: 'New team' });
    expect(form.tagName).toBe('FORM');
    type('Team name', 'X');
    fireEvent.submit(form);
    await flush();
    expect(createTeam).toHaveBeenCalledTimes(1);
    await click('New team');
    fireEvent.keyDown(screen.getByRole('form', { name: 'New team' }), { key: 'Escape' });
    expect(screen.queryByRole('form', { name: 'New team' })).toBeNull();
    expect(createTeam).toHaveBeenCalledTimes(1);
  });

  it('blank_inputs_are_not_sent', async () => {
    const createTeam = vi.fn();
    const addMember = vi.fn();
    const updateMember = vi.fn();
    await renderScreen({ calls: { createTeam, addMember, updateMember } });
    await click('New team');
    type('Team name', '   ');
    await click('Create team');
    expect(screen.getByText('Enter a team name.')).toBeTruthy();
    await click('Cancel');
    await click('Add member');
    await submitAddMember();
    expect(screen.getByText('Choose an agent.')).toBeTruthy();
    expect(screen.getByText('Enter a role.')).toBeTruthy();
    await click('Cancel');
    await click('Edit dev');
    await click('Save member');
    expect(screen.getByRole('alert').textContent).toBe('No changes to save.');
    expect(createTeam).not.toHaveBeenCalled();
    expect(addMember).not.toHaveBeenCalled();
    expect(updateMember).not.toHaveBeenCalled();
  });

  it('duplicate_team_name_shows_backend_error', async () => {
    const createTeam = vi.fn(async () => fail({ code: 'TEAM_EXISTS', message: "Team 'dev-team' already exists." }));
    const { fake } = await renderScreen({ calls: { createTeam } });
    await click('New team');
    type('Team name', 'Dev Team');
    await click('Create team');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Team was not created.');
    expect(alert.textContent).toContain("TEAM_EXISTS: Team 'dev-team' already exists.");
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByLabelText('Team name') as HTMLInputElement).value).toBe('Dev Team');
    expect(fake.overview).toHaveBeenCalledTimes(1);
  });

  it('invalid_reference_lists_problems', async () => {
    const path = 'members[2].role';
    const message = "role 'Ghost' is not defined in .agent-studio/roles.json";
    const addMember = vi.fn(async () => fail({
      code: 'TEAM_CONFIG_INVALID',
      message: `team dev-team: ${path}: ${message}`,
      data: { problems: [{ path, message }] },
    }));
    await renderScreen({ calls: { addMember } });
    await click('Add member');
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'codex-gpt' } });
    type('Role', 'Ghost');
    await submitAddMember();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Member was not added.');
    expect(within(alert).getByText(`${path}: ${message}`)).toBeTruthy();
    expect((screen.getByLabelText('Role') as HTMLInputElement).value).toBe('Ghost');
  });

  it('duplicate_member_shows_backend_error', async () => {
    const addMember = vi.fn(async () => fail({ code: 'MEMBER_EXISTS', message: "Team 'dev-team' already has a member 'dev'." }));
    await renderScreen({ calls: { addMember } });
    await click('Add member');
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'codex-gpt' } });
    type('Role', 'QA');
    await submitAddMember();
    expect(screen.getByRole('alert').textContent).toContain("MEMBER_EXISTS: Team 'dev-team' already has a member 'dev'.");
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('running_team_conflicts_are_surfaced', async () => {
    const deleteTeam = vi.fn(async () => fail({
      code: 'TEAM_ALREADY_RUNNING',
      message: "Team 'dev-team' is running in this workspace; stop it before deleting it.",
      remediation: 'run agent-studio team stop --team dev-team',
    }));
    const removeMember = vi.fn(async () => fail({
      code: 'TEAM_ALREADY_RUNNING',
      message: "Team 'dev-team' is running in this workspace; stop it before removing member 'lead'.",
      remediation: 'run agent-studio team stop --team dev-team',
    }));
    const { fake } = await renderScreen({ calls: { deleteTeam, removeMember } });
    expect(screen.getByText(/^This team is running\./)).toBeTruthy();
    await click('Delete team');
    await click('Confirm delete');
    let alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Team was not deleted.');
    expect(alert.textContent).toContain("TEAM_ALREADY_RUNNING: Team 'dev-team' is running in this workspace; stop it before deleting it.");
    expect(alert.textContent).toContain('run agent-studio team stop --team dev-team');
    expect(alert.textContent).toContain('Stop the team before deleting it or removing members.');
    expect(screen.getByRole('button', { name: /^Dev Team/ })).toBeTruthy();
    expect(fake.overview).toHaveBeenCalledTimes(1);
    await click('Remove lead');
    await click('Confirm remove lead');
    alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Member was not removed.');
    expect(screen.getByText('lead')).toBeTruthy();
    expect(fake.overview).toHaveBeenCalledTimes(1);
  });

  it('rejected_write_shows_internal_error', async () => {
    const addMember = vi.fn(() => Promise.reject(new Error('ipc down')));
    await renderScreen({ calls: { addMember } });
    await click('Add member');
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'codex-gpt' } });
    type('Role', 'QA');
    await submitAddMember();
    expect(screen.getByRole('alert').textContent).toContain('INTERNAL: ipc down');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('pending_write_blocks_double_submit', async () => {
    const gate = deferred<ReturnType<typeof ok>>();
    const createTeam = vi.fn(() => gate.promise);
    await renderScreen({ calls: { createTeam } });
    await click('New team');
    type('Team name', 'QA Team');
    const form = screen.getByRole('form', { name: 'New team' });
    fireEvent.submit(form);
    fireEvent.submit(form);
    await flush();
    expect(createTeam).toHaveBeenCalledTimes(1);
    const submit = screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'New team' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Rename team' }) as HTMLButtonElement).disabled).toBe(true);
    gate.resolve(ok({ team: teamDefinition({ id: 'qa-team', name: 'QA Team' }), problems: [] }));
    await flush();
    expect((screen.getByRole('button', { name: 'New team' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('success_with_existing_problems_says_so', async () => {
    const renameTeam = vi.fn(async () =>
      ok({ team: teamDefinition({ name: 'Core' }), problems: [{ path: 'members[0].role', message: 'x' }] }));
    await renderScreen({ calls: { renameTeam } });
    await click('Rename team');
    type('Team name', 'Core');
    await click('Save name');
    expect(screen.getByRole('status').textContent).toMatch(/The team still has 1 problem; see the team details\.$/);
  });

  it('uneditable_teams_hide_controls', async () => {
    const o = overviewFixture([team({
      id: null,
      definition: { state: 'missing', problems: [] },
      runtime: { state: 'running', teamId: 't-9', status: 'running' },
      members: [member({ source: 'runtime', memberId: 'x', name: 'x' })],
    })]);
    await renderScreen({ overview: [ok(o)] });
    for (const name of ['Rename team', 'Delete team', 'Add member', 'Edit x']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.getByText('This team has no definition file; it cannot be edited here.')).toBeTruthy();
  });

  it('dismiss_clears_error', async () => {
    const createTeam = vi.fn(async () => fail({ code: 'TEAM_EXISTS', message: 'dup' }));
    await renderScreen({ calls: { createTeam } });
    await click('New team');
    type('Team name', 'Dev Team');
    await click('Create team');
    expect(screen.getByRole('alert')).toBeTruthy();
    await click('Dismiss');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
