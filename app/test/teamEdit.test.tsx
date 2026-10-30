// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamsScreen } from '../src/renderer/teams/TeamsScreen';
import { workspaceA } from './dashboardFixtures';
import { roleItem, rolesFixture } from './rolesFixtures';
import {
  openMember,
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
const openTab = async (name: string) => {
  fireEvent.click(screen.getByRole('tab', { name }));
  await flush();
};
const MEMBER_ACTION = /^(Add member|Edit |Remove |Confirm remove )/;
const click = async (name: string | RegExp) => {
  if (typeof name === 'string' && MEMBER_ACTION.test(name)
    && screen.getByRole('tab', { name: 'Members' }).getAttribute('aria-selected') !== 'true') await openTab('Members');
  if (typeof name === 'string' && /^(Edit|Remove) (dev|lead)$/.test(name) && !screen.queryByRole('region', { name: name.split(' ')[1] })) openMember(name.split(' ')[1]!);
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
const overviewPanel = () => screen.getByRole('tabpanel', { name: 'Overview' });

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
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(fake.agents).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('form', { name: 'New team' })).toBeNull();
  });

  it('rename_running_team_applies_on_next_start', async () => {
    const renameTeam = vi.fn(async () =>
      ok({ team: teamDefinition({ name: 'Core Team' }), problems: [], appliesOnNextStart: true }));
    await renderScreen({ calls: { renameTeam } });
    expect(within(overviewPanel()).getByRole('button', { name: 'Rename team' })).toBeTruthy();
    await click('Rename team');
    expect((screen.getByLabelText('Team name') as HTMLInputElement).value).toBe('Dev Team');
    type('Team name', 'Core Team');
    await click('Save name');
    expect(renameTeam).toHaveBeenCalledWith('ws-a', 'dev-team', 'Core Team');
    expect(screen.getByRole('status').textContent).toBe(
      'Renamed team to "Core Team". Saved configuration applies on the next team start; the running member is unchanged.',
    );
  });

  it('delete_team_needs_confirmation', async () => {
    const deleteTeam = vi.fn(async () => ok({ deleted: 'release' }));
    const { fake } = await renderScreen({ calls: { deleteTeam } });
    fireEvent.click(screen.getByRole('button', { name: /^Release Team/ }));
    expect(within(overviewPanel()).getByRole('button', { name: 'Delete team' })).toBeTruthy();
    await click('Delete team');
    expect(deleteTeam).not.toHaveBeenCalled();
    expect(screen.getByText('Delete team "Release Team"? Its definition file is removed.')).toBeTruthy();
    await click('Confirm delete');
    expect(deleteTeam).toHaveBeenCalledWith('ws-a', 'release');
    expect(screen.getByRole('status').textContent).toBe('Deleted team "Release Team".');
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(cardPressed('Dev Team')).toBe('true');
  });

  it('rename_form_closes_when_another_team_is_selected', async () => {
    await renderScreen();
    await click('Rename team');
    expect(within(overviewPanel()).getByRole('form', { name: 'Rename team' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Release Team/ }));
    expect(within(overviewPanel()).queryByRole('form', { name: 'Rename team' })).toBeNull();
  });

  it('delete_running_team_shows_backend_error', async () => {
    const deleteTeam = vi.fn(async () => fail({ code: 'TEAM_ALREADY_RUNNING', message: 'Team is running.' }));
    await renderScreen({ calls: { deleteTeam } });
    expect(overviewPanel().textContent).toContain('This team is running. Stop it before deleting the team or removing members; other edits apply the next time it starts.');
    expect((within(overviewPanel()).getByRole('button', { name: 'Delete team' }) as HTMLButtonElement).disabled).toBe(false);
    await click('Delete team');
    await click('Confirm delete');
    expect(deleteTeam).toHaveBeenCalledWith('ws-a', 'dev-team');
    const alert = screen.getByRole('alert').textContent;
    expect(alert).toContain('Team was not deleted.');
    expect(alert).toContain('TEAM_ALREADY_RUNNING: Team is running.');
    expect(alert).toContain('Stop the team before deleting it or removing members.');
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
    fireEvent.change(screen.getByLabelText('Add agent option'), { target: { value: 'codex-gpt' } });
    type('Role', 'QA');
    await submitAddMember();
    expect(addMember).toHaveBeenCalledWith('ws-a', 'dev-team', { role: 'QA', agents: ['codex-gpt'] });
    expect(screen.getByRole('status').textContent).toBe(
      'Added Codex GPT to Dev Team. Saved configuration applies on the next team start; the running member is unchanged.',
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
    await click('Use catalog agents');
    const select = screen.getByLabelText('Add agent option') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'spare' } });
    await click('Save member');
    expect(updateMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'lead', { agents: ['spare'] });
  });

  it('ordered_options_buttons_and_partial_patch', async () => {
    const updateMember = vi.fn(async () => ok({team: teamDefinition(), member: {id: 'dev', name: 'dev', role: 'Developer'}, problems: [], appliesOnNextStart: true}));
    await renderScreen({calls: {updateMember}});
    await click('Edit dev');
    fireEvent.change(screen.getByLabelText('Add agent option'), {target: {value: 'codex-gpt'}});
    const up = screen.getByRole('button', {name: 'Move Codex GPT up'});
    expect(up.tagName).toBe('BUTTON');
    up.focus(); expect(document.activeElement).toBe(up);
    fireEvent.click(up);
    expect(screen.getByRole('button', {name: 'Move Codex GPT down'}).tagName).toBe('BUTTON');
    expect(screen.getByRole('button', {name: 'Remove OpenCode Sonnet'}).tagName).toBe('BUTTON');
    await click('Remove OpenCode Sonnet');
    await click('Save member');
    expect(updateMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', {agents: ['codex-gpt']});
    expect(screen.getByRole('status').textContent).toContain('Saved configuration applies on the next team start; the running member is unchanged.');
  });
  it('add_options_excludes_selected_agents_and_restores_removed_agents', async () => {
    await renderScreen();
    await click('Edit dev');
    const select = screen.getByLabelText('Add agent option') as HTMLSelectElement;
    const offered = () => Array.from(select.options, option => option.value).filter(Boolean);
    expect(offered()).toEqual(['codex-gpt', 'spare']);
    fireEvent.change(select, {target: {value: 'codex-gpt'}});
    expect(offered()).toEqual(['spare']);
    fireEvent.change(select, {target: {value: 'spare'}});
    expect(offered()).toEqual([]);
    expect(select.disabled).toBe(true);
    expect(screen.getByText('All catalog agents are already options.')).toBeTruthy();
    await click('Remove Codex GPT');
    expect(select.disabled).toBe(false);
    expect(offered()).toEqual(['codex-gpt']);
  });

  it('saved_edit_does_not_change_live_agent_while_overview_reloads', async () => {
    const gate = deferred<ReturnType<typeof ok<ReturnType<typeof twoTeams>>>>();
    const updateMember = vi.fn(async () => ok({team: teamDefinition(), member: {id: 'dev', name: 'dev', role: 'Developer'}, problems: [], appliesOnNextStart: true}));
    await renderScreen({overview: [ok(twoTeams()), gate.promise], calls: {updateMember}});
    await click('Edit dev');
    fireEvent.change(screen.getByLabelText('Add agent option'), {target: {value: 'codex-gpt'}});
    await click('Move Codex GPT up');
    await click('Save member');
    expect(updateMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', {agents: ['codex-gpt', 'opencode-sonnet']});
    gate.resolve(ok(twoTeams()));
    await flush();
    const row = within(screen.getByRole('region', {name: 'Dev Team'})).getAllByRole('row')[1]!;
    expect(row.querySelectorAll('td')[3]?.textContent).toContain('opencode-sonnet · opencode · claude-sonnet');
  });
  it('missing_option_blocks_save_until_removed', async () => {
    const missing = {id: 'gone', name: null, provider: null, model: null, reasoning: null, description: null, state: 'missing' as const};
    const updateMember = vi.fn(async () => ok({team: teamDefinition(), member: {id: 'dev', name: 'dev', role: 'Developer'}, problems: [], appliesOnNextStart: false}));
    await renderScreen({overview: [ok(overviewFixture([team({members: [member({agentMode: 'ordered_catalog', agentOptions: [missing]})]})]))], calls: {updateMember}});
    await click('Edit dev');
    expect(screen.getByText('Missing from catalog')).toBeTruthy();
    type('Role', 'QA'); await click('Save member');
    expect(screen.getByRole('alert').textContent).toBe('Remove or replace missing catalog agents before saving.');
    expect(updateMember).not.toHaveBeenCalled();
    await click('Remove gone');
    fireEvent.change(screen.getByLabelText('Add agent option'), {target: {value: 'codex-gpt'}});
    await click('Save member');
    expect(updateMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', {role: 'QA', agents: ['codex-gpt']});
  });

  it('removing_last_option_blocks_save_and_associates_error', async () => {
    const updateMember = vi.fn();
    await renderScreen({calls: {updateMember}});
    await click('Edit dev');
    await click('Remove OpenCode Sonnet');
    await click('Save member');
    const error = screen.getByRole('alert');
    expect(error.textContent).toBe('Choose at least one agent.');
    expect(screen.getByLabelText('Add agent option').getAttribute('aria-describedby')).toBe(error.id);
    expect(updateMember).not.toHaveBeenCalled();
  });

  it('inline_name_edit_keeps_saved_configuration_until_conversion', async () => {
    const inline = member({memberId: 'lead', name: 'lead', role: 'TeamLead', source: 'inline', agentMode: 'inline', agentOptions: [], defaultAgent: null, provider: 'codex', model: 'model-x', reasoning: 'high'});
    const updateMember = vi.fn(async () => ok({team: teamDefinition(), member: {id: 'lead', name: 'Lead', role: 'TeamLead'}, problems: [], appliesOnNextStart: false}));
    await renderScreen({overview: [ok(overviewFixture([team({members: [inline]})]))], calls: {updateMember}});
    await click('Edit lead');
    expect(screen.getAllByText(/Inline — codex · model-x · Reasoning: high/).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Add agent option')).toBeNull();
    type('Member name', 'Lead');
    await click('Save member');
    expect(updateMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'lead', {name: 'Lead'});
    await click('Edit lead');
    await click('Use catalog agents');
    await click('Save member');
    expect(screen.getByRole('alert').textContent).toBe('Choose at least one agent.');
    expect(updateMember).toHaveBeenCalledTimes(1);
  });

  it('unavailable_catalog_preserves_rows_and_missing_evidence', async () => {
    const missing = {id: 'gone', name: null, provider: null, model: null, reasoning: null, description: null, state: 'missing' as const};
    const saved = member({agentMode: 'ordered_catalog', agentOptions: [...member().agentOptions, missing]});
    const updateMember = vi.fn(async () => ok({team: teamDefinition(), member: {id: 'dev', name: 'dev', role: 'QA'}, problems: [], appliesOnNextStart: false}));
    await renderScreen({overview: [ok(overviewFixture([team({members: [saved]})]))], agents: [fail({code: 'OFFLINE', message: 'offline'})], calls: {updateMember}});
    await click('Edit dev');
    expect(screen.getByRole('button', {name: 'Remove OpenCode Sonnet'})).toBeTruthy();
    expect(screen.getByRole('button', {name: 'Remove gone'})).toBeTruthy();
    expect((screen.getByLabelText('Add agent option') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getAllByText('Missing from catalog')).toHaveLength(1);
    type('Role', 'QA');
    await click('Save member');
    expect(within(screen.getByRole('form', {name: 'Edit dev'})).getByRole('alert').textContent).toBe('Remove or replace missing catalog agents before saving.');
    await click('Remove gone');
    await click('Save member');
    expect(updateMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', {role: 'QA', agents: ['opencode-sonnet']});
  });

  it('option_controls_are_ordered_native_buttons_and_operable', async () => {
    await renderScreen();
    await click('Edit dev');
    fireEvent.change(screen.getByLabelText('Add agent option'), {target: {value: 'codex-gpt'}});
    const form = screen.getByRole('form', {name: 'Edit dev'});
    const controls = within(form).getAllByRole('button').filter(b => /^(Move |Remove )/.test(b.getAttribute('aria-label') ?? ''));
    expect(controls.map(b => b.getAttribute('aria-label'))).toEqual([
      'Move OpenCode Sonnet up', 'Move OpenCode Sonnet down', 'Remove OpenCode Sonnet',
      'Move Codex GPT up', 'Move Codex GPT down', 'Remove Codex GPT',
    ]);
    for (const button of controls) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('type')).toBe('button');
    }
    expect((controls[0] as HTMLButtonElement).disabled).toBe(true);
    expect((controls[4] as HTMLButtonElement).disabled).toBe(true);
    const enabled = controls.filter((button) => !(button as HTMLButtonElement).disabled);
    for (const [index, button] of enabled.entries()) {
      expect(button.tabIndex).toBe(0);
      if (index > 0) expect(enabled[index - 1]!.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      button.focus();
      expect(document.activeElement).toBe(button);
    }

    // jsdom does not perform the browser's native button activation on Space.
    // Dispatch the keyboard events and their native click default action explicitly.
    const activate = (name: string) => {
      const button = screen.getByRole('button', {name}) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      button.focus();
      expect(document.activeElement).toBe(button);
      fireEvent.keyDown(button, {key: ' ', code: 'Space'});
      fireEvent.keyUp(button, {key: ' ', code: 'Space'});
      fireEvent.click(button, {detail: 0});
    };
    const names = () => Array.from(form.querySelectorAll('.teams-option-meta strong'), (node) => node.textContent);
    activate('Move OpenCode Sonnet down');
    expect(names()).toEqual(['Codex GPT', 'OpenCode Sonnet']);
    activate('Move OpenCode Sonnet up');
    expect(names()).toEqual(['OpenCode Sonnet', 'Codex GPT']);
    activate('Move Codex GPT up');
    expect(names()).toEqual(['Codex GPT', 'OpenCode Sonnet']);
    activate('Move Codex GPT down');
    expect(names()).toEqual(['OpenCode Sonnet', 'Codex GPT']);
    activate('Remove OpenCode Sonnet');
    expect(names()).toEqual(['Codex GPT']);
    activate('Remove Codex GPT');
    expect(names()).toEqual([]);
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
    expect(screen.queryByText(/is no longer in this team/)).toBeNull();
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
    expect(screen.getByText('Choose at least one agent.')).toBeTruthy();
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
    const message = "role 'QA' was deleted from in .agent-studio/roles.json";
    const addMember = vi.fn(async () => fail({
      code: 'TEAM_CONFIG_INVALID',
      message: `team dev-team: ${path}: ${message}`,
      data: { problems: [{ path, message }] },
    }));
    await renderScreen({ calls: { addMember } });
    await click('Add member');
    fireEvent.change(screen.getByLabelText('Add agent option'), { target: { value: 'codex-gpt' } });
    type('Role', 'QA');
    await submitAddMember();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Member was not added.');
    expect(within(alert).getByText(`${path}: ${message}`)).toBeTruthy();
    expect((screen.getByLabelText('Role') as HTMLSelectElement).value).toBe('QA');
  });

  it('member_form_uses_catalog_selector_and_blocks_add_when_unavailable', async () => {
    const dup = rolesFixture({ items: [roleItem('qa-a', { name: 'QA' }), roleItem('qa-b', { name: 'QA' })] });
    const first = await renderScreen({ roles: [ok(dup)] });
    await click('Add member');
    const select = screen.getByLabelText('Role') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([
      ['', 'Choose a role'], ['qa-a', 'QA (qa-a)'], ['qa-b', 'QA (qa-b)'],
    ]);
    expect(screen.getByText(/Role metadata and instructions are shared\. Ticket permission and saved agent options remain settings of this member\./)).toBeTruthy();
    first.result.unmount();
    const down = await renderScreen({ roles: [fail({ code: 'INTERNAL', message: 'roles down' })] });
    await click('Add member');
    expect(screen.getByText('The role catalog could not be loaded. Retry loading it to choose or change a role.')).toBeTruthy();
    expect((screen.getByLabelText('Role') as HTMLSelectElement).disabled).toBe(true);
    expect((within(screen.getByRole('form', { name: 'Add member' })).getByRole('button', { name: 'Add member' }) as HTMLButtonElement).disabled).toBe(true);
    down.result.unmount();
    const edit = await renderScreen({ roles: [fail({ code: 'INTERNAL', message: 'roles down' })] });
    await click('Edit dev');
    const kept = screen.getByLabelText('Role') as HTMLSelectElement;
    expect(kept.value).toBe('Developer');
    expect(kept.disabled).toBe(true);
    expect(edit.fake.roles).toHaveBeenCalled();
  });

  it('role_only_save_sends_exact_patch_and_next_start_notice', async () => {
    const dup = rolesFixture({ items: [roleItem('Developer'), roleItem('qa-b', { name: 'QA' })] });
    const updateMember = vi.fn(async () => ok({ team: teamDefinition(), member: { id: 'dev', name: 'dev', role: 'qa-b', agent: 'opencode-sonnet' }, problems: [], appliesOnNextStart: true }));
    await renderScreen({ roles: [ok(dup)], calls: { updateMember } });
    await click('Edit dev');
    type('Role', 'qa-b');
    await click('Save member');
    expect(updateMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', { role: 'qa-b' });
    expect(screen.getByRole('status').textContent).toContain('Saved configuration applies on the next team start; the running member is unchanged.');
  });

  it('duplicate_member_shows_backend_error', async () => {
    const addMember = vi.fn(async () => fail({ code: 'MEMBER_EXISTS', message: "Team 'dev-team' already has a member 'dev'." }));
    await renderScreen({ calls: { addMember } });
    await click('Add member');
    fireEvent.change(screen.getByLabelText('Add agent option'), { target: { value: 'codex-gpt' } });
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
    expect(within(screen.getByRole('region', { name: 'lead' })).getAllByText('lead').length).toBeGreaterThan(0);
    expect(fake.overview).toHaveBeenCalledTimes(1);
  });

  it('rejected_write_shows_internal_error', async () => {
    const addMember = vi.fn(() => Promise.reject(new Error('ipc down')));
    await renderScreen({ calls: { addMember } });
    await click('Add member');
    fireEvent.change(screen.getByLabelText('Add agent option'), { target: { value: 'codex-gpt' } });
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
    for (const view of ['Overview', 'Members']) {
      await openTab(view);
      for (const name of ['Rename team', 'Delete team', 'Add member', 'Edit x']) {
        expect(screen.queryByRole('button', { name })).toBeNull();
      }
    }
    await openTab('Overview');
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
