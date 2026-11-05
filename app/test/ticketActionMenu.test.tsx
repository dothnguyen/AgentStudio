// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BacklogScreen } from '../src/renderer/boards/BacklogScreen';
import type { BoardTicketList } from '../src/renderer/api';
import { boardTicketListFixture, boardTicketSummary } from './boardFixtures';
import { workspaceA } from './dashboardFixtures';
import { fakeManagement } from './teamsFixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ok = <T,>(data: T) => ({ ok: true as const, data });
const settle = () => act(async () => {});

function listOf(...keys: string[]): BoardTicketList {
  return boardTicketListFixture({
    tickets: keys.map((key) => boardTicketSummary({ key, title: `${key} title`, phase: 'phase-05' })),
  });
}

function renderBacklog(tickets: BoardTicketList = listOf('T-1', 'T-2', 'T-3'), refreshed: BoardTicketList[] = []) {
  const fake = fakeManagement({ boardTickets: [...refreshed.map((data) => ok(data)), ok(tickets)] });
  const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
  return { view, fake };
}

const triggerFor = (key: string) => screen.getByRole('button', { name: `Actions for ${key}` }) as HTMLButtonElement;
const menuFor = (key: string) => screen.getByRole('menu', { name: `${key} actions` });
const box = (left: number, top: number, width: number, height: number): DOMRect => ({
  left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}),
}) as DOMRect;

describe('ticket action menus', () => {
  it('opens one row menu at a time and closes the previous row menu first', async () => {
    renderBacklog();
    await settle();

    fireEvent.click(triggerFor('T-1'));
    await settle();
    expect(menuFor('T-1').closest('[data-action-menu-root]')?.parentElement).toBe(document.body);

    fireEvent.click(triggerFor('T-2'));
    await settle();
    expect(screen.queryByRole('menu', { name: 'T-1 actions' })).toBeNull();
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(menuFor('T-2')).toBeTruthy();
    expect(triggerFor('T-1').getAttribute('aria-expanded')).toBe('false');
    expect(triggerFor('T-2').getAttribute('aria-expanded')).toBe('true');
  });

  it('toggles the same trigger and returns focus to it when closed', async () => {
    renderBacklog();
    await settle();
    const trigger = triggerFor('T-1');
    trigger.focus();

    fireEvent.click(trigger);
    await settle();
    expect(menuFor('T-1')).toBeTruthy();

    fireEvent.click(trigger);
    await settle();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on an outside pointerdown and on Escape, restoring trigger focus', async () => {
    renderBacklog();
    await settle();

    fireEvent.click(triggerFor('T-1'));
    await settle();
    fireEvent.pointerDown(document.body);
    await settle();
    expect(screen.queryByRole('menu')).toBeNull();

    const trigger = triggerFor('T-1');
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    await settle();
    const firstItem = screen.getByRole('menuitem', { name: 'Change phase' });
    expect(document.activeElement).toBe(firstItem);

    fireEvent.keyDown(firstItem, { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when an action is selected, moving focus to the action destination and back on close', async () => {
    renderBacklog();
    await settle();
    const trigger = triggerFor('T-1');
    trigger.focus();
    fireEvent.click(trigger);
    await settle();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Change phase' }));
    await settle();
    expect(screen.queryByRole('menu')).toBeNull();
    const dialog = screen.getByRole('dialog', { name: /Change phase for T-1/ });
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes its menu when a refresh removes the row', async () => {
    const initial = listOf('T-1', 'T-2');
    renderBacklog(initial, [initial, listOf('T-2')]);
    await settle();
    fireEvent.click(triggerFor('T-1'));
    await settle();
    expect(menuFor('T-1')).toBeTruthy();

    await act(async () => { window.dispatchEvent(new Event('board-changed')); });
    await settle();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('button', { name: /Open T-1:/ })).toBeNull();
    expect(triggerFor('T-2')).toBeTruthy();
  });

  it('removes the portal when the screen unmounts on a route change', async () => {
    const { view } = renderBacklog();
    await settle();
    fireEvent.click(triggerFor('T-1'));
    await settle();
    expect(screen.getAllByRole('menu')).toHaveLength(1);

    view.unmount();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('flips above a bottom-row trigger and keeps the measured max height', async () => {
    const original = Element.prototype.getBoundingClientRect;
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element): DOMRect {
      if (this instanceof HTMLElement && this.classList.contains('ui-menu')) return box(0, 0, 240, 260);
      if (this instanceof HTMLElement && this.id.endsWith('-trigger')) return box(900, 700, 28, 28);
      return original.call(this);
    });
    try {
      renderBacklog();
      await settle();
      fireEvent.click(triggerFor('T-1'));
      await settle();
      const menu = menuFor('T-1');
      expect(parseFloat(menu.style.top)).toBeLessThan(700);
      expect(menu.style.top).toBe('436px');
      expect(menu.style.maxHeight).toBe('752px');
    } finally {
      spy.mockRestore();
    }
  });

  it('shifts a wide menu horizontally to stay inside the viewport', async () => {
    const original = Element.prototype.getBoundingClientRect;
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element): DOMRect {
      if (this instanceof HTMLElement && this.classList.contains('ui-menu')) return box(0, 0, 300, 200);
      if (this instanceof HTMLElement && this.id.endsWith('-trigger')) return box(1000, 100, 28, 28);
      return original.call(this);
    });
    try {
      renderBacklog();
      await settle();
      fireEvent.click(triggerFor('T-1'));
      await settle();
      const menu = menuFor('T-1');
      expect(menu.style.left).toBe('716px');
      expect(parseFloat(menu.style.left) + 300).toBeLessThanOrEqual(1024 - 8);
    } finally {
      spy.mockRestore();
    }
  });

  it('repositions while the trigger container scrolls and the window resizes', async () => {
    const original = Element.prototype.getBoundingClientRect;
    let triggerTop = 100;
    let triggerLeft = 400;
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element): DOMRect {
      if (this instanceof HTMLElement && this.classList.contains('ui-menu')) return box(0, 0, 240, 160);
      if (this instanceof HTMLElement && this.id.endsWith('-trigger')) return box(triggerLeft, triggerTop, 28, 28);
      return original.call(this);
    });
    try {
      renderBacklog();
      await settle();
      fireEvent.click(triggerFor('T-1'));
      await settle();
      expect(menuFor('T-1').style.top).toBe('132px');

      triggerTop = 300;
      triggerLeft = 900;
      fireEvent.scroll(document.body);
      await settle();
      expect(menuFor('T-1').style.top).toBe('332px');
      expect(menuFor('T-1').style.left).toBe('688px');

      triggerTop = 350;
      fireEvent(window, new Event('resize'));
      await settle();
      expect(menuFor('T-1').style.top).toBe('382px');
      expect(screen.getByRole('menu', { name: 'T-1 actions' })).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('renders in a fixed portal above clipping containers without changing the list layout', async () => {
    const { view } = renderBacklog();
    await settle();
    const rowsBefore = view.container.querySelectorAll('.boards-backlog-row').length;
    fireEvent.click(triggerFor('T-1'));
    await settle();

    const menu = menuFor('T-1');
    expect(menu.closest('.boards-backlog-group')).toBeNull();
    expect(menu.closest('[data-action-menu-root]')?.parentElement).toBe(document.body);
    expect(view.container.querySelector('[role="menu"]')).toBeNull();
    expect(view.container.querySelectorAll('.boards-backlog-row')).toHaveLength(rowsBefore);

    const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8').replace(/\s+/g, ' ');
    expect(css).toMatch(/\.ui-menu \{[^}]*position: fixed; z-index: 1000;[^}]*\}/);
    expect(css).toMatch(/\.ui-menu \{[^}]*max-height: calc\(100vh - 16px\);[^}]*\}/);
    expect(css).toMatch(/\.ui-menu \{[^}]*overflow-y: auto;[^}]*\}/);
  });
});
