// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConnectionStatus,
  ManagementApi,
  ManagementResult,
  RoleCatalogList,
  SkillCatalogList,
  SkillRolesResult,
  Workspace,
} from '../src/renderer/api';
import { SkillPage } from '../src/renderer/skills/SkillPage';
import { SkillsScreen } from '../src/renderer/skills/SkillsScreen';
import {
  SKILL_ROLES_CONFLICT_MESSAGE,
  SKILL_ROLES_CREATE_FIRST,
  SKILL_ROLES_GENERIC_ERROR,
  SKILL_ROLES_ROLE_MISSING_MESSAGE,
  SKILL_ROLES_SKILL_MISSING_MESSAGE,
  skillRolesEditReason,
} from '../src/renderer/skills/SkillRolesDialog';
import { connectionFixture, deferred } from './teamsFixtures';
import {
  SAMPLE_ROLES,
  SKILL_LIMITS,
  SKILLS_SHA,
  SKILL_TEXT,
  fakeSkillManagement,
  skillItem,
  type FakeSkillInitial,
} from './skillFixtures';

afterEach(cleanup);

const workspace: Workspace = { id: 'a', name: 'A', path: '/a', exists: true, missing: false };
const ok = <T,>(data: T): ManagementResult<T> => ({ ok: true as const, data });
const fail = <T = never,>(code: string, message: string): ManagementResult<T> => ({
  ok: false as const,
  error: { code, message, retryable: false },
});

function setup(
  initial: FakeSkillInitial = {},
  connection: ConnectionStatus = connectionFixture('connected'),
  overrides: Record<string, unknown> = {},
) {
  const fake = fakeSkillManagement(initial);
  const skills = vi.fn((id: string) => fake.skills(id));
  const roles = vi.fn((id: string) => fake.roles(id));
  const api = { ...fake, skills, roles, ...overrides } as unknown as ManagementApi;
  const view = render(<main>
    <SkillsScreen workspace={workspace} management={api} connection={connection} />
  </main>);
  return { fake, api, skills, roles, view };
}

const list = (view: ReturnType<typeof render>) => view.getByRole('list', { name: 'Saved skills' });
const row = (view: ReturnType<typeof render>, id: string) =>
  within(list(view)).getAllByRole('button').find(button => button.getAttribute('data-skill-id') === id)!;
const page = (view: ReturnType<typeof render>) => within(view.getByRole('region', { name: 'Skill details' }));
const card = (view: ReturnType<typeof render>, className: string) => {
  const element = view.container.querySelector(`.${className}`);
  expect(element).toBeTruthy();
  return element as HTMLElement;
};

async function openSkill(view: ReturnType<typeof render>, id = 'code-search') {
  await view.findByRole('list', { name: 'Saved skills' });
  fireEvent.click(row(view, id));
  await view.findByRole('region', { name: 'Skill details' });
}

const cardEdit = (view: ReturnType<typeof render>) =>
  within(card(view, 'skills-usedby-card')).getByRole('button', { name: 'Edit roles that use this skill' }) as HTMLButtonElement;
const missingEdit = (view: ReturnType<typeof render>) =>
  within(card(view, 'skills-missing-card')).getByRole('button', { name: 'Edit roles' }) as HTMLButtonElement;
const dialog = () => document.querySelector('.skill-roles-dialog') as HTMLElement;
const checkboxRows = () => within(dialog()).getAllByRole('checkbox') as HTMLButtonElement[];
const rowNamed = (name: string) => checkboxRows().find(element => within(element).queryByText(name) !== null)!;
const saveButton = () => within(dialog()).getByRole('button', { name: /^(Save|Saving…)$/ }) as HTMLButtonElement;

async function openRoles(view: ReturnType<typeof render>, id = 'code-search', fromRow = false) {
  await openSkill(view, id);
  const button = fromRow ? missingEdit(view) : cardEdit(view);
  await waitFor(() => expect(button.disabled).toBe(false));
  button.focus();
  fireEvent.click(button);
  return view.findByRole('dialog', { name: `Roles that use ${id}` });
}

function reasonFor(button: HTMLButtonElement): string | null {
  const id = button.getAttribute('aria-describedby');
  return id === null ? null : document.getElementById(id)?.textContent ?? null;
}

describe('Roles that use a skill entry points', () => {
  it('opens the 560 px dialog from the Used by roles card with every catalog role and its saved state', async () => {
    const { view } = setup();
    const opened = await openRoles(view);
    expect(opened.getAttribute('style')).toContain('width: min(560px, 100%)');
    expect(within(opened).getByRole('heading', { name: 'Roles that use code-search' })).toBeTruthy();
    expect(within(opened).getByText("Adds or removes the skill in each role's list.")).toBeTruthy();
    expect(within(opened).getByRole('group', { name: 'Roles' })).toBeTruthy();
    expect(opened.querySelector('.dialog-footer-note')?.textContent).toBe('Saved to roles.json');
    expect(checkboxRows().map(item => item.textContent)).toEqual([
      'TeamLeadUses this skill',
      'DeveloperUses this skill',
      'SeniorDeveloperDoes not use it',
      'QAUses this skill',
      'ReviewerUses this skill',
      'ProductOwnerDoes not use it',
    ]);
    expect(checkboxRows().map(item => item.getAttribute('aria-checked'))).toEqual(['true', 'true', 'false', 'true', 'true', 'false']);
    // The blue tick is decoration; the row's aria-checked carries the state.
    expect(rowNamed('TeamLead').querySelector('.skill-roles-check')?.getAttribute('aria-hidden')).toBe('true');
    expect(rowNamed('TeamLead').querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().classList.contains('dialog-action-primary')).toBe(true);
    expect(document.activeElement).toBe(checkboxRows()[0]);
  });

  it('opens the same dialog from the missing skill row and its Used by roles header', async () => {
    const { view } = setup();
    await openSkill(view, 'legacy-notes');
    const header = cardEdit(view);
    const rowEdit = missingEdit(view);
    expect(header.disabled).toBe(false);
    expect(rowEdit.disabled).toBe(false);

    const user = userEvent.setup();
    await user.click(rowEdit);
    expect(await view.findByRole('dialog', { name: 'Roles that use legacy-notes' })).toBeTruthy();
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(dialog()).toBeNull());

    await user.click(header);
    expect(await view.findByRole('dialog', { name: 'Roles that use legacy-notes' })).toBeTruthy();
  });

  it('disables the entry point while the backend is disconnected, with the reason attached', async () => {
    const { view } = setup({}, connectionFixture('lost'));
    await openSkill(view);
    const button = cardEdit(view);
    expect(button.disabled).toBe(true);
    expect(reasonFor(button)).toBe('Connect to the backend to edit which roles use this skill.');
  });

  it('waits for the roles catalog to load and then enables the action', async () => {
    const fake = fakeSkillManagement();
    const gate = deferred<ManagementResult<RoleCatalogList>>();
    const roles = vi.fn(() => gate.promise);
    const view = render(<main><SkillsScreen workspace={workspace} management={{ ...fake, roles } as unknown as ManagementApi} /></main>);
    await openSkill(view);
    const button = cardEdit(view);
    expect(button.disabled).toBe(true);
    expect(reasonFor(button)).toBe('Role changes are unavailable until the roles catalog loads.');

    gate.resolve(await fake.roles('a'));
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it('names the roles section error and retries it from the skills screen', async () => {
    const fake = fakeSkillManagement();
    let attempts = 0;
    const roles = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) return fail<RoleCatalogList>('INTERNAL', 'roles.json is unreadable');
      return fake.roles('a');
    });
    const view = render(<main><SkillsScreen workspace={workspace} management={{ ...fake, roles } as unknown as ManagementApi} /></main>);
    await openSkill(view);

    await waitFor(() => expect(view.container.querySelector('.skills-roles-error')).toBeTruthy());
    const banner = view.container.querySelector('.skills-roles-error') as HTMLElement;
    expect(banner.textContent).toContain('roles.json is unreadable');
    const button = cardEdit(view);
    await waitFor(() => expect(reasonFor(button)).toBe(
      'Role changes are unavailable: INTERNAL: roles.json is unreadable',
    ));
    expect(button.disabled).toBe(true);

    const user = userEvent.setup();
    await user.click(within(banner).getByRole('button', { name: 'Retry loading roles' }));
    await waitFor(() => expect(cardEdit(view).disabled).toBe(false));
    expect(attempts).toBe(2);
    expect(view.container.querySelector('.skills-roles-error')).toBeNull();
  });

  it('disables the action when the roles catalog has problems or is stale', async () => {
    const fake = fakeSkillManagement();
    const base = await fake.roles('a');
    if (!base.ok) throw new Error('fixture failed');
    const invalid = vi.fn(async () => ok({
      ...base.data,
      state: 'invalid' as const,
      problems: [{ path: '.agent-studio/roles.json', message: 'invalid json' }],
    }));
    const first = setup({}, connectionFixture('connected'), { roles: invalid });
    await openSkill(first.view);
    const invalidButton = cardEdit(first.view);
    await waitFor(() => expect(reasonFor(invalidButton)).toBe('Role changes are unavailable while the roles catalog has problems.'));
    expect(invalidButton.disabled).toBe(true);

    cleanup();
    const stale = vi.fn(async () => ok({ ...base.data, sha256: 'f'.repeat(64) }));
    const second = setup({}, connectionFixture('connected'), { roles: stale });
    await openSkill(second.view);
    const staleButton = cardEdit(second.view);
    await waitFor(() => expect(reasonFor(staleButton)).toBe('Role changes are unavailable until the roles catalog is reloaded.'));
    expect(staleButton.disabled).toBe(true);
  });

  it('disables both missing-skill entry points when no roles catalog exists', async () => {
    const fake = fakeSkillManagement();
    const base = await fake.roles('a');
    if (!base.ok) throw new Error('fixture failed');
    const missing = vi.fn(async () => ok({ ...base.data, state: 'missing' as const }));
    const { view } = setup({}, connectionFixture('connected'), { roles: missing });
    await openSkill(view, 'legacy-notes');

    const header = cardEdit(view);
    const rowButton = missingEdit(view);
    await waitFor(() => expect(reasonFor(rowButton)).toBe('Role changes are unavailable until a roles catalog exists.'));
    expect(header.disabled).toBe(true);
    expect(reasonFor(header)).toBe('Role changes are unavailable until a roles catalog exists.');
    expect(rowButton.disabled).toBe(true);
  });

  it('disables the card action while the skills list is not current', async () => {
    const fake = fakeSkillManagement();
    const catalog = await fake.roles('a');
    if (!catalog.ok) throw new Error('fixture failed');
    const view = render(<SkillPage
      skill={skillItem()}
      limits={SKILL_LIMITS}
      management={fake as unknown as ManagementApi}
      workspaceId="a"
      onBack={() => {}}
      rolesCatalog={catalog.data}
      skillsReady={false}
      rolesReady={true}
      rolesSha256={SKILLS_SHA}
    />);

    const button = view.getByRole('button', { name: 'Edit roles that use this skill' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(reasonFor(button)).toBe('Role changes are unavailable until the skills list is current.');
  });
});

describe('Skill roles edit reason', () => {
  async function readyCatalog(): Promise<RoleCatalogList> {
    const result = await fakeSkillManagement().roles('a');
    if (!result.ok) throw new Error('fixture failed');
    return result.data;
  }

  async function baseArgs() {
    const catalog = await readyCatalog();
    return {
      connected: true,
      pending: false,
      skillsReady: true,
      rolesReady: true,
      roles: catalog,
      rolesSha256: catalog.sha256,
    };
  }

  it('allows editing only when both catalogs are fresh, usable and agree on roles.json', async () => {
    expect(skillRolesEditReason(await baseArgs())).toBeNull();
  });

  it('reports a pending write before anything else', async () => {
    const base = await baseArgs();
    expect(skillRolesEditReason({ ...base, pending: true, connected: false })).toBe('Saving roles; wait for it to finish.');
  });

  it('reports a disconnected backend or a skills list that is not current', async () => {
    const base = await baseArgs();
    expect(skillRolesEditReason({ ...base, connected: false })).toBe('Connect to the backend to edit which roles use this skill.');
    expect(skillRolesEditReason({ ...base, skillsReady: false })).toBe('Role changes are unavailable until the skills list is current.');
  });

  it('reports a roles catalog that has not loaded, is missing or has problems', async () => {
    const base = await baseArgs();
    expect(skillRolesEditReason({ ...base, rolesReady: false })).toBe('Role changes are unavailable until the roles catalog loads.');
    expect(skillRolesEditReason({ ...base, roles: null })).toBe('Role changes are unavailable until the roles catalog loads.');
    expect(skillRolesEditReason({ ...base, roles: { ...base.roles!, state: 'missing' } })).toBe('Role changes are unavailable until a roles catalog exists.');
    expect(skillRolesEditReason({
      ...base,
      roles: { ...base.roles!, state: 'invalid', problems: [{ path: '.agent-studio/roles.json', message: 'invalid json' }] },
    })).toBe('Role changes are unavailable while the roles catalog has problems.');
    // An "ok" catalog that still reports problems is not usable either.
    expect(skillRolesEditReason({
      ...base,
      roles: {
        ...base.roles!,
        state: 'ok',
        problems: [{ path: 'skills/broken/SKILL.md', message: 'Skill is unreadable.' }],
      },
    })).toBe('Role changes are unavailable while the roles catalog has problems.');
  });

  it('names a roles section failure instead of saying the catalog is still loading', async () => {
    const base = await baseArgs();
    expect(skillRolesEditReason({
      ...base,
      roles: null,
      rolesReady: false,
      rolesError: { code: 'INTERNAL', message: 'roles.json is unreadable', retryable: true },
    })).toBe('Role changes are unavailable: INTERNAL: roles.json is unreadable');
  });

  it('waits for a roles.json token that matches the skills list', async () => {
    const base = await baseArgs();
    expect(skillRolesEditReason({ ...base, rolesSha256: null })).toBe('Role changes are unavailable until the roles catalog is reloaded.');
    expect(skillRolesEditReason({ ...base, rolesSha256: 'f'.repeat(64) })).toBe('Role changes are unavailable until the roles catalog is reloaded.');
  });
});

describe('Roles dialog selection', () => {
  it('toggles with the mouse and follows the draft in each row', async () => {
    const { view } = setup();
    await openRoles(view);
    const user = userEvent.setup();
    const senior = rowNamed('SeniorDeveloper');
    await user.click(senior);
    expect(senior.getAttribute('aria-checked')).toBe('true');
    expect(within(senior).getByText('Uses this skill')).toBeTruthy();
    expect(senior.classList.contains('is-checked')).toBe(true);
    expect(saveButton().disabled).toBe(false);

    await user.click(senior);
    expect(senior.getAttribute('aria-checked')).toBe('false');
    expect(within(senior).getByText('Does not use it')).toBeTruthy();
    expect(senior.classList.contains('is-checked')).toBe(false);
    expect(saveButton().disabled).toBe(true);
  });

  it('toggles with Space and Enter and keeps every row in the Tab order', async () => {
    const { view } = setup();
    await openRoles(view);
    const user = userEvent.setup();
    const first = checkboxRows()[0];
    expect(document.activeElement).toBe(first);
    await user.tab();
    expect(document.activeElement).toBe(checkboxRows()[1]);

    const senior = rowNamed('SeniorDeveloper');
    senior.focus();
    await user.keyboard(' ');
    expect(senior.getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{Enter}');
    expect(senior.getAttribute('aria-checked')).toBe('false');
  });

  it('keeps Save disabled until the checked set differs from the saved set', async () => {
    const { view } = setup();
    await openRoles(view);
    const user = userEvent.setup();
    expect(saveButton().disabled).toBe(true);
    await user.click(rowNamed('ProductOwner'));
    expect(saveButton().disabled).toBe(false);
    await user.click(rowNamed('ProductOwner'));
    expect(saveButton().disabled).toBe(true);

    // Unchecking and rechecking an already used role also returns to the saved set.
    await user.click(rowNamed('Reviewer'));
    expect(saveButton().disabled).toBe(false);
    await user.click(rowNamed('Reviewer'));
    expect(saveButton().disabled).toBe(true);
  });
});

describe('Roles dialog saving', () => {
  it('sends only additions with the full checked list and the skills-list roles token', async () => {
    const { view, fake } = setup();
    await openRoles(view);
    const user = userEvent.setup();
    await user.click(rowNamed('SeniorDeveloper'));
    await user.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());

    expect(fake.calls.find(call => call.method === 'updateSkillRoles')?.args).toEqual([
      'a', 'code-search', ['TeamLead', 'Developer', 'SeniorDeveloper', 'QA', 'Reviewer'], SKILLS_SHA,
    ]);
  });

  it('sends only removals', async () => {
    const { view, fake } = setup();
    await openRoles(view);
    const user = userEvent.setup();
    await user.click(rowNamed('Reviewer'));
    await user.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(fake.calls.find(call => call.method === 'updateSkillRoles')?.args).toEqual([
      'a', 'code-search', ['TeamLead', 'Developer', 'QA'], SKILLS_SHA,
    ]);
  });

  it('sends additions and removals together in catalog order', async () => {
    const { view, fake } = setup();
    await openRoles(view);
    const user = userEvent.setup();
    await user.click(rowNamed('Reviewer'));
    await user.click(rowNamed('SeniorDeveloper'));
    await user.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(fake.calls.find(call => call.method === 'updateSkillRoles')?.args).toEqual([
      'a', 'code-search', ['TeamLead', 'Developer', 'SeniorDeveloper', 'QA'], SKILLS_SHA,
    ]);
  });

  it('can remove every role and send an empty checked list', async () => {
    const { view, fake } = setup();
    await openRoles(view);
    const user = userEvent.setup();
    for (const name of ['TeamLead', 'Developer', 'QA', 'Reviewer']) await user.click(rowNamed(name));
    expect(saveButton().disabled).toBe(false);
    await user.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(fake.calls.find(call => call.method === 'updateSkillRoles')?.args).toEqual([
      'a', 'code-search', [], SKILLS_SHA,
    ]);
  });

  it('reloads both catalogs, refreshes the card and announces the save before returning focus', async () => {
    const { view, skills, roles } = setup();
    const user = userEvent.setup();
    await openRoles(view);
    const opener = cardEdit(view);
    opener.focus();
    await user.click(rowNamed('SeniorDeveloper'));
    await user.click(saveButton());

    await waitFor(() => expect(dialog()).toBeNull());
    expect(view.getAllByText('Saved roles for code-search.')).toHaveLength(1);
    await waitFor(() => expect(skills).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(roles).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(card(view, 'skills-usedby-card')).getByText('SeniorDeveloper')).toBeTruthy());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('uses the refreshed context sizes and marks a role over 80 percent amber', async () => {
    const { view } = setup({
      roles: [
        { id: 'Developer', name: 'Developer', contextBaseBytes: 1000, skills: ['code-search'] },
        { id: 'QA', name: 'QA', contextBaseBytes: 78000, skills: [] },
      ],
    });
    await openRoles(view);
    const user = userEvent.setup();
    await user.click(rowNamed('QA'));
    await user.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());

    const usedBy = card(view, 'skills-usedby-card');
    await waitFor(() => expect(within(usedBy).getByText('QA')).toBeTruthy());
    const context = within(usedBy).getByText('Context 77.0 KB of 96 KiB');
    expect(context.classList.contains('is-warning')).toBe(true);
  });

  it('applies the amber threshold to the refreshed sizes: exactly 80 percent stays plain, above it warns', async () => {
    // formatRoleContext warns only above 80% of 96 KiB (78,643.2 bytes).
    const skillBytes = new TextEncoder().encode(SKILL_TEXT['code-search']).length;
    const atLimit = Math.floor(SKILL_LIMITS.roleContextBytes * 0.8) - skillBytes;
    const { view } = setup({
      roles: [
        { id: 'AtLimit', name: 'AtLimit', contextBaseBytes: atLimit, skills: [] },
        { id: 'OverLimit', name: 'OverLimit', contextBaseBytes: atLimit + 1, skills: [] },
      ],
    });
    await openRoles(view);
    const user = userEvent.setup();
    await user.click(rowNamed('AtLimit'));
    await user.click(rowNamed('OverLimit'));
    await user.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());

    const usedBy = card(view, 'skills-usedby-card');
    const contextFor = (name: string) => {
      const item = within(usedBy).getAllByRole('listitem')
        .find(element => within(element).queryByText(name) !== null)!;
      return item.querySelector('.skills-usedby-context') as HTMLElement;
    };
    await waitFor(() => expect(contextFor('AtLimit').textContent).toBe('Context 76.8 KB of 96 KiB'));
    expect(contextFor('AtLimit').classList.contains('is-warning')).toBe(false);
    expect(contextFor('OverLimit').textContent).toBe('Context 76.8 KB of 96 KiB');
    expect(contextFor('OverLimit').classList.contains('is-warning')).toBe(true);
  });

  it('refreshes the skills list row after saving so its role chips match', async () => {
    const { view, skills, roles } = setup();
    await openRoles(view);
    const user = userEvent.setup();
    await user.click(rowNamed('TeamLead'));
    await user.click(rowNamed('Reviewer'));
    await user.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());
    await waitFor(() => expect(skills).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(roles).toHaveBeenCalledTimes(2));

    // Back on the list, the reloaded catalog drives the row's role chips.
    await user.click(view.getByRole('button', { name: 'Skills' }));
    const target = row(view, 'code-search');
    const chips = Array.from(target.querySelectorAll('.skills-role-chip')).map(chip => chip.textContent);
    expect(chips).toEqual(['Developer', 'QA']);
  });

  it('drops a removed role from the Used by card after saving', async () => {
    const { view } = setup();
    await openRoles(view);
    const user = userEvent.setup();
    await user.click(rowNamed('Reviewer'));
    await user.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());

    const usedBy = card(view, 'skills-usedby-card');
    await waitFor(() => expect(within(usedBy).queryByText('Reviewer')).toBeNull());
    expect(within(usedBy).getByText('QA')).toBeTruthy();
    expect(view.getByText('Used by 3 roles')).toBeTruthy();
  });
});

describe('Roles dialog for a missing skill', () => {
  it('lists every role, disables adding, enables removing and explains why', async () => {
    const { view, fake } = setup();
    await openRoles(view, 'legacy-notes', true);
    expect(checkboxRows()).toHaveLength(SAMPLE_ROLES.length);
    const senior = rowNamed('SeniorDeveloper');
    expect(senior.getAttribute('aria-checked')).toBe('true');
    expect(senior.disabled).toBe(false);
    for (const name of ['TeamLead', 'Developer', 'QA', 'Reviewer', 'ProductOwner']) {
      const missing = rowNamed(name);
      expect(missing.disabled).toBe(true);
      expect(missing.getAttribute('aria-checked')).toBe('false');
      expect(within(missing).getByText(SKILL_ROLES_CREATE_FIRST)).toBeTruthy();
    }

    const user = userEvent.setup();
    await user.click(senior);
    expect(saveButton().disabled).toBe(false);
    await user.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(fake.calls.find(call => call.method === 'updateSkillRoles')?.args).toEqual([
      'a', 'legacy-notes', [], SKILLS_SHA,
    ]);
  });

  it('does not add a role to a missing skill even when its disabled row is clicked', async () => {
    const { view } = setup();
    await openRoles(view, 'legacy-notes', true);
    const user = userEvent.setup();
    const developer = rowNamed('Developer');
    await user.click(developer);
    expect(developer.getAttribute('aria-checked')).toBe('false');
    expect(saveButton().disabled).toBe(true);
  });

  it('returns focus to the row Edit roles button after saving', async () => {
    // Keep the missing skill listed by another role so its page stays open after the save.
    const { view } = setup({
      roles: [
        { id: 'SeniorDeveloper', name: 'SeniorDeveloper', skills: ['legacy-notes'] },
        { id: 'Developer', name: 'Developer', skills: ['legacy-notes'] },
      ],
    });
    await openRoles(view, 'legacy-notes', true);
    const opener = missingEdit(view);
    opener.focus();
    const user = userEvent.setup();
    await user.click(rowNamed('SeniorDeveloper'));
    await user.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe('Roles dialog failures', () => {
  it('disables every row and the actions while the write is pending', async () => {
    const gate = deferred<ManagementResult<SkillRolesResult>>();
    const updateSkillRoles = vi.fn(() => gate.promise);
    const { view } = setup({}, connectionFixture('connected'), { updateSkillRoles });
    await openRoles(view);
    const user = userEvent.setup();
    await user.click(rowNamed('SeniorDeveloper'));
    await user.click(saveButton());

    await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'Saving…' })).toBeTruthy());
    expect(checkboxRows().every(item => item.disabled)).toBe(true);
    expect((within(dialog()).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    expect(cardEdit(view).disabled).toBe(true);
    expect(reasonFor(cardEdit(view))).toBe('Saving roles; wait for it to finish.');

    gate.resolve(ok({
      workspace: '/work/a', skill: 'code-search', roles: ['TeamLead', 'Developer', 'SeniorDeveloper', 'QA', 'Reviewer'],
      added: ['SeniorDeveloper'], removed: [], rolesSha256: 'd'.repeat(64),
    }));
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it('reports CONFIG_CHANGED, reloads both lists and preserves checks where the role still exists', async () => {
    let roleLoads = 0;
    const fake = fakeSkillManagement();
    const roles = vi.fn(async () => {
      roleLoads += 1;
      const base = await fake.roles('a');
      if (!base.ok || roleLoads === 1) return base;
      return ok({ ...base.data, items: base.data.items.filter(item => item.id !== 'Reviewer') });
    });
    const skills = vi.fn((id: string) => fake.skills(id));
    const view = render(<main><SkillsScreen workspace={workspace} management={{ ...fake, skills, roles } as unknown as ManagementApi} /></main>);
    await openRoles(view);

    // Another writer removes most roles while the dialog is open.
    await fake.updateSkillRoles('a', 'code-search', ['Developer', 'QA'], SKILLS_SHA);
    const user = userEvent.setup();
    await user.click(rowNamed('ProductOwner'));
    await user.click(saveButton());

    const alert = await within(dialog()).findByRole('alert');
    expect(alert.textContent).toContain(SKILL_ROLES_CONFLICT_MESSAGE);
    expect(document.activeElement).toBe(alert);
    await user.click(within(dialog()).getByRole('button', { name: 'Reload latest' }));
    await within(dialog()).findByText('Roles were reloaded. Review your selection, then save again.');
    // A successful reload dismisses the conflict instead of leaving its alert (and
    // a second Reload latest action) next to the reloaded notice.
    expect(within(dialog()).queryByRole('alert')).toBeNull();
    expect(skills).toHaveBeenCalledTimes(2);
    expect(roles).toHaveBeenCalledTimes(2);
    // Reviewer is gone from the reloaded catalog; the other draft checks stay.
    expect(checkboxRows().some(item => within(item).queryByText('Reviewer') !== null)).toBe(false);
    expect(rowNamed('ProductOwner').getAttribute('aria-checked')).toBe('true');
    expect(rowNamed('TeamLead').getAttribute('aria-checked')).toBe('true');

    // Saving now uses the reloaded token and never sends the role that vanished.
    await user.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());
    const writes = fake.calls.filter(call => call.method === 'updateSkillRoles');
    expect(writes.at(-1)?.args).toEqual([
      'a', 'code-search', ['TeamLead', 'Developer', 'QA', 'ProductOwner'], expect.any(String),
    ]);
    expect(writes.at(-1)?.args[3]).not.toBe(SKILLS_SHA);
  });

  it('keeps the conflict and Reload latest while the person edits the draft', async () => {
    let roleLoads = 0;
    const fake = fakeSkillManagement();
    const roles = vi.fn(async () => {
      roleLoads += 1;
      const base = await fake.roles('a');
      if (!base.ok || roleLoads === 1) return base;
      return ok({ ...base.data, items: base.data.items.filter(item => item.id !== 'Reviewer') });
    });
    const skills = vi.fn((id: string) => fake.skills(id));
    const view = render(<main><SkillsScreen
      workspace={workspace}
      management={{ ...fake, skills, roles } as unknown as ManagementApi}
    /></main>);
    await openRoles(view);

    await fake.updateSkillRoles('a', 'code-search', ['Developer', 'QA'], SKILLS_SHA);
    const user = userEvent.setup();
    await user.click(rowNamed('ProductOwner'));
    await user.click(saveButton());
    const alert = await within(dialog()).findByRole('alert');
    expect(alert.textContent).toContain(SKILL_ROLES_CONFLICT_MESSAGE);

    // Editing the draft keeps the stale-token conflict and its reload action.
    await user.click(rowNamed('TeamLead'));
    expect(rowNamed('TeamLead').getAttribute('aria-checked')).toBe('false');
    expect(within(dialog()).getByRole('alert').textContent).toContain(SKILL_ROLES_CONFLICT_MESSAGE);
    expect(within(dialog()).getByRole('button', { name: 'Reload latest' })).toBeTruthy();

    await user.click(within(dialog()).getByRole('button', { name: 'Reload latest' }));
    await within(dialog()).findByText('Roles were reloaded. Review your selection, then save again.');
    expect(within(dialog()).queryByRole('alert')).toBeNull();
  });

  it('reports ROLE_NOT_FOUND, reloads both lists and clears the message afterwards', async () => {
    const fake = fakeSkillManagement();
    const gate = deferred<ManagementResult<SkillCatalogList>>();
    let skillLoads = 0;
    const skills = vi.fn((id: string) => {
      skillLoads += 1;
      return skillLoads === 1 ? fake.skills(id) : gate.promise;
    });
    const roles = vi.fn((id: string) => fake.roles(id));
    const updateSkillRoles = vi.fn(async () => fail<SkillRolesResult>('ROLE_NOT_FOUND', 'Role gone'));
    const view = render(<main><SkillsScreen
      workspace={workspace}
      management={{ ...fake, skills, roles, updateSkillRoles } as unknown as ManagementApi}
    /></main>);
    await openRoles(view);
    const user = userEvent.setup();
    await user.click(rowNamed('SeniorDeveloper'));
    await user.click(saveButton());

    const alert = await within(dialog()).findByRole('alert');
    expect(alert.textContent).toContain(SKILL_ROLES_ROLE_MISSING_MESSAGE);
    expect(document.activeElement).toBe(alert);
    await waitFor(() => expect(skills).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(roles).toHaveBeenCalledTimes(2));

    gate.resolve(await fake.skills('a'));
    await within(dialog()).findByText('Roles were reloaded. Review your selection, then save again.');
    expect(within(dialog()).queryByRole('alert')).toBeNull();
  });

  it('reports SKILL_NOT_FOUND and stays open when a reload finds the skill file gone', async () => {
    const fake = fakeSkillManagement();
    const base = await fake.skills('a');
    if (!base.ok) throw new Error('fixture failed');
    let skillLoads = 0;
    const skills = vi.fn(async () => {
      skillLoads += 1;
      if (skillLoads === 1) return base;
      // The file disappeared but the roles still list it, so the catalog keeps
      // the skill as missing rather than dropping it from the list.
      return ok({
        ...base.data,
        skills: base.data.skills.map(item => item.id === 'code-search'
          ? { ...item, state: 'missing' as const, title: null, bytes: null, sha256: null }
          : item),
      });
    });
    const roles = vi.fn((id: string) => fake.roles(id));
    const view = render(<main><SkillsScreen
      workspace={workspace}
      management={{ ...fake, skills, roles } as unknown as ManagementApi}
    /></main>);
    await openRoles(view);

    // Another writer changes roles.json, so the save conflicts.
    await fake.updateSkillRoles('a', 'code-search', ['TeamLead', 'Developer', 'QA'], SKILLS_SHA);
    const user = userEvent.setup();
    await user.click(rowNamed('ProductOwner'));
    await user.click(saveButton());
    expect((await within(dialog()).findByRole('alert')).textContent).toContain(SKILL_ROLES_CONFLICT_MESSAGE);

    // The skill disappears before the reload: the fresh catalog must win, not
    // the stale skill the dialog was opened with.
    await user.click(within(dialog()).getByRole('button', { name: 'Reload latest' }));
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toContain(SKILL_ROLES_SKILL_MISSING_MESSAGE));
    const alert = within(dialog()).getByRole('alert');
    expect(alert.textContent).not.toContain(SKILL_ROLES_CONFLICT_MESSAGE);
    expect(within(dialog()).queryByText('Roles were reloaded. Review your selection, then save again.')).toBeNull();
    expect(document.activeElement).toBe(alert);
    expect(dialog()).toBeTruthy();
  });

  it('reports a deleted skill file without closing the dialog', async () => {
    const updateSkillRoles = vi.fn(async () => fail<SkillRolesResult>('SKILL_NOT_FOUND', 'Skill gone'));
    const { view } = setup({}, connectionFixture('connected'), { updateSkillRoles });
    await openRoles(view);
    const user = userEvent.setup();
    await user.click(rowNamed('SeniorDeveloper'));
    await user.click(saveButton());

    const alert = await within(dialog()).findByRole('alert');
    expect(alert.textContent).toContain(SKILL_ROLES_SKILL_MISSING_MESSAGE);
    expect(document.activeElement).toBe(alert);
    expect(dialog()).toBeTruthy();
  });

  it('shows a generic failure with Retry and saves again', async () => {
    const fake = fakeSkillManagement();
    let first = true;
    const updateSkillRoles = vi.fn(async (...args: Parameters<ManagementApi['updateSkillRoles']>) => {
      if (first) {
        first = false;
        return fail<SkillRolesResult>('INTERNAL', 'offline');
      }
      return fake.updateSkillRoles(...args);
    });
    const { view } = setup({}, connectionFixture('connected'), { updateSkillRoles });
    await openRoles(view);
    const user = userEvent.setup();
    await user.click(rowNamed('SeniorDeveloper'));
    await user.click(saveButton());

    const alert = await within(dialog()).findByRole('alert');
    expect(alert.textContent).toContain(SKILL_ROLES_GENERIC_ERROR);
    expect(document.activeElement).toBe(alert);
    await user.click(within(dialog()).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(updateSkillRoles).toHaveBeenCalledTimes(2);
    expect(view.getByText('Saved roles for code-search.')).toBeTruthy();
  });

  it('discards the draft on Cancel and Escape and returns focus to the entry point', async () => {
    const { view } = setup();
    const user = userEvent.setup();
    await openRoles(view);
    const opener = cardEdit(view);
    await user.click(rowNamed('SeniorDeveloper'));
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(dialog()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));

    await user.click(opener);
    await waitFor(() => expect(rowNamed('SeniorDeveloper').getAttribute('aria-checked')).toBe('false'));
    await user.click(rowNamed('SeniorDeveloper'));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));

    await user.click(opener);
    expect(rowNamed('SeniorDeveloper').getAttribute('aria-checked')).toBe('false');
    expect(rowNamed('TeamLead').getAttribute('aria-checked')).toBe('true');
  });
});

describe('Roles dialog coverage of every role', () => {
  it('shows every role checked for a skill used by every role', async () => {
    const { view } = setup({
      roles: SAMPLE_ROLES.map(role => ({ ...role, skills: ['code-search'] })),
    });
    await openRoles(view);
    expect(checkboxRows()).toHaveLength(SAMPLE_ROLES.length);
    expect(checkboxRows().every(item => item.getAttribute('aria-checked') === 'true')).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });

  it('shows every role unchecked for a skill no role uses and can add one', async () => {
    const { view, fake } = setup();
    await openRoles(view, 'ts-testing');
    expect(checkboxRows()).toHaveLength(SAMPLE_ROLES.length);
    expect(checkboxRows().every(item => item.getAttribute('aria-checked') === 'false')).toBe(true);
    expect(saveButton().disabled).toBe(true);

    const user = userEvent.setup();
    await user.click(rowNamed('Developer'));
    await user.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(fake.calls.find(call => call.method === 'updateSkillRoles')?.args).toEqual([
      'a', 'ts-testing', ['Developer'], SKILLS_SHA,
    ]);
  });
});

