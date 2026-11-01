// @vitest-environment jsdom
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RolePage } from '../src/renderer/roles/RolePage';
import type { RoleCatalogItem } from '../src/shared/management';
import { MEMBERS, roleItem, usageOf } from './rolesFixtures';

afterEach(cleanup);

type RolePageProps = Parameters<typeof RolePage>[0];

function setup(role: RoleCatalogItem, over: Partial<RolePageProps> = {}) {
  const props: RolePageProps = {
    role,
    editDisabled: false,
    editReason: null,
    onEdit: vi.fn(),
    onBack: vi.fn(),
    onDelete: vi.fn(),
    deleteDisabledReason: null,
    ...over,
  };
  const view = render(<RolePage {...props} />);
  return { view, props };
}

const runningMember = (id: string) => ({
  teamDefId: 'core', teamName: 'Core', memberId: id, memberName: id,
  saved: null, live: { availability: 'available', assignment: { id: `a-${id}`, status: 'running' } },
});

describe('RolePage header', () => {
  it('never_claims_unused_when_usage_is_incomplete', () => {
    const { view } = setup(roleItem('team-lead', { name: 'Team Lead', usage: usageOf({ partial: true }) }));
    expect(view.getByRole('heading', { level: 1, name: 'Team Lead' })).toBeTruthy();
    expect(view.container.querySelector('.roles-role-avatar')?.textContent).toBe('TL');
    const pill = view.getByText('Usage incomplete');
    expect(pill.classList.contains('roles-role-usage-pill')).toBe(true);
    expect(pill.classList.contains('is-incomplete')).toBe(true);
    expect(view.getByText('Running assignments unknown')).toBeTruthy();
    expect(view.queryByText('Unused')).toBeNull();

    cleanup();
    const withMember = setup(roleItem('team-lead', { name: 'Team Lead', usage: usageOf({ partial: true }, [MEMBERS[1]!]) }));
    const used = withMember.view.getByText('Used by 1 member');
    expect(used.classList.contains('is-used')).toBe(true);
    expect(withMember.view.getByText('Usage incomplete')).toBeTruthy();
    expect(withMember.view.queryByText('No running assignments')).toBeNull();
  });

  it('spells_out_running_assignments_on_the_role_page', () => {
    const one = setup(roleItem('one', { name: 'One', usage: usageOf({}, [runningMember('a')]) }));
    expect(one.view.getByText('1 running assignment')).toBeTruthy();

    cleanup();
    const two = setup(roleItem('two', { name: 'Two', usage: usageOf({}, [runningMember('a'), runningMember('b')]) }));
    expect(two.view.getByText('2 running assignments')).toBeTruthy();
    expect(two.view.queryByText('2 running')).toBeNull();
  });

  it('repeats_the_list_notice_directly_under_the_header', () => {
    const { view } = setup(roleItem('notice', { name: 'Notice' }));
    const top = view.container.querySelector('.roles-role-top')!;
    const header = top.querySelector('.roles-role-header')!;
    const notice = top.querySelector('.roles-notice')!;
    expect(notice).toBeTruthy();
    expect(notice.textContent).toBe('Saved changes apply to new assignments. Assignments already running keep the instructions they started with.');
    expect(header.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('header_counts_each_member_in_the_pill_and_says_when_nothing_is_running', () => {
    const savedOnly = (id: string) => ({
      teamDefId: 'core', teamName: 'Core', memberId: id, memberName: id,
      saved: { path: 'teams.json', memberIndex: 0 },
      live: { availability: 'available', assignment: null },
    });
    const { view } = setup(roleItem('duo', { name: 'Duo', usage: usageOf({}, [savedOnly('a'), savedOnly('b')]) }));
    const pill = view.getByText('Used by 2 members');
    expect(pill.classList.contains('roles-role-usage-pill')).toBe(true);
    expect(pill.classList.contains('is-used')).toBe(true);
    expect(view.getByText('No running assignments')).toBeTruthy();
    expect(view.queryByText('Unused')).toBeNull();
    expect(view.container.querySelector('.roles-role-avatar')?.textContent).toBe('D');
  });
});

describe('RolePage cards', () => {
  it('overview_falls_back_to_the_id_and_omits_a_matching_display_name', () => {
    const { view } = setup(roleItem('Planner', { name: '  ' }));
    const overview = view.container.querySelector('.roles-overview-card') as HTMLElement;
    expect(within(overview).getByText('Name')).toBeTruthy();
    expect(within(overview).getAllByText('Planner').length).toBeGreaterThan(0);
    expect(overview.querySelector('.roles-overview-id')?.textContent).toBe('Planner');
    expect(within(overview).getByText('No description')).toBeTruthy();
    expect(within(overview).queryByText('Display name')).toBeNull();
  });

  it('keeps_every_instruction_state_and_the_truncation_note', () => {
    const missing = setup(roleItem('missing', {
      instructions: { state: 'missing', path: '.agent-studio/roles/missing.md', text: null, sha256: null, bytes: null },
    }));
    expect(missing.view.getByText('The configured instruction file is missing.')).toBeTruthy();
    cleanup();
    const none = setup(roleItem('none'));
    expect(none.view.getByText('No shared instruction file configured.')).toBeTruthy();
    cleanup();
    const invalid = setup(roleItem('invalid', {
      instructions: { state: 'invalid', path: null, text: null, sha256: null, bytes: null },
    }));
    expect(invalid.view.getByText('Shared instructions are unavailable because the configured file is invalid or unsafe.')).toBeTruthy();
    cleanup();
    const truncated = setup(roleItem('truncated', {
      instructions: { state: 'truncated', path: '.agent-studio/roles/truncated.md', text: 'partial body', sha256: 'e'.repeat(64), bytes: 12 },
    }));
    expect(truncated.view.getByText('partial body')).toBeTruthy();
    expect(truncated.view.getByText('Instruction content is truncated.')).toBeTruthy();
  });

  it('marks_missing_skills_and_opens_members_only_when_both_ids_are_known', () => {
    const onOpenMember = vi.fn();
    const { view } = setup(roleItem('Developer', {
      skills: [{ id: 'python-testing', state: 'ok' }, { id: 'retired-skill', state: 'missing' }],
      usage: usageOf({}, MEMBERS),
    }), { onOpenMember });
    const missingChip = view.getByText('retired-skill').closest('.roles-skill-chip')!;
    expect(missingChip.textContent).toBe('retired-skill · missing');
    expect(missingChip.classList.contains('roles-skill-chip-missing')).toBe(true);
    const rows = Array.from(view.container.querySelectorAll<HTMLElement>('.roles-usedby-row'));
    expect(rows).toHaveLength(4);
    const open = within(rows[0]!).getByRole('button', { name: 'Open Dev' });
    open.click();
    expect(onOpenMember).toHaveBeenCalledWith('core', 'dev-1');
    expect(within(rows[3]!).queryByRole('button', { name: /^Open / })).toBeNull();
  });

  it('instructions_explain_an_empty_file_and_derive_the_count_when_bytes_are_missing', () => {
    const empty = setup(roleItem('empty', {
      instructions: { state: 'ok', path: '.agent-studio/roles/empty.md', text: '   ', sha256: 'a'.repeat(64), bytes: null },
    }));
    expect(empty.view.getByText('This instruction file is empty.')).toBeTruthy();
    expect(empty.view.getByText('.agent-studio/roles/empty.md')).toBeTruthy();
    expect(empty.view.container.querySelector('.roles-instructions-preview')).toBeNull();
    expect(empty.view.container.querySelector('.roles-instructions-count')).toBeNull();

    cleanup();
    const derived = setup(roleItem('derived', {
      instructions: { state: 'ok', path: '.agent-studio/roles/derived.md', text: 'abc\ndef', sha256: 'b'.repeat(64), bytes: null },
    }));
    expect(derived.view.getByText('2 lines · 7 / 16,384 bytes')).toBeTruthy();
    expect(derived.view.getByText(/abc\s+def/, { selector: 'pre' })).toBeTruthy();
    const file = derived.view.container.querySelector('.roles-instructions-file');
    expect(file?.textContent).toBe('.agent-studio/roles/derived.md');
    expect(file?.querySelector('svg')).toBeTruthy();
    const fade = derived.view.container.querySelector('.roles-instructions-fade');
    expect(fade).toBeTruthy();
    expect(fade?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps_the_unwired_section_edits_disabled_with_their_reason', () => {
    const { view, props } = setup(roleItem('Developer', { name: 'Developer' }));
    const overview = view.getByRole('button', { name: 'Edit role' }) as HTMLButtonElement;
    expect(overview.disabled).toBe(true);
    const overviewReason = overview.getAttribute('aria-describedby');
    expect(overviewReason).toBeTruthy();
    expect(document.getElementById(overviewReason!)?.textContent).toBe('Editing the role overview is available in the next update.');

    const instructions = view.getByRole('button', { name: 'Edit shared instructions' }) as HTMLButtonElement;
    expect(instructions.disabled).toBe(true);
    const instructionsReason = instructions.getAttribute('aria-describedby');
    expect(instructionsReason).toBeTruthy();
    expect(document.getElementById(instructionsReason!)?.textContent).toBe('Editing shared instructions is available in the next update.');

    const skills = view.getByRole('button', { name: 'Edit skills' }) as HTMLButtonElement;
    expect(skills.disabled).toBe(true);
    const skillsReason = skills.getAttribute('aria-describedby');
    expect(skillsReason).toBeTruthy();
    expect(document.getElementById(skillsReason!)?.textContent).toBe('Editing skills is available in the next update.');
    expect(props.onEdit).not.toHaveBeenCalled();
  });

  it('used_by_rows_are_plain_text_when_no_member_handler_is_wired', () => {
    const { view } = setup(roleItem('Developer', { name: 'Developer', usage: usageOf({}, MEMBERS.slice(0, 2)) }));
    const rows = Array.from(view.container.querySelectorAll<HTMLElement>('.roles-usedby-row'));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Dev');
    expect(rows[0]!.textContent).toContain('Core · Saved and Live · available, assignment running');
    expect(within(rows[0]!).queryByRole('button')).toBeNull();
    expect(within(rows[0]!).queryByText('Open')).toBeNull();
  });

  it('keeps_the_honesty_disclaimer_as_the_last_muted_line_of_the_used_by_card', () => {
    const { view } = setup(roleItem('Developer', { name: 'Developer', usage: usageOf({}, MEMBERS) }));
    const body = view.container.querySelector('.roles-usedby-card .section-card-body')!;
    const disclaimer = body.lastElementChild as HTMLElement;
    expect(disclaimer.classList.contains('roles-usedby-disclaimer')).toBe(true);
    expect(disclaimer.textContent).toBe('Roles do not grant permissions and do not choose agents; those come from team and agent settings.');
  });
});
