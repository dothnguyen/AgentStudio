// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CurrentPhaseScreen } from '../src/renderer/boards/CurrentPhaseScreen';
import { BacklogScreen } from '../src/renderer/boards/BacklogScreen';
import { PhasesScreen } from '../src/renderer/boards/PhasesScreen';
import { TicketScreen } from '../src/renderer/boards/TicketScreen';
import { boardPhasesFixture, boardTicketDetailFixture, boardTicketListFixture, boardTicketSummary } from './boardFixtures';
import { workspaceA } from './dashboardFixtures';
import { fakeManagement } from './teamsFixtures';

afterEach(cleanup);

const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8');
const flat = css.replace(/\s+/g, ' ');

async function settle(): Promise<void> {
  await act(async () => {});
}

function headingLevels(root: ParentNode): number[] {
  return Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    .map((heading) => Number(heading.tagName.slice(1)));
}

function expectLogicalHeadings(root: ParentNode): void {
  const levels = headingLevels(root);
  expect(levels.every((level) => level === 1 || level === 2)).toBe(true);
  levels.forEach((level, index) => {
    if (index > 0) expect(level).toBeLessThanOrEqual(levels[index - 1]! + 1);
  });
}

function expectNamedControls(root: ParentNode): void {
  for (const control of Array.from(root.querySelectorAll<HTMLButtonElement>('button'))) {
    expect((control.getAttribute('aria-label') ?? control.textContent ?? '').trim().length).toBeGreaterThan(0);
  }
}

async function renderBoard() {
  const view = render(
    <CurrentPhaseScreen
      workspace={workspaceA}
      management={fakeManagement({ boardTickets: [{ ok: true, data: boardTicketListFixture({ tickets: boardTicketListFixture().tickets.map(ticket => ({ ...ticket, status: ticket.status === 'done' ? 'done' : 'in-progress' })) }) }] }).api}
      hideEmpty={false}
      refreshMs={0}
    />,
  );
  await settle();
  return view;
}

async function renderTicket() {
  const fake = fakeManagement({
    calls: { boardTicket: vi.fn(async (_id: string, input: { key: string }) => ({ ok: true as const, data: boardTicketDetailFixture(input.key) })) },
  });
  const view = render(
    <TicketScreen
      workspace={workspaceA}
      management={fake.api}
      ticketKey="T-114"
      onOpenBoard={vi.fn()}
      onOpenTicket={vi.fn()}
    />,
  );
  await settle();
  return view;
}

describe('Current Phase accessibility', () => {
  it('has one h1, logical headings, named lanes, columns and controls', async () => {
    const view = await renderBoard();

    expect(view.getByRole('navigation', { name: 'Breadcrumb' })).toBeTruthy();
    expect(view.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Phase 05');
    expectLogicalHeadings(view.container);
    expectNamedControls(view.container);

    expect(view.getByRole('region', { name: 'Backlog column' })).toBeTruthy();
    expect(view.getByRole('heading', { level: 2, name: 'Backlog' })).toBeTruthy();
  });

  it('exposes every filter chip as a native aria-pressed toggle with text', async () => {
    const view = await renderBoard();
    const chips = ['Blocked only', 'Working now', 'Hide empty columns'];

    for (const name of chips) {
      const chip = view.getByRole('button', { name });
      expect(chip.tagName).toBe('BUTTON');
      const before = chip.getAttribute('aria-pressed');
      expect(before === 'true' || before === 'false').toBe(true);
      expect(chip.textContent).toBe(name);
      fireEvent.click(chip);
      expect(chip.getAttribute('aria-pressed')).toBe(before === 'true' ? 'false' : 'true');
    }
    expect(view.queryByRole('button', { name: '' })).toBeNull();
  });

  it('never relies on colour alone for a card status', async () => {
    const view = await renderBoard();
    const card = view.container.querySelector<HTMLElement>('[data-ticket-key="T-114"]')!;

    const chip = card.querySelector<HTMLElement>('.boards-ticket-chip')!;
    expect(chip.textContent?.trim().length).toBeGreaterThan(0);
    expect(chip.querySelector('.boards-ticket-chip-dot')?.getAttribute('aria-hidden')).toBe('true');
    expect(card.querySelector('.boards-ticket-key')?.textContent).toBe('T-114');
  });

  it('reaches the toolbar and board in visual order', async () => {
    const view = await renderBoard();
    const user = userEvent.setup();
    view.getByPlaceholderText('Search tickets').focus();

    await user.tab();
    expect(document.activeElement).toBe(view.getByRole('combobox', { name: 'Workflow status' }));
    await user.tab();
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'Blocked only' }));
    await user.tab();
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'Working now' }));
    await user.tab();
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'Hide empty columns' }));
    await user.tab();
    expect(document.activeElement).toBe(view.getByRole('region', { name: 'Board columns (scrollable)' }));
    await user.tab();
    expect(document.activeElement).toBe(view.container.querySelector('.boards-board [data-ticket-key]'));
  });
});

describe('Ticket page accessibility', () => {
  it('has one h1, landmarks, card headings and named controls', async () => {
    const view = await renderTicket();

    expect(view.getByRole('navigation', { name: 'Breadcrumb' })).toBeTruthy();
    expect(view.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Roles v2: edit dialogs and the New role dialog');
    expect(view.getByRole('complementary', { name: 'Ticket details' })).toBeTruthy();
    for (const name of ['Description', 'Timeline', 'Work', 'Dependencies', 'Details']) {
      expect(view.getByRole('region', { name })).toBeTruthy();
      expect(view.getByRole('heading', { level: 2, name })).toBeTruthy();
    }
    expectLogicalHeadings(view.container);
    expectNamedControls(view.container);
  });

  it('spells out status and activity beside their colour dots', async () => {
    const view = await renderTicket();
    const status = view.container.querySelector('.boards-ticket-status-chip')!;
    const activity = view.container.querySelector('.boards-ticket-activity-chip')!;

    expect(status.textContent).toBe('Dev ready');
    expect(status.querySelector('.boards-status-dot')?.getAttribute('aria-hidden')).toBe('true');
    expect(activity.textContent).toContain('Working');
    expect(activity.querySelector('.boards-ticket-chip-dot')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('reaches the dependency keys after the description and timeline in visual order', async () => {
    const view = await renderTicket();
    const user = userEvent.setup();
    const breadcrumb = view.getByRole('button', { name: 'Current Phase' });
    breadcrumb.focus();

    await user.tab();
    const firstDependency = view.getByRole('button', { name: /T-113/ });
    expect(document.activeElement).toBe(firstDependency);
    const dependencies = view.getByRole('region', { name: 'Dependencies' });
    expect(dependencies.compareDocumentPosition(breadcrumb) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });
});

describe('Boards responsive contract', () => {
  it('stacks the ticket aside under the main column at 1100px', () => {
    expect(flat).toContain('@media (max-width: 1100px) { .boards-ticket-layout { flex-direction: column; } .boards-ticket-main, .boards-ticket-aside { flex: none; width: 100%; max-width: none; } }');
  });

  it('scrolls board lanes horizontally without a page scrollbar', () => {
    expect(flat).toContain('.boards-board { max-width: 100%; min-width: 0; overflow-x: auto;');
    expect(flat).toContain('.boards-board-lanes { display: flex; align-items: flex-start; gap: 26px; width: max-content; min-width: 100%; }');
    expect(flat).toContain('.boards-current-screen { display: flex; flex-direction: column; gap: 20px; max-width: 1240px; margin: 0 auto; min-width: 0; overflow-x: clip;');
  });
});

describe('Backlog and Phases accessibility', () => {
  it('renders the phase form as an associated responsive form with field errors and ordered keyboard focus', async () => {
    const createPhase = vi.fn(async () => ({ ok: true as const, data: { phase: { ...boardPhasesFixture().phases[0]!, id: 'x-id', slug: 'x', name: 'X', position: 2, current: false, ticketCount: 0, counts: {} } } }));
    const view = render(<PhasesScreen workspace={workspaceA} management={fakeManagement({ calls: { createPhase } }).api} refreshMs={0} />);
    await settle();
    await userEvent.setup().click(view.getByRole('button', { name: 'New phase' }));
    const name = view.getByRole('textbox', { name: 'Phase name' });
    const slug = view.getByRole('textbox', { name: 'Phase ID / slug' });
    const description = view.getByRole('textbox', { name: 'Description (optional)' });
    const placement = view.getByRole('combobox', { name: 'Place before' });
    expect(document.activeElement).toBe(name);
    expect(name.getAttribute('aria-invalid')).toBeNull();
    for (const control of [name, slug, description, placement]) expect(control.id).toBeTruthy();
    expect(view.getByText('Stable ID used by CLI and configuration.').id).toBe(slug.getAttribute('aria-describedby')?.split(' ')[0]);
    const user = userEvent.setup();
    await user.tab(); expect(document.activeElement).toBe(slug);
    await user.tab(); expect(document.activeElement).toBe(description);
    await user.tab(); expect(document.activeElement).toBe(placement);
    await user.click(view.getByRole('button', { name: 'Create phase' }));
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(name.getAttribute('aria-describedby')).toBe(view.getByText('Phase name is required.').id);
    expect(slug.getAttribute('aria-invalid')).toBe('true');
    expect(slug.getAttribute('aria-describedby')).toContain(view.getByText(/Use a lowercase slug/).id);
    expect(view.getByRole('dialog').querySelector('.phase-dialog-row')).toBeTruthy();
    expect(flat).toContain('.phase-dialog-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(flat).toContain('.phase-dialog-row { grid-template-columns: minmax(0, 1fr); }');
    expect(flat).toContain('.phase-dialog-fields select {');
  });

  it('disables phase fields and actions while creation is pending', async () => {
    let resolveCreate!: (value: { ok: true; data: { phase: ReturnType<typeof boardPhasesFixture>['phases'][number] } }) => void;
    const createPhase = vi.fn(() => new Promise<{ ok: true; data: { phase: ReturnType<typeof boardPhasesFixture>['phases'][number] } }>(resolve => { resolveCreate = resolve; }));
    const view = render(<PhasesScreen workspace={workspaceA} management={fakeManagement({ calls: { createPhase } }).api} refreshMs={0} />);
    await settle(); await userEvent.setup().click(view.getByRole('button', { name: 'New phase' }));
    await userEvent.setup().type(view.getByRole('textbox', { name: 'Phase name' }), 'Busy');
    await userEvent.setup().click(view.getByRole('button', { name: 'Create phase' }));
    expect(view.getByRole('textbox', { name: 'Phase name' }).hasAttribute('disabled')).toBe(true);
    expect(view.getByRole('combobox', { name: 'Place before' }).hasAttribute('disabled')).toBe(true);
    expect(view.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
    resolveCreate({ ok: true, data: { phase: { ...boardPhasesFixture().phases[0]!, id: 'busy-id', slug: 'busy', name: 'Busy', current: false, ticketCount: 0, counts: {} } } });
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
  });

  it('handles long phase names, descriptions, and labels without overflow or clipping', async () => {
    const createPhase = vi.fn(async () => ({ ok: true as const, data: { phase: { ...boardPhasesFixture().phases[0]!, id: 'x-id', slug: 'x', name: 'X', position: 2, current: false, ticketCount: 0, counts: {} } } }));
    const view = render(<PhasesScreen workspace={workspaceA} management={fakeManagement({ calls: { createPhase } }).api} refreshMs={0} />);
    await settle();
    await userEvent.setup().click(view.getByRole('button', { name: 'New phase' }));
    const name = view.getByRole('textbox', { name: 'Phase name' });
    const description = view.getByRole('textbox', { name: 'Description (optional)' });
    const dialog = view.getByRole('dialog');
    const dialogBody = dialog.querySelector('.dialog-body')!;
    const initialHeight = dialogBody.getBoundingClientRect().height;
    await userEvent.setup().type(name, 'This is an exceptionally long phase name that spans multiple words');
    const afterNameHeight = dialogBody.getBoundingClientRect().height;
    expect(name).toHaveProperty('value', 'This is an exceptionally long phase name that spans multiple words');
    expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth + 1);
    await userEvent.setup().type(description, 'A comprehensive description explaining the purpose and scope of this phase with multiple sentences that form a longer text block to test overflow handling');
    const afterDescHeight = dialogBody.getBoundingClientRect().height;
    expect(description.scrollWidth).toBeLessThanOrEqual(description.clientWidth + 1);
    expect(afterDescHeight).toBeGreaterThanOrEqual(afterNameHeight);
    expect(flat).toContain('.phase-dialog-fields [aria-invalid="true"] { border-color:');
    expect(flat).toContain('.role-dialog-field-error { margin: 0; color:');
    expect(flat).toContain('overflow-wrap: anywhere;');
  });

  it('supports input maxLength attributes and responsive label wrapping', async () => {
    const createPhase = vi.fn(async () => ({ ok: true as const, data: { phase: { ...boardPhasesFixture().phases[0]!, id: 'x-id', slug: 'x', name: 'X', position: 2, current: false, ticketCount: 0, counts: {} } } }));
    const view = render(<PhasesScreen workspace={workspaceA} management={fakeManagement({ calls: { createPhase } }).api} refreshMs={0} />);
    await settle();
    await userEvent.setup().click(view.getByRole('button', { name: 'New phase' }));
    const name = view.getByRole('textbox', { name: 'Phase name' });
    const slug = view.getByRole('textbox', { name: 'Phase ID / slug' });
    const description = view.getByRole('textbox', { name: 'Description (optional)' });
    expect(name.getAttribute('maxLength')).toBe('80');
    expect(slug.getAttribute('maxLength')).toBe('64');
    expect(description.getAttribute('maxLength')).toBe('2000');
    expect(description.getAttribute('rows')).toBe('4');
    const select = view.getByRole('combobox', { name: 'Place before' });
    expect(select).toBeTruthy();
    const formFields = view.getByRole('dialog').querySelectorAll('.role-dialog-field');
    expect(formFields.length).toBe(4);
    for (const field of formFields) {
      const label = field.querySelector('label');
      expect(label).toBeTruthy();
      expect(label?.textContent?.trim().length).toBeGreaterThan(0);
      const control = field.querySelector('input, textarea, select');
      expect(control).toBeTruthy();
      expect(['input', 'textarea', 'select']).toContain(control?.tagName.toLowerCase());
    }
  });

  it('creates a phase with generated or edited ID, description and order, then restores focus', async () => {
    const created = { ...boardPhasesFixture().phases[0]!, id: 'phase-new-id', slug: 'my-phase', name: 'My Phase', description: 'Details', position: 1, current: false, ticketCount: 0, counts: { backlog: 0, todo: 0, 'in-progress': 0, done: 0, closed: 0 } };
    const createPhase = vi.fn(async () => ({ ok: true as const, data: { phase: created } }));
    const fake = fakeManagement({ calls: { createPhase } });
    const view = render(<PhasesScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    const trigger = view.getByRole('button', { name: 'New phase' });
    await userEvent.setup().click(trigger);
    const name = view.getByRole('textbox', { name: 'Phase name' });
    await userEvent.setup().type(name, 'My Phase');
    expect(view.getByRole('textbox', { name: /Phase ID/ })).toHaveProperty('value', 'my-phase');
    await userEvent.setup().clear(view.getByRole('textbox', { name: /Phase ID/ }));
    await userEvent.setup().type(view.getByRole('textbox', { name: /Phase ID/ }), 'my-phase');
    await userEvent.setup().type(view.getByRole('textbox', { name: 'Description (optional)' }), 'Details');
    await userEvent.setup().selectOptions(view.getByRole('combobox', { name: 'Place before' }), 'phase-06');
    await userEvent.setup().click(view.getByRole('button', { name: 'Create phase' }));
    await waitFor(() => expect(createPhase).toHaveBeenCalledWith(workspaceA.id, { id: 'my-phase', name: 'My Phase', description: 'Details', before: 'phase-06' }));
    await waitFor(() => expect(view.getByRole('heading', { name: 'My Phase' })).toBeTruthy());
    expect(document.activeElement).toBe(trigger);
  });

  it('rejects duplicate and invalid phase IDs and preserves fields after backend failure for retry', async () => {
    const createPhase = vi.fn().mockResolvedValueOnce({ ok: false as const, error: { code: 'PHASE_EXISTS', message: 'Duplicate ID', retryable: false } }).mockResolvedValue({ ok: true as const, data: { phase: { ...boardPhasesFixture().phases[0]!, id: 'x-id', slug: 'x', name: 'X', position: 2, current: false, ticketCount: 0, counts: {} } } });
    const view = render(<PhasesScreen workspace={workspaceA} management={fakeManagement({ calls: { createPhase } }).api} refreshMs={0} />);
    await settle(); await userEvent.setup().click(view.getByRole('button', { name: 'New phase' }));
    await userEvent.setup().type(view.getByRole('textbox', { name: 'Phase name' }), 'Keep Me');
    const slug = view.getByRole('textbox', { name: /Phase ID/ });
    await userEvent.setup().clear(slug); await userEvent.setup().type(slug, 'Bad ID');
    await userEvent.setup().click(view.getByRole('button', { name: 'Create phase' }));
    expect(view.getByRole('alert').textContent).toContain('lowercase slug'); expect(createPhase).not.toHaveBeenCalled();
    await userEvent.setup().clear(slug); await userEvent.setup().type(slug, 'phase-05');
    await userEvent.setup().click(view.getByRole('button', { name: 'Create phase' }));
    expect(view.getByRole('alert').textContent).toContain('already exists'); expect(createPhase).not.toHaveBeenCalled();
    await userEvent.setup().clear(slug); await userEvent.setup().type(slug, 'x');
    await userEvent.setup().click(view.getByRole('button', { name: 'Create phase' }));
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('Duplicate ID'));
    expect(view.getByRole('textbox', { name: 'Phase name' })).toHaveProperty('value', 'Keep Me');
    await userEvent.setup().click(view.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
  });

  it('cancels by keyboard, restores opener focus, and prevents concurrent submissions', async () => {
    let resolveCreate!: (value: { ok: true; data: { phase: ReturnType<typeof boardPhasesFixture>['phases'][number] } }) => void;
    const createPhase = vi.fn(() => new Promise<{ ok: true; data: { phase: ReturnType<typeof boardPhasesFixture>['phases'][number] } }>(resolve => { resolveCreate = resolve; }));
    const view = render(<PhasesScreen workspace={workspaceA} management={fakeManagement({ calls: { createPhase } }).api} refreshMs={0} />);
    await settle();
    const trigger = view.getByRole('button', { name: 'New phase' });
    await userEvent.setup().click(trigger);
    await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await userEvent.setup().click(trigger);
    await userEvent.setup().type(view.getByRole('textbox', { name: 'Phase name' }), 'Slow');
    await userEvent.setup().click(view.getByRole('button', { name: 'Create phase' }));
    expect(view.getByRole('button', { name: 'Creating…' }).hasAttribute('disabled')).toBe(true);
    expect(createPhase).toHaveBeenCalledTimes(1);
    resolveCreate({ ok: true, data: { phase: { ...boardPhasesFixture().phases[0]!, id: 'slow-id', slug: 'slow', name: 'Slow', current: false, ticketCount: 0, counts: {} } } });
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
  });

  it('keeps headings at h1 or h2 and connects each group button to its panel', async () => {
    const backlog = render(
      <BacklogScreen
        workspace={workspaceA}
        management={fakeManagement({ boardTickets: [{ ok: true, data: boardTicketListFixture({ tickets: [boardTicketSummary()] }) }] }).api}
      />,
    );
    await settle();
    expect(backlog.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expectLogicalHeadings(backlog.container);
    expect(backlog.container.querySelectorAll('h3, h4, h5, h6')).toHaveLength(0);
    const groupButton = backlog.container.querySelector<HTMLButtonElement>('.boards-backlog-group-header')!;
    expect(groupButton.getAttribute('aria-expanded')).toBe('true');
    const controlledPanel = document.getElementById(groupButton.getAttribute('aria-controls')!)!;
    expect(controlledPanel.id).toBe(groupButton.getAttribute('aria-controls'));
    expect(controlledPanel.querySelector('.boards-backlog-row')).toBeTruthy();
    expect(controlledPanel.querySelectorAll('button, a, input, select, [tabindex]')).toHaveLength(2);
    expect(controlledPanel.querySelector('[aria-label^="Actions for "]')).toBeTruthy();
    backlog.unmount();

    const phases = render(
      <PhasesScreen workspace={workspaceA} management={fakeManagement({ boardPhases: [{ ok: true, data: boardPhasesFixture() }] }).api} />,
    );
    await settle();
    expect(phases.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expectLogicalHeadings(phases.container);
    expect(phases.container.querySelectorAll('h3, h4, h5, h6')).toHaveLength(0);
    for (const track of phases.container.querySelectorAll('[role="img"]')) {
      expect(track.getAttribute('aria-label')?.trim().length).toBeGreaterThan(0);
    }
  });

  it('uses an accessible dialog and keyboard behavior for backlog filter popovers', async () => {
    const view = render(
      <BacklogScreen
        workspace={workspaceA}
        management={fakeManagement({ boardTickets: [{ ok: true, data: boardTicketListFixture({ tickets: [boardTicketSummary()] }) }] }).api}
      />,
    );
    await settle();

    const trigger = view.getByRole('button', { name: 'Activity' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    const controlledId = trigger.getAttribute('aria-controls');
    expect(controlledId).toBeTruthy();
    fireEvent.click(trigger);
    const dialog = view.getByRole('dialog', { name: 'Activity options' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(dialog.id).toBe(controlledId);
    const firstOption = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await waitFor(() => expect(document.activeElement).toBe(firstOption));

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(view.queryByRole('dialog', { name: 'Activity options' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-controls')).toBe(controlledId);
  });

  it('labels the Current Phase progress graphic and keeps all phase cards in one column', async () => {
    const current = await renderBoard();
    const progress = current.container.querySelector('[role="progressbar"]');
    expect(progress?.getAttribute('aria-label')?.trim()).toBeTruthy();
    current.unmount();

    expect(flat).toContain('.boards-milestone-list { display: flex; flex-direction: column;');
  });
});

describe('Board cross-link styles', () => {
  it('renders ticket keys as keyboard-focusable link-style buttons on Home and Teams', () => {
    expect(flat).toContain('.board-ticket-key-link { padding: 0; border: 0; background: transparent; color: #9ec3ff; cursor: pointer; text-align: left; }');
    expect(flat).toContain('.board-ticket-key-link:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 3px; }');
    expect(flat).toContain('.teams-member-work-ticket { all: unset; cursor: pointer; border-radius: 3px; color: #7fb2ff;');
    expect(flat).toContain('.teams-member-work-ticket:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }');
  });
});

it('documents all Boards destinations and leaves no Boards placeholder copy', () => {
  const appReadme = readFileSync(resolve(__dirname, '../README.md'), 'utf8');
  const placeholder = readFileSync(resolve(__dirname, '../src/renderer/sections/SectionPlaceholder.tsx'), 'utf8');
  for (const section of ['Current Phase', 'Backlog', 'Phases']) expect(appReadme).toContain(section);
  expect(placeholder).not.toMatch(/Boards|Backlog|Phases/);
});

it('keeps Backlog columns responsive and Phases in one column', () => {
  expect(flat).toContain('@media (max-width: 1100px) { .boards-backlog-toolbar-row { flex-wrap: wrap; }');
  expect(flat).toContain('@media (max-width: 799px) { .boards-backlog-row .boards-ticket-owner, .boards-backlog-time { display: none; } }');
  expect(flat).toContain('.boards-milestone-list { display: flex; flex-direction: column;');
});
