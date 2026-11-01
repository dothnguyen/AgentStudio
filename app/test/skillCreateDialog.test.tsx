// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus, ManagementApi, ManagementResult, SkillDetail, Workspace } from '../src/renderer/api';
import { SkillsScreen } from '../src/renderer/skills/SkillsScreen';
import {
  SKILL_CREATE_GENERIC_ERROR,
  SKILL_CREATE_STARTER,
  SKILL_EXISTS_MESSAGE,
  SKILL_ID_INVALID_MESSAGE,
  skillOverLimitMessage,
} from '../src/renderer/skills/SkillCreateDialog';
import { connectionFixture, deferred } from './teamsFixtures';
import { SKILL_LIMITS, fakeSkillManagement, skillItem } from './skillFixtures';

afterEach(cleanup);

const workspace: Workspace = { id: 'a', name: 'A', path: '/a', exists: true, missing: false };

function setup(
  initial: Parameters<typeof fakeSkillManagement>[0] = {},
  connection: ConnectionStatus = connectionFixture('connected'),
  overrides: Partial<Pick<ManagementApi, 'createSkill' | 'skills' | 'skill'>> = {},
) {
  const fake = fakeSkillManagement(initial);
  const api = { ...fake, ...overrides } as unknown as ManagementApi;
  const view = render(<main><SkillsScreen workspace={workspace} management={api} connection={connection} /></main>);
  return { view, fake };
}

const dialog = () => document.querySelector('.skill-create-dialog') as HTMLElement;
const idInput = () => within(dialog()).getByLabelText('Skill id') as HTMLInputElement;
const contentInput = () => within(dialog()).getByLabelText('Content (markdown)') as HTMLTextAreaElement;
const createButton = () => within(dialog()).getByRole('button', { name: /^(Create skill|Creating…)$/ }) as HTMLButtonElement;
const newSkillButton = (view: ReturnType<typeof render>) => view.getByRole('button', { name: /new skill/i }) as HTMLButtonElement;
const skillList = (view: ReturnType<typeof render>) => view.getByRole('list', { name: 'Saved skills' });

function row(view: ReturnType<typeof render>, id: string): HTMLButtonElement {
  return within(skillList(view)).getAllByRole('button').find(button => button.getAttribute('data-skill-id') === id)!;
}

async function openList(view: ReturnType<typeof render>): Promise<void> {
  await view.findByRole('list', { name: 'Saved skills' });
}

async function openDialog(view: ReturnType<typeof render>): Promise<void> {
  await openList(view);
  fireEvent.click(newSkillButton(view));
}

async function openMissing(view: ReturnType<typeof render>, id = 'legacy-notes'): Promise<void> {
  await openList(view);
  fireEvent.click(row(view, id));
  await view.findByRole('region', { name: 'Skill details' });
}

const ok = <T,>(data: T): ManagementResult<T> => ({ ok: true as const, data });
const fail = (code: string, message: string): ManagementResult<never> => ({
  ok: false as const,
  error: { code, message, retryable: false },
});

describe('New skill entry points', () => {
  it('opens_from_the_list_header_at_680px_with_starter_content_and_the_id_hint', async () => {
    const user = userEvent.setup();
    const { view } = setup();
    await openList(view);
    expect(newSkillButton(view).disabled).toBe(false);

    await user.click(newSkillButton(view));
    const d = dialog();
    expect(d.getAttribute('role')).toBe('dialog');
    expect(d.getAttribute('style')).toContain('width: min(680px, 100%)');
    expect(within(d).getByRole('heading', { name: 'New skill' })).toBeTruthy();
    expect(d.querySelector('.dialog-footer-note')?.textContent).toBe('Add it to roles after creating it');

    expect(idInput().value).toBe('');
    expect(idInput().placeholder).toBe('for example api-design');
    expect(idInput().getAttribute('aria-describedby')).toBe(d.querySelector('.skill-create-hint')?.id);
    expect(within(d).getByText(/Lowercase letters, numbers, dots, dashes and underscores\./)).toBeTruthy();
    expect(within(d).getByText('skills/<id>/SKILL.md')).toBeTruthy();

    expect(contentInput().value).toBe(SKILL_CREATE_STARTER);
    expect(contentInput().rows).toBe(9);
    expect(within(d).getByText('4 lines · 55 / 32,768 bytes')).toBeTruthy();
    expect(createButton().disabled).toBe(true);
    expect(document.activeElement).toBe(idInput());
  });

  it('disables_the_list_button_with_the_disconnected_reason', async () => {
    const { view } = setup({}, connectionFixture('lost'));
    await openList(view);
    const button = newSkillButton(view);
    expect(button.disabled).toBe(true);
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent)
      .toBe('Skill changes are unavailable while the backend is disconnected.');
  });

  it('disables_both_missing_skill_create_buttons_with_the_disconnected_reason', async () => {
    const { view } = setup({}, connectionFixture('lost'));
    await openMissing(view);
    const buttons = view.getAllByRole('button', { name: 'Create this skill' });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent)
        .toBe('Connect to the backend to create this skill.');
    }
  });

  it('disables_the_list_button_with_the_pending_reason_while_a_creation_runs', async () => {
    const gate = deferred<ManagementResult<SkillDetail>>();
    const { view } = setup({}, connectionFixture('connected'), { createSkill: vi.fn(() => gate.promise) });
    await openDialog(view);
    fireEvent.change(idInput(), { target: { value: 'api-design' } });
    fireEvent.click(createButton());

    await waitFor(() => expect(createButton().textContent).toBe('Creating…'));
    const button = newSkillButton(view);
    expect(button.disabled).toBe(true);
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent)
      .toBe('A skill is being created; wait for it to finish.');

    gate.resolve(fail('INTERNAL', 'stop'));
    await waitFor(() => expect(createButton().textContent).toBe('Create skill'));
  });

  it('opens_from_both_missing_skill_entry_points_with_the_id_prefilled_and_locked', async () => {
    const user = userEvent.setup();
    const { view } = setup();
    await openMissing(view);
    const buttons = view.getAllByRole('button', { name: 'Create this skill' });
    expect(buttons).toHaveLength(2);

    await user.click(buttons[1]!);
    expect(idInput().value).toBe('legacy-notes');
    expect(idInput().disabled).toBe(true);
    expect(idInput().readOnly).toBe(true);
    expect(within(dialog()).getByText('skills/legacy-notes/SKILL.md')).toBeTruthy();
    expect(document.activeElement).toBe(contentInput());
    expect(createButton().disabled).toBe(false);

    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(dialog()).toBeNull());
    await user.click(buttons[0]!);
    expect(idInput().value).toBe('legacy-notes');
    expect(idInput().disabled).toBe(true);
    expect(within(dialog()).getByText('skills/legacy-notes/SKILL.md')).toBeTruthy();
  });
});

describe('New skill id validation', () => {
  it('validates_every_backend_rule_before_sending_anything', async () => {
    const { view, fake } = setup();
    await openDialog(view);

    for (const value of ['Design', '.hidden', '-dash', '_under', 'a'.repeat(65), 'has space', 'has/slash', 'café']) {
      fireEvent.change(idInput(), { target: { value } });
      expect(within(dialog()).getByText(SKILL_ID_INVALID_MESSAGE)).toBeTruthy();
      expect(idInput().getAttribute('aria-invalid')).toBe('true');
      expect(createButton().disabled).toBe(true);
    }

    fireEvent.change(idInput(), { target: { value: 'api-design' } });
    expect(within(dialog()).queryByText(SKILL_ID_INVALID_MESSAGE)).toBeNull();
    expect(idInput().hasAttribute('aria-invalid')).toBe(false);
    expect(createButton().disabled).toBe(false);
    expect(fake.calls.some(call => call.method === 'createSkill')).toBe(false);
  });

  it('blocks_an_id_that_already_has_a_file_but_allows_a_missing_skill_id', async () => {
    const { view } = setup();
    await openDialog(view);

    fireEvent.change(idInput(), { target: { value: 'code-search' } });
    expect(within(dialog()).getByText(SKILL_EXISTS_MESSAGE)).toBeTruthy();
    expect(createButton().disabled).toBe(true);

    fireEvent.change(idInput(), { target: { value: 'legacy-notes' } });
    expect(within(dialog()).queryByText(SKILL_EXISTS_MESSAGE)).toBeNull();
    expect(createButton().disabled).toBe(false);
  });

  it('shows_no_message_and_keeps_create_disabled_when_the_id_is_empty_again', async () => {
    const user = userEvent.setup();
    const { view } = setup();
    await openDialog(view);
    await user.type(idInput(), 'api-design');
    expect(createButton().disabled).toBe(false);

    fireEvent.change(idInput(), { target: { value: '' } });
    expect(within(dialog()).queryByText(SKILL_ID_INVALID_MESSAGE)).toBeNull();
    expect(within(dialog()).queryByText(SKILL_EXISTS_MESSAGE)).toBeNull();
    expect(idInput().hasAttribute('aria-invalid')).toBe(false);
    expect(idInput().getAttribute('aria-describedby')).toBe(dialog().querySelector('.skill-create-hint')?.id);
    expect(createButton().disabled).toBe(true);
  });

  it('accepts_one_and_64_character_ids_and_inner_dots_dashes_and_underscores', async () => {
    const { view } = setup();
    await openDialog(view);
    for (const value of ['a', 'a'.repeat(64), 'api.design_v2-beta']) {
      fireEvent.change(idInput(), { target: { value } });
      expect(within(dialog()).queryByText(SKILL_ID_INVALID_MESSAGE)).toBeNull();
      expect(idInput().hasAttribute('aria-invalid')).toBe(false);
      expect(createButton().disabled).toBe(false);
    }
  });

  it('links_the_id_error_from_the_field_with_role_alert', async () => {
    const { view } = setup();
    await openDialog(view);
    fireEvent.change(idInput(), { target: { value: 'Design' } });
    const alert = within(dialog()).getByRole('alert');
    expect(alert.textContent).toBe(SKILL_ID_INVALID_MESSAGE);
    expect(idInput().getAttribute('aria-invalid')).toBe('true');
    expect(idInput().getAttribute('aria-describedby')!.split(' ')).toEqual([
      alert.id,
      dialog().querySelector('.skill-create-hint')!.id,
    ]);
  });

  it('updates_the_path_hint_while_typing', async () => {
    const user = userEvent.setup();
    const { view } = setup();
    await openDialog(view);
    expect(within(dialog()).getByText('skills/<id>/SKILL.md')).toBeTruthy();

    await user.type(idInput(), 'api-design');
    expect(within(dialog()).getByText('skills/api-design/SKILL.md')).toBeTruthy();
    expect(within(dialog()).queryByText('skills/<id>/SKILL.md')).toBeNull();
  });
});

describe('New skill content limit', () => {
  it('counts_lines_and_utf8_bytes_and_blocks_an_over_limit_draft', async () => {
    const { view } = setup();
    await openDialog(view);
    fireEvent.change(idInput(), { target: { value: 'api-design' } });

    fireEvent.change(contentInput(), { target: { value: 'one\ntwo' } });
    expect(within(dialog()).getByText('2 lines · 7 / 32,768 bytes')).toBeTruthy();
    expect(createButton().disabled).toBe(false);

    fireEvent.change(contentInput(), { target: { value: 'x'.repeat(SKILL_LIMITS.skillBytes + 1) } });
    const count = within(dialog()).getByText(`1 lines · ${(SKILL_LIMITS.skillBytes + 1).toLocaleString('en-US')} / 32,768 bytes`);
    expect(count.classList.contains('is-error')).toBe(true);
    expect(within(dialog()).getByText(skillOverLimitMessage(SKILL_LIMITS.skillBytes))).toBeTruthy();
    expect(createButton().disabled).toBe(true);

    // The limit is bytes, not characters: 16,385 two-byte characters are too large.
    fireEvent.change(contentInput(), { target: { value: 'é'.repeat(16385) } });
    expect(within(dialog()).getByText('1 lines · 32,770 / 32,768 bytes')).toBeTruthy();
    expect(createButton().disabled).toBe(true);

    fireEvent.change(contentInput(), { target: { value: '# Fits\n' } });
    expect(within(dialog()).queryByText(skillOverLimitMessage(SKILL_LIMITS.skillBytes))).toBeNull();
    expect(createButton().disabled).toBe(false);
  });

  it('accepts_exactly_the_byte_limit_and_blocks_one_byte_more', async () => {
    const { view } = setup();
    await openDialog(view);
    fireEvent.change(idInput(), { target: { value: 'api-design' } });

    fireEvent.change(contentInput(), { target: { value: 'x'.repeat(SKILL_LIMITS.skillBytes) } });
    expect(within(dialog()).queryByText(skillOverLimitMessage(SKILL_LIMITS.skillBytes))).toBeNull();
    expect(within(dialog()).getByText('1 lines · 32,768 / 32,768 bytes')).toBeTruthy();
    expect(createButton().disabled).toBe(false);

    fireEvent.change(contentInput(), { target: { value: 'x'.repeat(SKILL_LIMITS.skillBytes + 1) } });
    expect(within(dialog()).getByText(skillOverLimitMessage(SKILL_LIMITS.skillBytes))).toBeTruthy();
    expect(createButton().disabled).toBe(true);
  });
});

describe('New skill create', () => {
  it('sends_exactly_id_and_text_then_opens_the_new_page_and_announces_once', async () => {
    const user = userEvent.setup();
    const { view, fake } = setup();
    const text = '# API design\n\nName every endpoint.\n';
    await openDialog(view);

    await user.type(idInput(), 'api-design');
    fireEvent.change(contentInput(), { target: { value: text } });
    await user.click(createButton());

    await waitFor(() => expect(dialog()).toBeNull());
    expect(fake.calls.filter(call => call.method === 'createSkill'))
      .toEqual([{ method: 'createSkill', args: ['a', { id: 'api-design', text }] }]);

    await waitFor(() => expect(view.getByRole('heading', { level: 1, name: 'api-design' })).toBeTruthy());
    const heading = view.getByRole('heading', { level: 1, name: 'api-design' });
    expect(document.activeElement).toBe(heading);
    await waitFor(() => expect(view.getAllByRole('status').filter(node => node.textContent === 'Created skill api-design.'))
      .toHaveLength(1));
    expect(fake.calls.filter(call => call.method === 'skills').length).toBeGreaterThan(1);
  });

  it('creates_the_file_of_a_missing_skill_and_leaves_the_missing_state', async () => {
    const user = userEvent.setup();
    const { view, fake } = setup();
    await openMissing(view);
    await user.click(view.getAllByRole('button', { name: 'Create this skill' })[0]!);
    fireEvent.change(contentInput(), { target: { value: '# Legacy notes\n' } });
    await user.click(createButton());

    await waitFor(() => expect(dialog()).toBeNull());
    await waitFor(() => expect(view.getByText('# Legacy notes', { selector: 'pre' })).toBeTruthy());
    expect(view.queryByText('No SKILL.md yet')).toBeNull();
    expect(fake.calls.filter(call => call.method === 'createSkill'))
      .toEqual([{ method: 'createSkill', args: ['a', { id: 'legacy-notes', text: '# Legacy notes\n' }] }]);
  });

  it('handles_a_SKILL_EXISTS_race_with_the_duplicate_message_and_a_background_refresh', async () => {
    const user = userEvent.setup();
    const createSkill = vi.fn(async (): Promise<ManagementResult<SkillDetail>> => fail('SKILL_EXISTS', "Skill 'api-design' already exists."));
    const { view, fake } = setup({}, connectionFixture('connected'), { createSkill });
    await openDialog(view);
    const loadsBefore = fake.calls.filter(call => call.method === 'skills').length;

    fireEvent.change(idInput(), { target: { value: 'api-design' } });
    await user.click(createButton());

    await waitFor(() => expect(within(dialog()).getByText(SKILL_EXISTS_MESSAGE)).toBeTruthy());
    expect(dialog()).not.toBeNull();
    expect(createButton().disabled).toBe(true);
    expect(document.activeElement).toBe(within(dialog()).getByRole('alert'));
    await waitFor(() => expect(fake.calls.filter(call => call.method === 'skills').length).toBeGreaterThan(loadsBefore));

    // Changing the id clears the server duplicate and clears the block.
    fireEvent.change(idInput(), { target: { value: 'api-design-2' } });
    expect(within(dialog()).queryByText(SKILL_EXISTS_MESSAGE)).toBeNull();
    expect(createButton().disabled).toBe(false);
  });

  it('shows_the_backend_validation_message_without_retrying', async () => {
    const user = userEvent.setup();
    const message = "Argument 'skill.id' is not a legal skill id.";
    const createSkill = vi.fn(async (): Promise<ManagementResult<SkillDetail>> => fail('BAD_REQUEST', message));
    const { view } = setup({}, connectionFixture('connected'), { createSkill });
    await openDialog(view);
    fireEvent.change(idInput(), { target: { value: 'api-design' } });
    await user.click(createButton());

    const alert = await within(dialog()).findByRole('alert');
    expect(alert.textContent).toBe(message);
    expect(document.activeElement).toBe(alert);
    expect(within(dialog()).queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(createButton().disabled).toBe(false);
  });

  it('shows_a_generic_error_and_retries_the_same_values', async () => {
    const user = userEvent.setup();
    const fake = fakeSkillManagement();
    let attempt = 0;
    const createSkill = vi.fn(async (workspaceId: string, input: { id: string; text: string }) => {
      attempt += 1;
      if (attempt === 1) return fail('INTERNAL', 'socket closed');
      return fake.createSkill(workspaceId, input);
    });
    const api = { ...fake, createSkill } as unknown as ManagementApi;
    const view = render(<main><SkillsScreen workspace={workspace} management={api} connection={connectionFixture('connected')} /></main>);
    await openDialog(view);
    fireEvent.change(idInput(), { target: { value: 'api-design' } });

    await user.click(createButton());
    const alert = await within(dialog()).findByRole('alert');
    expect(alert.textContent).toContain(SKILL_CREATE_GENERIC_ERROR);
    expect(document.activeElement).toBe(alert);

    await user.click(within(dialog()).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(createSkill).toHaveBeenCalledTimes(2);
    expect(createSkill).toHaveBeenNthCalledWith(2, 'a', { id: 'api-design', text: SKILL_CREATE_STARTER });
  });

  it('keeps_the_dialog_open_busy_and_ignores_escape_while_saving', async () => {
    const user = userEvent.setup();
    const gate = deferred<ManagementResult<SkillDetail>>();
    const { view } = setup({}, connectionFixture('connected'), { createSkill: vi.fn(() => gate.promise) });
    await openDialog(view);
    fireEvent.change(idInput(), { target: { value: 'api-design' } });
    await user.click(createButton());

    await waitFor(() => expect(createButton().textContent).toBe('Creating…'));
    expect(createButton().disabled).toBe(true);
    expect(idInput().disabled).toBe(true);
    expect(contentInput().disabled).toBe(true);
    await user.keyboard('{Escape}');
    expect(dialog()).not.toBeNull();

    gate.resolve(ok({ workspace: '/work/a', skill: skillItem({ id: 'api-design' }), text: SKILL_CREATE_STARTER }));
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it('discards_on_cancel_and_escape_and_returns_focus_to_the_New_skill_button', async () => {
    const user = userEvent.setup();
    const { view } = setup();
    await openList(view);
    const opener = newSkillButton(view);

    opener.focus();
    await user.click(opener);
    await user.type(idInput(), 'draft-skill');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    expect(document.activeElement).toBe(opener);

    await user.click(opener);
    await user.type(idInput(), 'draft-again');
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('starts_clean_after_cancel_and_escape_and_sends_nothing', async () => {
    const user = userEvent.setup();
    const { view, fake } = setup();
    await openList(view);
    const opener = newSkillButton(view);

    await user.click(opener);
    await user.type(idInput(), 'draft-skill');
    fireEvent.change(contentInput(), { target: { value: '# Draft\n' } });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());

    await user.click(opener);
    expect(idInput().value).toBe('');
    expect(contentInput().value).toBe(SKILL_CREATE_STARTER);
    expect(within(dialog()).queryByRole('alert')).toBeNull();

    await user.type(idInput(), 'draft-again');
    fireEvent.change(contentInput(), { target: { value: '# Again\n' } });
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(dialog()).toBeNull());

    await user.click(opener);
    expect(idInput().value).toBe('');
    expect(contentInput().value).toBe(SKILL_CREATE_STARTER);
    expect(fake.calls.some(call => call.method === 'createSkill')).toBe(false);
  });
});

describe('New skill design details', () => {
  it('styles_the_id_and_content_fields_as_mono_with_a_200px_minimum_editor', () => {
    const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8').replace(/\s+/g, ' ');
    expect(css).toContain('.skill-create-dialog .dialog-body { display: flex; flex-direction: column; gap: 16px; }');
    expect(css).toMatch(/\.skill-create-id \{[^}]*font-family: var\(--font-mono\)/);
    expect(css).toMatch(/\.skill-create-content \{[^}]*min-height: 200px;[^}]*font-family: var\(--font-mono\)/);
  });
});
