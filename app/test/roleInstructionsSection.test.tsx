// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoleCatalogItem, RoleCatalogList } from '../src/renderer/api';
import { RoleInstructionsSection } from '../src/renderer/teams/RoleInstructionsSection';
import { fakeManagement, member } from './teamsFixtures';
import { roleItem, rolesFixture } from './rolesFixtures';

afterEach(cleanup);
const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8').replace(/\s+/g, ' ');
const SHA = 'a'.repeat(64);
const ok = (data: RoleCatalogList) => ({ ok: true as const, data });

function role(over: Partial<RoleCatalogItem> = {}): RoleCatalogItem {
  return roleItem('TeamLead', {
    name: 'TeamLead',
    description: 'Unpacks features into phases, epics and stories.',
    instructions: { state: 'ok', path: '.agent-studio/roles/team-lead.md', text: 'one\ntwo\nthree', sha256: 'b'.repeat(64), bytes: 13 },
    warnings: ['Role skill python-testing is missing'],
    ...over,
  });
}

function catalog(item: RoleCatalogItem = role()): RoleCatalogList {
  return rolesFixture({ sha256: SHA, items: [item] });
}

function renderSection(over: Partial<Parameters<typeof RoleInstructionsSection>[0]> = {}) {
  const fake = fakeManagement();
  const reloadRoles = vi.fn(async () => ok(catalog()));
  const props: Parameters<typeof RoleInstructionsSection>[0] = {
    workspaceId: 'ws-a',
    management: fake.api,
    member: member({ memberId: 'lead', name: 'lead', role: 'TeamLead', roleState: 'defined' }),
    roles: [role()],
    catalogSha: SHA,
    roleCatalogMessage: null,
    pending: false,
    readOnly: false,
    reloadRoles,
    ...over,
  };
  const view = render(<RoleInstructionsSection {...props} />);
  return { ...view, props, reloadRoles };
}

describe('Role instructions card', () => {
  it('shows the role description, clamped prompt, counts, path, link and warnings', () => {
    const onViewRole = vi.fn();
    const { container } = renderSection({ onViewRole });
    const card = within(container).getByRole('region', { name: 'Role instructions' });
    expect(within(card).getByRole('heading', { name: 'Role instructions', level: 2 })).toBeTruthy();
    expect(within(card).getByText('Description and prompt for the TeamLead role, shared by every member with this role.')).toBeTruthy();
    expect(within(card).getByText('Unpacks features into phases, epics and stories.')).toBeTruthy();
    expect(card.querySelector('.role-instructions-preview pre')!.textContent).toBe('one\ntwo\nthree');
    expect(within(card).getByText('3 lines · 13 characters')).toBeTruthy();
    expect(card.querySelector('.role-instructions-footer')!.textContent).toBe('Saved to .agent-studio/roles/team-lead.md');
    expect(card.querySelector('svg[data-icon="document"]')).not.toBeNull();
    const link = within(card).getByRole('button', { name: 'View TeamLead in Roles' });
    expect(within(card).getByRole('list', { name: 'Role warnings' }).textContent).toContain('Role skill python-testing is missing');
    fireEvent.click(link);
    expect(onViewRole).toHaveBeenCalledWith('TeamLead');
  });

  it('clamps the preview to eight lines with a bottom fade', () => {
    renderSection();
    expect(css).toContain('.role-instructions-preview pre { max-height: 168px; overflow: hidden;');
    expect(css).toContain('.role-instructions-fade { position: absolute; left: 0; right: 0; bottom: 0; height: 56px; background: linear-gradient(to bottom, rgba(18, 20, 24, 0), #121418);');
    expect(css).toContain('.role-instructions-preview { position: relative; border: 1px solid #23262c; border-radius: 8px; background: #121418; overflow: hidden; }');
  });

  it('shows the existing explanation when instructions are missing or unreadable', () => {
    const view = renderSection({ roles: [role({ instructions: { state: 'none', path: null, text: null, sha256: null, bytes: null } })] });
    let card = within(view.container).getByRole('region', { name: 'Role instructions' });
    expect(within(card).getByText('No shared instruction file configured.')).toBeTruthy();
    expect(card.querySelector('.role-instructions-preview')).toBeNull();
    view.rerender(<RoleInstructionsSection {...view.props} roles={[role({ instructions: { state: 'invalid', path: null, text: null, sha256: null, bytes: null } })]} />);
    card = within(view.container).getByRole('region', { name: 'Role instructions' });
    expect(within(card).getByText('Shared instructions are unavailable because the configured file is invalid or unsafe.')).toBeTruthy();
  });

  it('shows the missing-file explanation when the instruction file is absent', () => {
    const view = renderSection({ roles: [role({ instructions: { state: 'missing', path: '.agent-studio/roles/team-lead.md', text: null, sha256: null, bytes: null } })] });
    const card = within(view.container).getByRole('region', { name: 'Role instructions' });
    expect(within(card).getByText('The configured instruction file is missing.')).toBeTruthy();
    expect(card.querySelector('.role-instructions-preview')).toBeNull();
    expect(card.querySelector('.role-instructions-footer')!.textContent).toBe('Saved to .agent-studio/roles/team-lead.md');
  });

  it('shows a truncated prompt with its counts and truncation notice', () => {
    const view = renderSection({ roles: [role({ instructions: { state: 'truncated', path: '.agent-studio/roles/team-lead.md', text: 'partial body', sha256: 'b'.repeat(64), bytes: 99999 } })] });
    const card = within(view.container).getByRole('region', { name: 'Role instructions' });
    expect(card.querySelector('.role-instructions-preview pre')!.textContent).toBe('partial body');
    expect(within(card).getByText('1 lines · 12 characters')).toBeTruthy();
    expect(within(card).getByText('Instruction content is truncated.')).toBeTruthy();
  });

  it('shows "No description" when the catalog role has no description', () => {
    const view = renderSection({ roles: [role({ description: null })] });
    const card = within(view.container).getByRole('region', { name: 'Role instructions' });
    expect(within(card).getByText('No description')).toBeTruthy();
  });

  it('omits the file footer when the role has no instruction file', () => {
    const view = renderSection({ roles: [role({ instructions: { state: 'none', path: null, text: null, sha256: null, bytes: null } })] });
    const card = within(view.container).getByRole('region', { name: 'Role instructions' });
    expect(card.querySelector('.role-instructions-footer')).toBeNull();
  });

  it('hides Edit when the role is not defined in the catalog', () => {
    const { container } = renderSection({
      member: member({ memberId: 'ghost', name: 'ghost', role: 'GhostRole', roleState: 'undefined', roleDescription: 'A role that is not saved.' }),
      roles: [role()],
    });
    const card = within(container).getByRole('region', { name: 'Role instructions' });
    expect(within(card).queryByRole('button', { name: 'Edit role instructions' })).toBeNull();
    expect(within(card).getByText('A role that is not saved.')).toBeTruthy();
    expect(within(card).getByText('Role not defined in roles.json')).toBeTruthy();
  });

  it('uses a neutral subtitle when the member has no role', () => {
    const { container } = renderSection({ member: member({ role: null, roleState: 'undefined', roleDescription: null }), roles: null });
    const card = within(container).getByRole('region', { name: 'Role instructions' });
    expect(card.textContent).not.toContain('No role role');
    expect(within(card).getByText("Description and prompt for this member's role, shared by every member with this role.")).toBeTruthy();
  });

  it('hides Edit and shows the catalog message when the catalog is unavailable', () => {
    const { container } = renderSection({ roles: null, roleCatalogMessage: 'The role catalog could not be loaded.' });
    const card = within(container).getByRole('region', { name: 'Role instructions' });
    expect(within(card).queryByRole('button', { name: 'Edit role instructions' })).toBeNull();
    expect(within(card).getByText('The role catalog could not be loaded.')).toBeTruthy();
  });

  it('falls back to the default explanation when the catalog is unavailable without a message', () => {
    const { container } = renderSection({ roles: null, roleCatalogMessage: null });
    const card = within(container).getByRole('region', { name: 'Role instructions' });
    expect(within(card).getByText('The role catalog is unavailable. Retry loading it to see role instructions.')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Edit role instructions' })).toBeNull();
  });

  it('disables Edit while a write is pending or the app is read-only', () => {
    const pending = renderSection({ pending: true });
    expect((within(pending.container).getByRole('button', { name: 'Edit role instructions' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const readOnly = renderSection({ readOnly: true });
    expect((within(readOnly.container).getByRole('button', { name: 'Edit role instructions' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens the edit dialog from the card action', async () => {
    const user = userEvent.setup();
    const { container } = renderSection();
    await user.click(within(container).getByRole('button', { name: 'Edit role instructions' }));
    expect(screen.getByRole('dialog', { name: 'Edit TeamLead instructions' })).toBeTruthy();
  });

  it('shows the new role instructions after the member role changes', () => {
    const first = role();
    const second = roleItem('QA', {
      name: 'QA',
      description: 'Validates changes.',
      instructions: { state: 'ok', path: '.agent-studio/roles/qa.md', text: 'verify\nthe\nchange', sha256: 'c'.repeat(64), bytes: 15 },
      warnings: [],
    });
    const fake = fakeManagement();
    const reloadRoles = vi.fn(async () => ok(rolesFixture({ sha256: SHA, items: [first, second] })));
    const base = { workspaceId: 'ws-a', management: fake.api, roles: [first, second], catalogSha: SHA, roleCatalogMessage: null, pending: false, readOnly: false, reloadRoles };
    const { container, rerender } = render(<RoleInstructionsSection {...base} member={member({ role: 'TeamLead', roleState: 'defined' })} />);
    let card = within(container).getByRole('region', { name: 'Role instructions' });
    expect(card.textContent).toContain('Unpacks features into phases, epics and stories.');
    expect(card.textContent).toContain('.agent-studio/roles/team-lead.md');
    rerender(<RoleInstructionsSection {...base} member={member({ role: 'QA', roleState: 'defined' })} />);
    card = within(container).getByRole('region', { name: 'Role instructions' });
    expect(card.textContent).toContain('Validates changes.');
    expect(card.textContent).toContain('verify');
    expect(card.textContent).toContain('.agent-studio/roles/qa.md');
    expect(card.textContent).not.toContain('Unpacks features into phases, epics and stories.');
    expect(card.textContent).not.toContain('.agent-studio/roles/team-lead.md');
  });

  it('replaces the open dialog with the new role when the member role changes', async () => {
    const user = userEvent.setup();
    const first = role();
    const second = roleItem('QA', {
      name: 'QA',
      description: 'Validates changes.',
      instructions: { state: 'ok', path: '.agent-studio/roles/qa.md', text: 'verify\nthe\nchange', sha256: 'c'.repeat(64), bytes: 15 },
      warnings: [],
    });
    const fake = fakeManagement();
    const reloadRoles = vi.fn(async () => ok(rolesFixture({ sha256: SHA, items: [first, second] })));
    const base = { workspaceId: 'ws-a', management: fake.api, roles: [first, second], catalogSha: SHA, roleCatalogMessage: null, pending: false, readOnly: false, reloadRoles };
    const { container, rerender } = render(<RoleInstructionsSection {...base} member={member({ role: 'TeamLead', roleState: 'defined' })} />);
    await user.click(within(container).getByRole('button', { name: 'Edit role instructions' }));
    expect(screen.getByRole('dialog', { name: 'Edit TeamLead instructions' })).toBeTruthy();
    rerender(<RoleInstructionsSection {...base} member={member({ role: 'QA', roleState: 'defined' })} />);
    const dialog = screen.getByRole('dialog', { name: 'Edit QA instructions' });
    expect((within(dialog).getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('verify\nthe\nchange');
    expect((within(dialog).getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Validates changes.');
    expect(dialog.querySelector('.dialog-subtitle')!.textContent).toBe('Saved to .agent-studio/roles/qa.md');
  });
});
