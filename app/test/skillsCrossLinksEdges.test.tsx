// @vitest-environment jsdom
import { act, cleanup, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardApi, RoleCatalogItem, Workspace } from '../src/renderer/api';
import { RolePage } from '../src/renderer/roles/RolePage';
import { WorkspaceShell } from '../src/renderer/shell/WorkspaceShell';
import { connectionFixture, deferred, fakeManagement } from './teamsFixtures';
import { roleItem, rolesFixture } from './rolesFixtures';
import { skillCatalog } from './skillFixtures';

afterEach(cleanup);
const workspace: Workspace = { id: 'a', name: 'A', path: '/a', exists: true, missing: false };
const okRoles = (data: ReturnType<typeof rolesFixture>) => ({ ok: true as const, data });
const okSkills = (data: ReturnType<typeof skillCatalog>) => ({ ok: true as const, data });

const dashboard: DashboardApi = {
  teams: vi.fn(async () => ({ ok: true, data: { workspace: '/a', teams: [], truncated: false } })),
  board: vi.fn(async () => ({
    ok: true,
    data: {
      workspace: '/a', currentPhase: { slug: 'default', name: 'Default', status: 'open' },
      columns: [], totals: { active: 0, blocked: 0, done: 0 }, tickets: [],
    },
  })),
  activity: vi.fn(async () => ({ ok: true, data: { workspace: '/a', dbId: 'activity-db', head: 0, entries: [] } })),
};

function roleWithSkills(skills: RoleCatalogItem['skills']): ReturnType<typeof rolesFixture> {
  return rolesFixture({
    items: [roleItem('Developer', { name: 'Developer', skills }), roleItem('TeamLead')],
    availableSkills: ['code-search', 'python-testing'],
  });
}

const nav = (view: ReturnType<typeof render>) => within(view.getByRole('navigation', { name: 'Workspace' }));

async function openRole(view: ReturnType<typeof render>, id = 'Developer') {
  const user = userEvent.setup();
  await user.click(nav(view).getByRole('button', { name: 'Roles' }));
  await view.findByRole('list', { name: 'Saved roles' });
  await user.click(view.getByRole('button', { name: `Open role ${id}` }));
  return view.findByRole('region', { name: 'Role details' });
}

describe('Skills cross-links edge cases', () => {
  it('role_skill_chips_open_with_enter_and_space', async () => {
    const onOpenSkill = vi.fn();
    const view = render(<RolePage
      role={roleItem('Developer', {
        name: 'Developer',
        skills: [{ id: 'code-search', state: 'ok' }, { id: 'legacy-notes', state: 'missing' }],
      })}
      editDisabled={false}
      editReason={null}
      onEditOverview={vi.fn()}
      onEditSkills={vi.fn()}
      onEditInstructions={vi.fn()}
      onBack={vi.fn()}
      onDelete={vi.fn()}
      deleteDisabledReason={null}
      onOpenSkill={onOpenSkill}
    />);
    const user = userEvent.setup();
    const okChip = view.getByRole('button', { name: 'Open skill code-search' });
    const missingChip = view.getByRole('button', { name: 'Open skill legacy-notes' });

    okChip.focus();
    await user.keyboard('{Enter}');
    missingChip.focus();
    await user.keyboard(' ');

    expect(onOpenSkill.mock.calls).toEqual([['code-search'], ['legacy-notes']]);
  });

  it('manage_skills_discards_an_unsaved_skills_draft_without_writing', async () => {
    const updateRole = vi.fn();
    const fake = fakeManagement({
      calls: {
        roles: vi.fn(async () => okRoles(roleWithSkills([{ id: 'code-search', state: 'ok' }]))),
        skills: vi.fn(async () => okSkills(skillCatalog())),
        updateRole,
      },
    });
    const view = render(
      <WorkspaceShell
        workspace={workspace}
        dashboard={dashboard}
        management={fake.api}
        connection={connectionFixture('connected')}
        onSwitchWorkspace={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    const region = await openRole(view);
    await user.click(within(region).getByRole('button', { name: 'Edit skills' }));
    const dialog = view.getByRole('dialog', { name: 'Edit skills' });
    await user.click(within(dialog).getByRole('checkbox', { name: 'python-testing' }));
    await user.click(within(dialog).getByRole('button', { name: 'Manage skills' }));

    expect(await view.findByRole('list', { name: 'Saved skills' })).toBeTruthy();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(updateRole).not.toHaveBeenCalled();
  });

  it('a_deep_linked_skill_does_not_stick_when_skills_is_opened_from_the_sidebar_again', async () => {
    const fake = fakeManagement({
      calls: {
        roles: vi.fn(async () => okRoles(roleWithSkills([{ id: 'code-search', state: 'ok' }]))),
        skills: vi.fn(async () => okSkills(skillCatalog())),
      },
    });
    const view = render(
      <WorkspaceShell
        workspace={workspace}
        dashboard={dashboard}
        management={fake.api}
        connection={connectionFixture('connected')}
        onSwitchWorkspace={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await openRole(view);
    await user.click(view.getByRole('button', { name: 'Open skill code-search' }));
    await view.findByRole('region', { name: 'Skill details' });

    await user.click(nav(view).getByRole('button', { name: 'Roles' }));
    await view.findByRole('list', { name: 'Saved roles' });
    await user.click(nav(view).getByRole('button', { name: 'Skills' }));

    await view.findByRole('list', { name: 'Saved skills' });
    expect(view.queryByRole('region', { name: 'Skill details' })).toBeNull();
    expect(view.queryByText(/is unavailable in this workspace\./)).toBeNull();
    await waitFor(() => expect(view.getByRole('heading', { level: 1, name: 'Skills' })).toBeTruthy());
  });

  it('manage_skills_is_a_link_style_action_in_the_edit_skills_footer', async () => {
    const fake = fakeManagement({
      calls: {
        roles: vi.fn(async () => okRoles(roleWithSkills([{ id: 'code-search', state: 'ok' }]))),
        skills: vi.fn(async () => okSkills(skillCatalog())),
      },
    });
    const view = render(
      <WorkspaceShell
        workspace={workspace}
        dashboard={dashboard}
        management={fake.api}
        connection={connectionFixture('connected')}
        onSwitchWorkspace={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    const region = await openRole(view);
    await user.click(within(region).getByRole('button', { name: 'Edit skills' }));
    const dialog = view.getByRole('dialog', { name: 'Edit skills' });
    const footer = dialog.querySelector<HTMLElement>('.dialog-footer');
    expect(footer).not.toBeNull();
    const manage = within(footer!).getByRole('button', { name: 'Manage skills' });
    expect(manage.closest('.dialog-footer-leading')).not.toBeNull();
    expect(manage.className).toContain('dialog-action-link');
    // The normal save/cancel actions stay in the footer beside it.
    expect(within(footer!).getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(within(footer!).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('a_deep_link_opens_the_skill_page_only_after_the_catalog_finishes_loading', async () => {
    const delayed = deferred<{ ok: true; data: ReturnType<typeof skillCatalog> }>();
    const skills = vi.fn(() => delayed.promise);
    const fake = fakeManagement({
      calls: {
        roles: vi.fn(async () => okRoles(roleWithSkills([{ id: 'code-search', state: 'ok' }]))),
        skills,
      },
    });
    const view = render(
      <WorkspaceShell
        workspace={workspace}
        dashboard={dashboard}
        management={fake.api}
        connection={connectionFixture('connected')}
        onSwitchWorkspace={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await openRole(view);
    await user.click(view.getByRole('button', { name: 'Open skill code-search' }));

    // The catalog is still loading: the deep link must wait, not show a missing page.
    expect(view.queryByRole('region', { name: 'Skill details' })).toBeNull();
    expect(view.getByText('Loading skills…')).toBeTruthy();

    await act(async () => { delayed.resolve(okSkills(skillCatalog())); });
    const page = await view.findByRole('region', { name: 'Skill details' });
    expect(within(page).getByRole('heading', { level: 1, name: 'code-search' })).toBeTruthy();
  });

  it('back_from_a_deep_linked_skill_page_focuses_its_row_in_the_list', async () => {
    const fake = fakeManagement({
      calls: {
        roles: vi.fn(async () => okRoles(roleWithSkills([{ id: 'code-search', state: 'ok' }]))),
        skills: vi.fn(async () => okSkills(skillCatalog())),
      },
    });
    const view = render(
      <WorkspaceShell
        workspace={workspace}
        dashboard={dashboard}
        management={fake.api}
        connection={connectionFixture('connected')}
        onSwitchWorkspace={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await openRole(view);
    await user.click(view.getByRole('button', { name: 'Open skill code-search' }));
    const page = await view.findByRole('region', { name: 'Skill details' });
    await user.click(within(page).getByRole('button', { name: 'Skills' }));
    await view.findByRole('list', { name: 'Saved skills' });
    await waitFor(() => expect(document.activeElement).toBe(view.getByRole('button', { name: 'Open skill code-search' })));
  });
});
