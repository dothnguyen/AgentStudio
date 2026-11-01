// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamsHarness } from './teamsHarness';
import { workspaceA } from './dashboardFixtures';
import {
  deferred, fakeManagement, managementError, member, memberRow, openMember, overviewFixture, showMembers, team, twoTeams,
} from './teamsFixtures';
import { TICKET_PERMISSION_HINT, TICKET_PERMISSION_UNKNOWN } from '../src/renderer/teams/teamEditModel';

afterEach(cleanup);

const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8').replace(/\s+/g, ' ');
const flush = () => act(async () => {});
const ok = <T,>(data: T) => ({ ok: true as const, data });
const saved = (name = 'dev', role = 'Developer') => ok({
  team: { id: 'dev-team', name: 'Dev Team', members: [] },
  member: { id: 'dev', name, role },
  appliesOnNextStart: true,
  problems: [],
});

/** A saved team definition that returns a known ticket permission. */
function permissionTeam(canAddTickets: boolean | undefined) {
  const members = canAddTickets === undefined ? [] : [{ id: 'dev', name: 'dev', role: 'Developer', canAddTickets }];
  return vi.fn(async () => ok({ team: { id: 'dev-team', name: 'Dev Team', members }, members: [], problems: [], active: null }));
}

async function mount(opts: Parameters<typeof fakeManagement>[0] = {}) {
  const fake = fakeManagement(opts);
  const user = userEvent.setup();
  render(<TeamsHarness workspace={workspaceA} management={fake.api} />);
  await flush();
  fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
  await flush();
  return { fake, user };
}

function openDetails(name = 'dev'): HTMLElement {
  showMembers();
  return openMember(name);
}

async function openSettings(user: ReturnType<typeof userEvent.setup>, name = 'dev'): Promise<HTMLElement> {
  const detail = screen.queryByRole('region', { name }) ?? openDetails(name);
  await user.click(within(detail).getByRole('button', { name: 'Edit member settings' }));
  return screen.getByRole('dialog', { name: 'Edit member settings' });
}

describe('Member settings card and dialog', () => {
  it('shows the four saved values on the card', async () => {
    await mount({ calls: { team: permissionTeam(true) } });
    const detail = openDetails();
    await flush();
    const card = within(detail).getByRole('region', { name: 'Member settings' });
    expect(within(card).getByRole('heading', { name: 'Member settings', level: 2 })).toBeTruthy();
    expect(within(card).getByText('Name, role and permissions')).toBeTruthy();
    expect(Array.from(card.querySelectorAll('dd'), node => node.textContent)).toEqual(['dev', 'dev', 'Developer', 'Allowed']);
    expect(card.querySelectorAll('code.entity-id')[0]!.textContent).toBe('dev');
  });

  it('opens the 680px dialog with focus on the display name', async () => {
    const { user } = await mount({ calls: { team: permissionTeam(true) } });
    const detail = openDetails();
    await user.click(within(detail).getByRole('button', { name: 'Edit member settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit member settings' });
    expect(dialog.getAttribute('style')).toContain('width: min(680px, 100%)');
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Display name'));
    expect(within(dialog).getByText('Applies on next team start')).toBeTruthy();
  });

  it('requires a display name and never saves an empty one', async () => {
    const updateMember = vi.fn(async () => saved());
    const { user } = await mount({ calls: { updateMember, team: permissionTeam(true) } });
    const dialog = await openSettings(user);
    const name = within(dialog).getByLabelText('Display name') as HTMLInputElement;
    const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('radio', { name: /Reviewer/ }));
    expect(save.disabled).toBe(false);
    await user.clear(name);
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(within(dialog).getByText('Enter a name.')).toBeTruthy();
    expect(save.disabled).toBe(true);
    await user.type(name, '   ');
    expect(save.disabled).toBe(true);
    expect(updateMember).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Edit member settings' })).toBeTruthy();
  });

  it('keeps the member id locked and non-editable', async () => {
    const { user } = await mount({ calls: { team: permissionTeam(true) } });
    const dialog = await openSettings(user);
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1);
    expect(within(dialog).queryByRole('textbox', { name: 'Member id' })).toBeNull();
    const label = within(dialog).getByText('Member id');
    const value = label.parentElement!.querySelector('.member-settings-id')!;
    expect(value.textContent).toBe('dev');
    expect(value.querySelector('svg[data-icon="lock"]')).not.toBeNull();
  });

  it('renders the role catalog as a two-column radiogroup with descriptions', async () => {
    const { user } = await mount({ calls: { team: permissionTeam(true) } });
    const dialog = await openSettings(user);
    const group = within(dialog).getByRole('radiogroup', { name: 'Assigned role' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.length).toBeGreaterThan(1);
    expect(radios.filter(radio => radio.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    expect(within(group).getByRole('radio', { name: /Developer/ }).getAttribute('aria-checked')).toBe('true');
    expect(group.textContent).toContain('Implements scoped tickets.');
    expect(group.textContent).toContain('Validates changes.');
    expect(css).toContain('.member-settings-roles { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 8px; }');
  });

  it('saves only the role when only the role changed', async () => {
    const updateMember = vi.fn(async () => saved('dev', 'Reviewer'));
    const { user } = await mount({ calls: { updateMember, team: permissionTeam(true) } });
    const dialog = await openSettings(user);
    await user.click(within(dialog).getByRole('radio', { name: /Reviewer/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await flush();
    expect(updateMember).toHaveBeenCalledTimes(1);
    expect(updateMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', { role: 'Reviewer' });
    expect(screen.queryByRole('dialog', { name: 'Edit member settings' })).toBeNull();
  });

  it('saves name, role and ticket permission together in one write', async () => {
    const updateMember = vi.fn(async () => saved('Lead', 'QA'));
    const { user } = await mount({ calls: { updateMember, team: permissionTeam(false) } });
    const dialog = await openSettings(user);
    const name = within(dialog).getByLabelText('Display name');
    await user.clear(name);
    await user.type(name, 'Lead');
    await user.click(within(dialog).getByRole('radio', { name: /QA/ }));
    await user.click(within(dialog).getByRole('switch', { name: 'Can add tickets' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await flush();
    expect(updateMember).toHaveBeenCalledTimes(1);
    expect(updateMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', { name: 'Lead', role: 'QA', canAddTickets: true });
  });

  it('disables the role group and keeps the current role when the catalog is unavailable', async () => {
    const { user } = await mount({ calls: { team: permissionTeam(true) }, roles: [managementError('ROLES_DOWN', 'roles unreadable')] });
    const dialog = await openSettings(user);
    const group = within(dialog).getByRole('radiogroup', { name: 'Assigned role' });
    expect(group.getAttribute('aria-disabled')).toBe('true');
    expect(within(dialog).getByText('The role catalog could not be loaded. Retry loading it to choose or change a role.')).toBeTruthy();
    const current = within(group).getByRole('radio', { name: /Developer/ });
    expect(current.getAttribute('aria-checked')).toBe('true');
    expect((current as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps an undefined current role as the first, selected and selectable option', async () => {
    const ghost = member({ memberId: 'dev', name: 'dev', role: 'GhostRole', roleState: 'undefined', roleDescription: null });
    const { user } = await mount({ overview: [ok(overviewFixture([team({ members: [ghost] })]))], calls: { team: permissionTeam(true) } });
    const dialog = await openSettings(user);
    const group = within(dialog).getByRole('radiogroup', { name: 'Assigned role' });
    const radios = within(group).getAllByRole('radio');
    const ghostRole = within(group).getByRole('radio', { name: /GhostRole/ });
    expect(radios[0]).toBe(ghostRole);
    expect(ghostRole.getAttribute('aria-checked')).toBe('true');
    expect((ghostRole as HTMLButtonElement).disabled).toBe(false);
    expect(ghostRole.textContent).toContain('Role not defined in roles.json');
    await user.click(within(group).getByRole('radio', { name: /Developer/ }));
    expect(ghostRole.getAttribute('aria-checked')).toBe('false');
    await user.click(ghostRole);
    expect(ghostRole.getAttribute('aria-checked')).toBe('true');
  });

  it('keeps the permission switch disabled while it loads, then enables the saved value', async () => {
    const gate = deferred<ReturnType<typeof ok>>();
    const teamCall = vi.fn(() => gate.promise);
    const { user } = await mount({ calls: { team: teamCall } });
    const dialog = await openSettings(user);
    const toggle = within(dialog).getByRole('switch', { name: 'Can add tickets' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(within(dialog).getByText(TICKET_PERMISSION_HINT)).toBeTruthy();
    await act(async () => { gate.resolve(ok({ team: { id: 'dev-team', name: 'Dev Team', members: [{ id: 'dev', role: 'Developer', canAddTickets: true }] }, members: [], problems: [], active: null })); });
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('shows the unknown text and a retry when the permission read fails', async () => {
    const teamCall = permissionTeam(true);
    teamCall.mockResolvedValueOnce({ ok: false, error: { code: 'INTERNAL', message: 'offline', retryable: true } });
    const { user } = await mount({ calls: { team: teamCall } });
    const dialog = await openSettings(user);
    const toggle = within(dialog).getByRole('switch', { name: 'Can add tickets' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(within(dialog).getByText(TICKET_PERMISSION_UNKNOWN)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Retry loading ticket permission' }));
    await flush();
    expect(teamCall).toHaveBeenCalledTimes(2);
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('keeps an unknown permission disabled and out of the changes', async () => {
    const updateMember = vi.fn(async () => saved());
    const { user } = await mount({ calls: { updateMember, team: permissionTeam(undefined) } });
    const dialog = await openSettings(user);
    const toggle = within(dialog).getByRole('switch', { name: 'Can add tickets' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(within(dialog).getByText(TICKET_PERMISSION_UNKNOWN)).toBeTruthy();
    const name = within(dialog).getByLabelText('Display name');
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await flush();
    expect(updateMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', { name: 'Renamed' });
  });

  it('keeps the dialog open on a failed save and focuses the inline error', async () => {
    const updateMember = vi.fn(async () => ({ ok: false as const, error: { code: 'BAD_REQUEST', message: 'nope', retryable: false, data: { problems: [{ path: 'members[0].role', message: 'unknown role' }] } } }));
    const { user } = await mount({ calls: { updateMember, team: permissionTeam(true) } });
    const dialog = await openSettings(user);
    const name = within(dialog).getByLabelText('Display name');
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await flush();
    expect(screen.getByRole('dialog', { name: 'Edit member settings' })).toBe(dialog);
    const alert = screen.getByRole('alert');
    expect(alert.closest('[role="dialog"]')).toBe(dialog);
    expect(alert.textContent).toContain('Member was not saved.');
    expect(alert.textContent).toContain('BAD_REQUEST: nope');
    expect(alert.textContent).toContain('members[0].role: unknown role');
    expect(document.activeElement).toBe(alert);
    expect((within(dialog).getByLabelText('Display name') as HTMLInputElement).value).toBe('Renamed');
  });

  it('closes on success and returns focus to the card Edit button', async () => {
    const updateMember = vi.fn(async () => saved('Renamed'));
    const { user } = await mount({ calls: { updateMember, team: permissionTeam(true) } });
    const detail = openDetails();
    const edit = within(detail).getByRole('button', { name: 'Edit member settings' });
    await user.click(edit);
    const dialog = screen.getByRole('dialog', { name: 'Edit member settings' });
    const name = within(dialog).getByLabelText('Display name');
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await flush();
    expect(screen.queryByRole('dialog', { name: 'Edit member settings' })).toBeNull();
    expect(document.activeElement).toBe(within(detail).getByRole('button', { name: 'Edit member settings' }));
  });

  it('discards the draft on Cancel and Escape and reopens the saved values', async () => {
    const updateMember = vi.fn();
    const { user } = await mount({ calls: { updateMember, team: permissionTeam(true) } });
    let dialog = await openSettings(user);
    let name = within(dialog).getByLabelText('Display name');
    await user.clear(name);
    await user.type(name, 'dirty');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(updateMember).not.toHaveBeenCalled();
    dialog = await openSettings(user);
    name = within(dialog).getByLabelText('Display name');
    expect((name as HTMLInputElement).value).toBe('dev');
    await user.clear(name);
    await user.type(name, 'dirty again');
    await user.keyboard('{Escape}');
    await flush();
    expect(updateMember).not.toHaveBeenCalled();
    dialog = await openSettings(user);
    expect((within(dialog).getByLabelText('Display name') as HTMLInputElement).value).toBe('dev');
    expect(within(dialog).getByRole('radio', { name: /Developer/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('disables Edit and Save while the app is read-only', async () => {
    const { user } = await mount({ overview: [ok(twoTeams()), managementError('OFFLINE', 'offline')], calls: { team: permissionTeam(true) } });
    const detail = openDetails();
    const edit = within(detail).getByRole('button', { name: 'Edit member settings' });
    await user.click(edit);
    const dialog = screen.getByRole('dialog', { name: 'Edit member settings' });
    const name = within(dialog).getByLabelText('Display name');
    await user.clear(name);
    await user.type(name, 'Renamed');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await flush();
    expect((within(detail).getByRole('button', { name: 'Edit member settings' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables Edit and Save while a write is pending and ignores Escape', async () => {
    const gate = deferred<ReturnType<typeof saved>>();
    const updateMember = vi.fn(() => gate.promise);
    const { user } = await mount({ calls: { updateMember, team: permissionTeam(true) } });
    const detail = openDetails();
    const edit = within(detail).getByRole('button', { name: 'Edit member settings' });
    await user.click(edit);
    const dialog = screen.getByRole('dialog', { name: 'Edit member settings' });
    const name = within(dialog).getByLabelText('Display name');
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveProperty('disabled', true);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Edit member settings' })).toBeTruthy();
    expect((within(detail).getByRole('button', { name: 'Edit member settings' }) as HTMLButtonElement).disabled).toBe(true);
    gate.resolve(saved('Renamed'));
    await flush();
    expect(screen.queryByRole('dialog', { name: 'Edit member settings' })).toBeNull();
  });

  it('opens the dialog once from the row menu Edit configuration intent', async () => {
    await mount({ calls: { team: permissionTeam(true) } });
    expect(screen.queryByRole('dialog', { name: 'Edit member settings' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for dev' }));
    await flush();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit configuration…' }));
    await flush();
    expect(screen.getAllByRole('dialog', { name: 'Edit member settings' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await flush();
    const detail = screen.getByRole('region', { name: 'dev' });
    fireEvent.click(within(detail).getByRole('button', { name: 'Back to members' }));
    await flush();
    fireEvent.click(memberRow('dev').querySelector<HTMLButtonElement>('.teams-member-open')!);
    await flush();
    expect(screen.queryByRole('dialog', { name: 'Edit member settings' })).toBeNull();
  });

  it('shows Not allowed and the unknown explanation on the card', async () => {
    await mount({ calls: { team: permissionTeam(false) } });
    let detail = openDetails();
    await flush();
    let card = within(detail).getByRole('region', { name: 'Member settings' });
    expect(Array.from(card.querySelectorAll('dd'), node => node.textContent)).toEqual(['dev', 'dev', 'Developer', 'Not allowed']);

    cleanup();
    const teamCall = vi.fn(async () => managementError('INTERNAL', 'offline'));
    await mount({ calls: { team: teamCall } });
    detail = openDetails();
    await flush();
    card = within(detail).getByRole('region', { name: 'Member settings' });
    expect(card.textContent).toContain(TICKET_PERMISSION_UNKNOWN);
  });

  it('places the Member settings card in the aside after Live status', async () => {
    await mount({ calls: { team: permissionTeam(true) } });
    const detail = openDetails();
    await flush();
    const live = within(detail).getByRole('region', { name: 'Live status' });
    const card = within(detail).getByRole('region', { name: 'Member settings' });
    expect(card.parentElement).toBe(live.parentElement);
    expect(live.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('hides the Edit action when the member cannot be edited', async () => {
    await mount({
      overview: [ok(overviewFixture([team({ members: [member({ memberId: 'rt', name: 'runtime-only', source: 'runtime', runtime: null, agentOptions: [] })] })]))],
      calls: { team: permissionTeam(true) },
    });
    const detail = openDetails('runtime-only');
    await flush();
    const card = within(detail).getByRole('region', { name: 'Member settings' });
    expect(within(card).queryByRole('button', { name: 'Edit member settings' })).toBeNull();
    expect(card.textContent).toContain('runtime-only');
  });

  it('orders the dialog as General, Role and Permissions with a primary Save', async () => {
    const { user } = await mount({ calls: { team: permissionTeam(true) } });
    const dialog = await openSettings(user);
    const headings = within(dialog).getAllByRole('heading', { level: 3 }).map(node => node.textContent);
    expect(headings).toEqual(['General', 'Role', 'Permissions']);
    const general = within(dialog).getByRole('heading', { name: 'General', level: 3 }).parentElement!;
    expect(within(general).getByLabelText('Display name')).toBeTruthy();
    const role = within(dialog).getByRole('heading', { name: 'Role', level: 3 }).parentElement!;
    expect(within(role).getByRole('radiogroup', { name: 'Assigned role' })).toBeTruthy();
    const permissions = within(dialog).getByRole('heading', { name: 'Permissions', level: 3 }).parentElement!;
    expect(within(permissions).getByRole('switch', { name: 'Can add tickets' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Save' }).className).toContain('dialog-action-primary');
  });

  it('moves the role selection with the radiogroup arrow keys', async () => {
    const { user } = await mount({ calls: { team: permissionTeam(true) } });
    const dialog = await openSettings(user);
    const group = within(dialog).getByRole('radiogroup', { name: 'Assigned role' });
    const developer = within(group).getByRole('radio', { name: /Developer/ });
    expect(developer.getAttribute('aria-checked')).toBe('true');
    developer.focus();

    await user.keyboard('{ArrowRight}');
    expect(within(group).getByRole('radio', { name: /QA/ }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(within(group).getByRole('radio', { name: /QA/ }));

    await user.keyboard('{End}');
    expect(within(group).getByRole('radio', { name: /TeamLead/ }).getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{Home}');
    expect(within(group).getByRole('radio', { name: /Developer/ }).getAttribute('aria-checked')).toBe('true');

    await user.keyboard('{ArrowLeft}');
    expect(within(group).getByRole('radio', { name: /TeamLead/ }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(within(group).getByRole('radio', { name: /TeamLead/ }));
  });

  it('fills a late permission read without overwriting a name draft', async () => {
    const gate = deferred<ReturnType<typeof ok>>();
    const updateMember = vi.fn(async () => saved('Renamed'));
    const { user } = await mount({ calls: { updateMember, team: vi.fn(() => gate.promise) } });
    const dialog = await openSettings(user);
    const name = within(dialog).getByLabelText('Display name') as HTMLInputElement;
    const toggle = () => within(dialog).getByRole('switch', { name: 'Can add tickets' }) as HTMLButtonElement;
    expect(toggle().disabled).toBe(true);

    await user.clear(name);
    await user.type(name, 'Renamed');
    await act(async () => {
      gate.resolve(ok({ team: { id: 'dev-team', name: 'Dev Team', members: [{ id: 'dev', role: 'Developer', canAddTickets: false }] }, members: [], problems: [], active: null }));
    });

    expect(name.value).toBe('Renamed');
    expect(toggle().disabled).toBe(false);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await flush();
    expect(updateMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', { name: 'Renamed' });
  });

  it('still saves a name change when the role catalog is unavailable', async () => {
    const updateMember = vi.fn(async () => saved('Renamed'));
    const { user } = await mount({
      calls: { updateMember, team: permissionTeam(true) },
      roles: [managementError('ROLES_DOWN', 'roles unreadable')],
    });
    const dialog = await openSettings(user);
    await user.clear(within(dialog).getByLabelText('Display name'));
    await user.type(within(dialog).getByLabelText('Display name'), 'Renamed');
    const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await user.click(save);
    await flush();
    expect(updateMember).toHaveBeenCalledWith('ws-a', 'dev-team', 'dev', { name: 'Renamed' });
  });

  it('tabs from the display name through the role, permission and actions', async () => {
    const { user } = await mount({ calls: { team: permissionTeam(true) } });
    const dialog = await openSettings(user);
    const name = within(dialog).getByLabelText('Display name');
    await user.type(name, 'x');
    expect(document.activeElement).toBe(name);

    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole('radio', { name: /Developer/ }));
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole('switch', { name: 'Can add tickets' }));
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Save' }));
  });

  it('styles the member settings grid and dialog groups from the design', () => {
    expect(css).toContain('.teams-member-settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 16px 18px; margin: 0; }');
    expect(css).toContain('.member-settings-section + .member-settings-section { border-top: 1px solid #23262c; padding-top: 20px; }');
    expect(css).toContain('.member-settings-permission { display: flex; align-items: center; justify-content: space-between;');
    expect(css).toContain('.member-settings-switch[aria-checked="true"] { justify-content: flex-end; background: #5b9cff; }');
  });
});
