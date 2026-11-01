// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagementApi, ManagementError, RoleCatalogItem, RoleCatalogList } from '../src/renderer/api';
import { RoleSkillsDialog } from '../src/renderer/roles/RoleSkillsDialog';
import { CONFLICT_MESSAGE, VERIFY_MESSAGE } from '../src/renderer/roles/roleSave';
import { deferred, fakeManagement } from './teamsFixtures';
import { roleItem, rolesFixture } from './rolesFixtures';

afterEach(cleanup);
const SHA = 'c'.repeat(64);
const DEV_SHA = 'd'.repeat(64);
const NEXT_SHA = '1'.repeat(64);

function developer(over: Record<string, unknown> = {}): RoleCatalogItem {
  return roleItem('Developer', {
    name: 'Developer',
    description: 'Implements stories',
    instructions: { state: 'ok', path: '.agent-studio/roles/Developer.md', text: 'Write tests.', sha256: DEV_SHA, bytes: 12 },
    skills: [{ id: 'python-testing', state: 'ok' }, { id: 'retired-skill', state: 'missing' }],
    ...over,
  });
}
function catalog(items: RoleCatalogItem[] = [developer()], over: Partial<RoleCatalogList> = {}): RoleCatalogList {
  return rolesFixture({ items, availableSkills: ['python-testing', 'extra-skill'], ...over });
}
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: string, message = 'failed') => ({ ok: false as const, error: { code, message, retryable: false } });
const mutation = (role: RoleCatalogItem, sha = NEXT_SHA) => ok({ workspace: '/w', sha256: sha, role, warnings: [], appliesToNewAssignments: true as const });

function Harness(props: {
  initialRole?: RoleCatalogItem;
  updateRole?: ReturnType<typeof vi.fn>;
  updateRoleInstructions?: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  onSaved?: (role: RoleCatalogItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState(props.initialRole ?? developer());
  const [catalogNow, setCatalogNow] = useState(catalog());
  const updateRole = props.updateRole ?? vi.fn(async () => mutation(role));
  const updateRoleInstructions = props.updateRoleInstructions ?? vi.fn();
  const fake = fakeManagement({ calls: { updateRole, updateRoleInstructions } });
  const reload = vi.fn(async () => {
    const result = await props.reload();
    if (result.ok) {
      setCatalogNow(result.data);
      const fresh = result.data.items.find(item => item.id === 'Developer');
      if (fresh) setRole(fresh);
    }
    return result;
  });
  return <>
    <button type="button" onClick={() => setOpen(true)}>Open skills</button>
    {open && <RoleSkillsDialog
      role={role}
      catalog={catalogNow}
      catalogSha={catalogNow.sha256}
      management={fake.api as ManagementApi}
      workspaceId="a"
      reload={reload}
      onSaved={saved => { setOpen(false); props.onSaved?.(saved); }}
      onCancel={() => setOpen(false)}
    />}
  </>;
}

const dialog = () => document.querySelector('.role-skills-dialog') as HTMLElement;
const rows = () => within(dialog()).getAllByRole('checkbox') as HTMLButtonElement[];
const saveButton = () => within(dialog()).getByRole('button', { name: /^(Save|Saving…)$/ }) as HTMLButtonElement;

describe('Role skills dialog', () => {
  it('opens_at_560px_with_a_checkbox_per_available_skill_plus_a_missing_configured_skill', async () => {
    const user = userEvent.setup();
    render(<Harness reload={vi.fn(async () => ok(catalog()))} />);
    await user.click(document.querySelector('button')!);
    const d = dialog();
    expect(d.getAttribute('style')).toContain('width: min(560px, 100%)');
    expect(within(d).getByRole('group', { name: 'Skills' })).toBeTruthy();
    expect(rows().map(row => row.textContent)).toEqual(['python-testing', 'extra-skill', 'retired-skillmissing']);
    expect(rows().map(row => row.getAttribute('aria-checked'))).toEqual(['true', 'false', 'true']);
    expect(rows()[2]!.classList.contains('is-missing')).toBe(true);
    expect(document.activeElement).toBe(rows()[0]);
    expect(saveButton().disabled).toBe(true);
    expect(d.querySelector('.dialog-footer-note')!.textContent).toBe('Saved to roles.json');
  });

  it('writes_only_the_skill_list_through_update_role_and_returns_focus', async () => {
    const user = userEvent.setup();
    const updated = developer({ skills: [{ id: 'python-testing', state: 'ok' }, { id: 'extra-skill', state: 'ok' }] });
    const updateRole = vi.fn(async () => mutation(updated));
    const updateRoleInstructions = vi.fn();
    const onSaved = vi.fn();
    render(<Harness updateRole={updateRole} updateRoleInstructions={updateRoleInstructions} reload={vi.fn(async () => ok(catalog([updated])))} onSaved={onSaved} />);
    const opener = document.querySelector('button')!;
    opener.focus();
    await user.click(opener);
    await user.click(rows()[1]!);
    await user.click(rows()[2]!);
    expect(saveButton().disabled).toBe(false);
    await user.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(updateRole).toHaveBeenCalledWith('a', 'Developer', { skills: ['python-testing', 'extra-skill'] }, SHA);
    expect(updateRoleInstructions).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(updated);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('removes_an_unchecked_missing_skill_and_never_offers_it_again', async () => {
    const user = userEvent.setup();
    render(<Harness reload={vi.fn(async () => ok(catalog()))} />);
    await user.click(document.querySelector('button')!);
    await user.click(rows()[2]!);
    expect(rows().map(row => row.textContent)).toEqual(['python-testing', 'extra-skill']);
    expect(rows().some(row => row.textContent?.includes('retired-skill'))).toBe(false);
  });

  it('disables_save_again_when_the_selection_returns_to_the_saved_skills', async () => {
    const user = userEvent.setup();
    render(<Harness reload={vi.fn(async () => ok(catalog()))} />);
    await user.click(document.querySelector('button')!);
    await user.click(rows()[1]!);
    expect(saveButton().disabled).toBe(false);
    await user.click(rows()[1]!);
    expect(saveButton().disabled).toBe(true);
  });

  it('saves_the_skill_list_without_a_missing_skill_that_was_unchecked', async () => {
    const user = userEvent.setup();
    const updated = developer({ skills: [{ id: 'python-testing', state: 'ok' }] });
    const updateRole = vi.fn(async () => mutation(updated));
    const updateRoleInstructions = vi.fn();
    render(<Harness updateRole={updateRole} updateRoleInstructions={updateRoleInstructions} reload={vi.fn(async () => ok(catalog([updated])))} />);
    await user.click(document.querySelector('button')!);
    await user.click(rows()[2]!);
    expect(saveButton().disabled).toBe(false);
    await user.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(updateRole).toHaveBeenCalledWith('a', 'Developer', { skills: ['python-testing'] }, SHA);
    expect(updateRoleInstructions).not.toHaveBeenCalled();
  });

  it('discards_the_draft_on_cancel_and_escape', async () => {
    const user = userEvent.setup();
    render(<Harness reload={vi.fn(async () => ok(catalog()))} />);
    const opener = document.querySelector('button')!;
    await user.click(opener);
    await user.click(rows()[1]!);
    expect(rows()[1]!.getAttribute('aria-checked')).toBe('true');
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(dialog()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    await user.click(opener);
    expect(rows()[1]!.getAttribute('aria-checked')).toBe('false');
    expect(rows()[2]!.getAttribute('aria-checked')).toBe('true');
    await user.click(rows()[2]!);
    expect(rows().map(row => row.textContent)).toEqual(['python-testing', 'extra-skill']);
    await user.keyboard('{Escape}');
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
    await user.click(opener);
    expect(rows().map(row => row.textContent)).toEqual(['python-testing', 'extra-skill', 'retired-skillmissing']);
    expect(rows()[2]!.getAttribute('aria-checked')).toBe('true');
  });

  it('shows_a_server_skill_problem_and_keeps_save_disabled', async () => {
    const user = userEvent.setup();
    const updateRole = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'BAD_REQUEST',
        message: 'Skills rejected',
        retryable: false,
        data: { problems: [{ path: 'role.skills[0]', message: 'Unknown skill id' }] },
      },
    }));
    render(<Harness updateRole={updateRole} reload={vi.fn(async () => ok(catalog()))} />);
    await user.click(document.querySelector('button')!);
    await user.click(rows()[1]!);
    await user.click(saveButton());
    await waitFor(() => expect(within(dialog()).getByRole('alert')).toBeTruthy());
    expect(within(dialog()).getByRole('alert').textContent).toContain('BAD_REQUEST: Skills rejected');
    expect(within(dialog()).getByText('Unknown skill id')).toBeTruthy();
    expect(within(dialog()).getByRole('group', { name: 'Skills' }).getAttribute('aria-describedby')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    expect(rows()[1]!.getAttribute('aria-checked')).toBe('true');
  });

  it('re_enables_save_when_the_person_corrects_a_rejected_skill_draft', async () => {
    const user = userEvent.setup();
    const updated = developer({ skills: [{ id: 'python-testing', state: 'ok' }] });
    const updateRole = vi.fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: {
          code: 'BAD_REQUEST',
          message: 'Skills rejected',
          retryable: false,
          data: { problems: [{ path: 'role.skills[0]', message: 'Unknown skill id' }] },
        },
      })
      .mockResolvedValueOnce(mutation(updated));
    render(<Harness updateRole={updateRole} reload={vi.fn(async () => ok(catalog([updated])))} />);
    await user.click(document.querySelector('button')!);
    await user.click(rows()[1]!);
    await user.click(rows()[2]!);
    await user.click(saveButton());
    await waitFor(() => expect(within(dialog()).getByRole('alert')).toBeTruthy());
    expect(saveButton().disabled).toBe(true);
    await user.click(rows()[1]!);
    expect(within(dialog()).queryByText('Unknown skill id')).toBeNull();
    expect(saveButton().disabled).toBe(false);
    await user.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(updateRole).toHaveBeenCalledTimes(2);
    expect(updateRole).toHaveBeenLastCalledWith('a', 'Developer', { skills: ['python-testing'] }, SHA);
  });

  it('adds_newly_available_skills_after_a_conflict_reload_without_losing_the_draft', async () => {
    const user = userEvent.setup();
    const server = developer();
    const updateRole = vi.fn(async () => fail('CONFIG_CHANGED', 'changed'));
    const reload = vi.fn(async () => ok(catalog([server], { sha256: NEXT_SHA, availableSkills: ['python-testing', 'extra-skill', 'fresh-skill'] })));
    render(<Harness updateRole={updateRole} reload={reload} />);
    await user.click(document.querySelector('button')!);
    await user.click(rows()[1]!);
    await user.click(saveButton());
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toContain(CONFLICT_MESSAGE));
    await user.click(within(dialog()).getByRole('button', { name: 'Reload and review' }));
    await waitFor(() => expect(within(dialog()).getByText('Current role values were reloaded. Review the draft, then save again.')).toBeTruthy());
    expect(rows().map(row => row.textContent)).toEqual(['python-testing', 'extra-skill', 'fresh-skill', 'retired-skillmissing']);
    expect(rows()[1]!.getAttribute('aria-checked')).toBe('true');
  });

  it('reports_a_verify_failure_as_a_partial_save_without_closing', async () => {
    const user = userEvent.setup();
    const updated = developer({ skills: [{ id: 'python-testing', state: 'ok' }, { id: 'extra-skill', state: 'ok' }, { id: 'retired-skill', state: 'missing' }] });
    render(<Harness updateRole={vi.fn(async () => mutation(updated))} reload={vi.fn(async () => fail('INTERNAL', 'offline'))} />);
    await user.click(document.querySelector('button')!);
    await user.click(rows()[1]!);
    await user.click(saveButton());
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toContain(VERIFY_MESSAGE));
    expect(within(dialog()).getByRole('alert').textContent).toContain('INTERNAL: offline');
    expect(rows()[1]!.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(within(dialog()).getByRole('alert'));
  });

  it('keeps_the_draft_and_focuses_the_error_when_saving_fails', async () => {
    const user = userEvent.setup();
    const updateRole = vi.fn(async () => fail('BAD_REQUEST', 'Skills rejected'));
    render(<Harness updateRole={updateRole} reload={vi.fn(async () => ok(catalog()))} />);
    await user.click(document.querySelector('button')!);
    await user.click(rows()[1]!);
    await user.click(saveButton());
    await waitFor(() => expect(within(dialog()).getByRole('alert')).toBeTruthy());
    const alert = within(dialog()).getByRole('alert');
    expect(alert.textContent).toContain('BAD_REQUEST: Skills rejected');
    expect(document.activeElement).toBe(alert);
    expect(rows()[1]!.getAttribute('aria-checked')).toBe('true');
  });

  it('keeps_the_draft_across_a_conflict_reload_and_retries_with_the_new_token', async () => {
    const user = userEvent.setup();
    const server = developer({ skills: [{ id: 'python-testing', state: 'ok' }, { id: 'retired-skill', state: 'missing' }, { id: 'server-skill', state: 'ok' }] });
    const updateRole = vi.fn()
      .mockResolvedValueOnce(fail('CONFIG_CHANGED', 'changed'))
      .mockResolvedValueOnce(mutation(developer({ skills: [{ id: 'python-testing', state: 'ok' }, { id: 'extra-skill', state: 'ok' }] })));
    const reload = vi.fn()
      .mockResolvedValueOnce(ok(catalog([server], { sha256: NEXT_SHA })))
      .mockResolvedValueOnce(ok(catalog([developer({ skills: [{ id: 'python-testing', state: 'ok' }, { id: 'extra-skill', state: 'ok' }] })], { sha256: '3'.repeat(64) })));
    render(<Harness updateRole={updateRole} reload={reload} />);
    await user.click(document.querySelector('button')!);
    await user.click(rows()[1]!);
    await user.click(rows()[2]!);
    await user.click(saveButton());
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toContain(CONFLICT_MESSAGE));
    await user.click(within(dialog()).getByRole('button', { name: 'Reload and review' }));
    await waitFor(() => expect(within(dialog()).getByText('Current role values were reloaded. Review the draft, then save again.')).toBeTruthy());
    expect(rows()[1]!.getAttribute('aria-checked')).toBe('true');
    await user.click(saveButton());
    await waitFor(() => expect(updateRole).toHaveBeenCalledTimes(2));
    expect(updateRole).toHaveBeenLastCalledWith('a', 'Developer', { skills: ['python-testing', 'extra-skill'] }, NEXT_SHA);
  });

  it('disables_every_row_and_save_while_the_write_is_pending', async () => {
    const user = userEvent.setup();
    const gate = deferred<ReturnType<typeof mutation>>();
    render(<Harness updateRole={vi.fn(() => gate.promise)} reload={vi.fn(async () => ok(catalog()))} />);
    await user.click(document.querySelector('button')!);
    await user.click(rows()[1]!);
    await user.click(saveButton());
    await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'Saving…' })).toBeTruthy());
    expect(rows().every(row => row.disabled)).toBe(true);
    expect((within(dialog()).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
