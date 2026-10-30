// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { TeamsHarness } from './teamsHarness';
import { workspaceA } from './dashboardFixtures';
import {
  LONG_UNBROKEN, fakeManagement, longContentOverview, longRoutingSettings, managementError, member, memberRow, openMember, overviewFixture, team, twoTeams,
} from './teamsFixtures';

afterEach(cleanup);

const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8');
const flat = css.replace(/\s+/g, ' ');
/** Every top-level and nested rule whose selector list mentions a Teams selector. */
function teamsRules(): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/^@media[^{]*$/, '');
    if (/\.(teams-|routing-)/.test(selector)) rules.push({ selector, body: m[2]!.replace(/\s+/g, ' ') });
  }
  return rules;
}

async function mount(opts: Parameters<typeof fakeManagement>[0] = {}, tab?: string) {
  const fake = fakeManagement(opts);
  const view = render(<main><TeamsHarness workspace={workspaceA} management={fake.api} onViewRole={vi.fn()} /></main>);
  await act(async () => {});
  if (tab) { fireEvent.click(view.getByRole('tab', { name: tab })); await act(async () => {}); }
  return { fake, view };
}

it('teams_has_one_main_one_h1_logical_landmarks_and_named_controls', async () => {
  const { view } = await mount();
  expect(view.getAllByRole('main')).toHaveLength(1);
  expect(view.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(view.getByRole('navigation', { name: 'Breadcrumb' })).toBeTruthy();
  const levels = view.getAllByRole('heading').map(h => Number(h.tagName[1]));
  expect(levels[0]).toBe(1);
  levels.forEach((level, i) => { if (i > 0) expect(level).toBeLessThanOrEqual(levels[i - 1]! + 1); });
  expect(view.getAllByRole('heading', { level: 2 }).map(h => h.textContent)[0]).toBe('Dev Team');
  expect(view.getByRole('tablist')).toBeTruthy();
  for (const control of view.getAllByRole('button').concat(view.getAllByRole('tab'))) {
    expect((control.getAttribute('aria-label') ?? control.textContent ?? '').trim().length).toBeGreaterThan(0);
  }
  const panel = view.getByRole('tabpanel');
  expect(panel.getAttribute('aria-labelledby')).toBe(view.getByRole('tab', { name: 'Overview' }).id);
  expect(view.container.querySelector('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])')).toBeNull();
});

it('teams_native_controls_have_visible_focus_and_single_live_messages', async () => {
  const create = vi.fn(async () => ({ ok: false as const, error: { code: 'BAD_REQUEST', message: 'duplicate', retryable: false } }));
  const { view } = await mount({ calls: { createTeam: create } });
  for (const c of view.getAllByRole('button')) expect(c.tagName).toBe('BUTTON');
  expect(view.queryAllByRole('alert')).toHaveLength(0);
  fireEvent.click(view.getByRole('button', { name: 'New team' }));
  await userEvent.type(view.getByLabelText('Team name'), 'Dup');
  await userEvent.keyboard('{Enter}');
  await act(async () => {});
  expect(create).toHaveBeenCalledTimes(1);
  expect(view.getAllByRole('alert')).toHaveLength(1);
  expect(view.getAllByText(/duplicate/)).toHaveLength(1);
  expect(view.queryAllByRole('status').filter(s => s.textContent?.includes('duplicate'))).toHaveLength(0);
  for (const dot of Array.from(view.container.querySelectorAll('.status-dot'))) expect(dot.getAttribute('aria-hidden')).toBe('true');
  expect(css).toMatch(/\.teams-screen :is\(button, a, input, select, textarea, summary\):focus-visible \{ outline: 2px solid var\(--focus\); outline-offset: 2px; \}/);
});

it('teams_dialog_and_disclosures_are_keyboard_complete', async () => {
  const live = { ...twoTeams().teams[1]!.members[0]!.runtime!, configuredAgents: ['opencode-sonnet', 'codex-gpt'], activeAgent: 'opencode-sonnet', paneState: 'alive', availability: 'idle' };
  const data = overviewFixture([team({ runtime: { state: 'running', teamId: 't', status: 'running' }, members: [member({ runtime: live })] })]);
  const switchMemberAgent = vi.fn().mockResolvedValue({ ok: false, error: { code: 'BAD_REQUEST', message: 'Member has an active assignment; confirm cancellation of this assignment to switch.', retryable: false, data: { assignmentId: 'job-1' } } });
  const { view } = await mount({ overview: [{ ok: true, data }], calls: { switchMemberAgent } }, 'Members');
  openMember('dev'); await act(async () => {});
  const opener = view.getByRole('button', { name: 'Switch' }); opener.focus();
  await userEvent.keyboard('{Enter}'); await act(async () => {});
  const dialog = view.getByRole('dialog');
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
  await userEvent.tab(); await userEvent.tab();
  expect(dialog.contains(document.activeElement)).toBe(true);
  await userEvent.keyboard('{Escape}');
  expect(view.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(opener);
  cleanup();
  const routing = await mount({}, 'Routing');
  const toggle = routing.view.getByRole('button', { name: 'Action rules' }); toggle.focus();
  await userEvent.keyboard('{Enter}');
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  await userEvent.keyboard(' ');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});

it('teams_long_content_remains_present', async () => {
  const { view } = await mount({ overview: [{ ok: true, data: longContentOverview() }], roles: [managementError('ROLES_DOWN', `${LONG_UNBROKEN} message`, `${LONG_UNBROKEN} remediation`)] }, 'Members');
  expect(view.container.textContent!.split(LONG_UNBROKEN).length - 1).toBeGreaterThan(3);
  expect(within(memberRow(`Ünï ${LONG_UNBROKEN}`)).getByText(new RegExp(`Goal ${LONG_UNBROKEN}`))).toBeTruthy();
  expect(view.getAllByRole('alert')[0]!.textContent).toContain(`${LONG_UNBROKEN} remediation`);
  cleanup();
  const routing = await mount({ boardSettings: [{ ok: true, data: longRoutingSettings() }] }, 'Routing');
  expect(routing.view.getByRole('table', { name: 'Routing transitions' }).textContent).toContain(LONG_UNBROKEN);
});

it('teams_css_reflows_without_hiding_columns_or_clipping_dialogs', () => {
  for (const bp of [900, 700, 560]) expect(flat).toContain(`@media (max-width: ${bp}px)`);
  expect(flat).toMatch(/\.teams-overview \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  expect(flat).toMatch(/\.teams-member-detail \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  expect(flat).toMatch(/@media \(max-width: 900px\) \{ \.teams-overview, \.teams-member-detail, \.routing-rule-grid, \.routing-escalation-fields \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  expect(flat).toMatch(/\.teams-overview > \*, \.teams-member-detail > \*[^{]*\{ min-width: 0; \}/);
  expect(flat).toMatch(/@media \(max-width: 700px\) \{[^@]*\.routing-table-wrap \{ overflow-x: auto; max-width: 100%; \}/);
  expect(flat).toMatch(/@media \(max-width: 700px\) \{[^@]*\.teams-member-row \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  expect(flat).toMatch(/@media \(max-width: 560px\) \{[^@]*\.teams-live-modal \[role="dialog"\] \{ width: calc\(100vw - 32px\); max-height: calc\(100vh - 32px\); overflow-y: auto; overflow-x: hidden; \}/);
  expect(flat).toMatch(/@media \(max-width: 560px\) \{[^@]*\.teams-team-actions[^{]*\{ display: grid; grid-template-columns: minmax\(0, 1fr\); \}/);
  expect(flat).toMatch(/overflow-wrap: anywhere; min-width: 0; max-width: 100%/);
  const rules = teamsRules();
  expect(rules.length).toBeGreaterThan(20);
  for (const { selector, body } of rules) {
    expect(body, selector).not.toMatch(/display: ?none/);
    expect(body, selector).not.toMatch(/text-overflow: ?ellipsis/);
    expect(body, selector).not.toMatch(/white-space: ?nowrap/);
    if (!/status-dot/.test(selector)) expect(body, selector).not.toMatch(/(?<![\w-])(min-)?width: ?\d+(px|rem|em)/);
  }
  expect(rules.find(r => /teams-live-modal/.test(r.selector) && /overflow-x: hidden/.test(r.body))).toBeTruthy();
});

it('teams_css_has_focus_hit_targets_and_reduced_motion', () => {
  expect(flat).toMatch(/\.teams-screen :is\(button, a, input:not\(\[type="checkbox"\]\), select, textarea, summary\) \{ min-height: 36px;/);
  expect(flat).toMatch(/\.teams-screen :is\(button, a, input, select, textarea, summary\):focus-visible \{ outline: 2px solid var\(--focus\); outline-offset: 2px; \}/);
  for (const { selector, body } of teamsRules()) {
    expect(body, selector).not.toMatch(/(^| )(transition|animation)(-[a-z]+)?:/);
  }
  expect(flat).toContain('@media (prefers-reduced-motion: reduce)');
  expect(flat).toMatch(/prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{[^}]*transition-duration: 0\.01ms !important/);
});

it('nested_team_buttons_have_unique_accessible_names_and_single_current_item', async () => {
  const fake = fakeManagement();
  const view = render(<main><TeamsHarness sidebar workspace={workspaceA} management={fake.api} /></main>);
  await act(async () => {});
  const rows = within(view.getByRole('list', { name: 'Workspace teams' })).getAllByRole('button');
  expect(rows.length).toBeGreaterThan(1);
  const names = rows.map(row => row.getAttribute('aria-label')!);
  expect(new Set(names).size).toBe(names.length);
  for (const name of names) expect(name).toMatch(/^Open .+, .+/);
  expect(rows.filter(row => row.getAttribute('aria-current') === 'page')).toHaveLength(1);
  expect(view.container.querySelectorAll('[aria-current="page"]:not(.breadcrumb *)')).toHaveLength(1);
  expect(rows.every(row => row.tagName === 'BUTTON' && !row.hasAttribute('tabindex'))).toBe(true);
});
