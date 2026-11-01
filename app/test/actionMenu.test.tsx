// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionMenu } from '../src/renderer/ui/ActionMenu';
import type { MenuItem } from '../src/renderer/ui/actionMenuModel';

afterEach(cleanup);

function makeItems(overrides: { onOne?: (trigger: HTMLElement) => void; onTwo?: (trigger: HTMLElement) => void } = {}): MenuItem[] {
  return [
    { kind: 'action', id: 'one', label: 'One', onSelect: overrides.onOne ?? (() => undefined) },
    { kind: 'action', id: 'two', label: 'Two', onSelect: overrides.onTwo ?? (() => undefined) },
    { kind: 'separator' },
    { kind: 'action', id: 'three', label: 'Three', checked: true, onSelect: () => undefined },
    { kind: 'heading', label: 'More' },
    { kind: 'action', id: 'four', label: 'Four', disabledReason: 'Four is not available.', onSelect: () => undefined },
  ];
}

function submenuItems(onChild = vi.fn()): MenuItem[] {
  return [
    {
      kind: 'submenu',
      id: 'parent',
      label: 'Parent',
      items: [
        { kind: 'action', id: 'child-one', label: 'Child one', onSelect: onChild },
        { kind: 'action', id: 'child-two', label: 'Child two', onSelect: () => undefined },
      ],
    },
    { kind: 'action', id: 'after', label: 'After', onSelect: () => undefined },
  ];
}

const trigger = (name = 'Team actions') => screen.getByRole('button', { name }) as HTMLButtonElement;
const menu = (name = 'Team actions') => screen.getByRole('menu', { name });
const item = (name: string | RegExp) => screen.getByRole('menuitem', { name });
const flush = () => act(async () => {});

describe('ActionMenu trigger and portal', () => {
  it('renders an accessible trigger that opens into a fixed portal on document.body', async () => {
    render(<ActionMenu label="Team actions" items={makeItems()} />);
    const button = trigger();
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBeTruthy();
    fireEvent.click(button); await flush();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const menuElement = menu();
    expect(menuElement.getAttribute('aria-label')).toBe('Team actions');
    expect(menuElement.closest('[data-action-menu-root]')?.parentElement).toBe(document.body);
    expect(document.activeElement).toBe(item('One'));
  });

  it('focuses only after each level has been placed and is visible', async () => {
    const seen: string[] = [];
    const originalFocus = HTMLElement.prototype.focus;
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement): void {
      const level = this.closest('[role="menu"]') as HTMLElement | null;
      if (level !== null) seen.push(level.style.visibility === '' ? 'unset' : level.style.visibility);
      originalFocus.call(this);
    });
    try {
      render(<ActionMenu label="Team actions" items={submenuItems()} />);
      fireEvent.click(trigger()); await flush();
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((state) => state === 'visible')).toBe(true);
      fireEvent.keyDown(item('Parent'), { key: 'ArrowRight' }); await flush();
      expect(document.activeElement).toBe(item('Child one'));
      // Every focus call targeted an already visible level, including the submenu.
      expect(seen.every((state) => state === 'visible')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('places the menu from its measured size instead of a fixed estimate', async () => {
    const originalRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      if (this instanceof HTMLElement && this.classList.contains('ui-menu')) {
        return { left: 0, top: 0, width: 300, height: 100, right: 300, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      if (this instanceof HTMLElement && this.id.endsWith('-trigger')) {
        return { left: 800, top: 100, width: 28, height: 28, right: 828, bottom: 128, x: 800, y: 100, toJSON: () => ({}) } as DOMRect;
      }
      return originalRect.call(this);
    };
    try {
      render(<ActionMenu label="Team actions" items={makeItems()} />);
      fireEvent.click(trigger()); await flush();
      expect(menu().style.left).toBe('528px');
      expect(menu().style.top).toBe('132px');
      expect(menu().style.maxHeight).toBe('752px');
    } finally {
      Element.prototype.getBoundingClientRect = originalRect;
    }
  });

  it('opens a submenu to the right of its parent item', async () => {
    const originalRect = Element.prototype.getBoundingClientRect;
    const box = (left: number, top: number, width: number, height: number): DOMRect => ({
      left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}),
    }) as DOMRect;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      if (this instanceof HTMLElement) {
        if (this.classList.contains('ui-menu')) {
          return this.getAttribute('data-menu-level') === '1' ? box(0, 0, 220, 120) : box(0, 0, 200, 100);
        }
        if (this.id.endsWith('-trigger')) return box(700, 100, 28, 28);
        if (this.getAttribute('data-menu-item-id') === 'parent') return box(600, 120, 160, 32);
      }
      return originalRect.call(this);
    };
    try {
      render(<ActionMenu label="Team actions" items={submenuItems()} />);
      fireEvent.click(trigger()); await flush();
      fireEvent.click(item('Parent')); await flush();
      const levels = screen.getAllByRole('menu');
      expect(levels).toHaveLength(2);
      expect(levels[1]!.style.left).toBe('764px');
      expect(levels[1]!.style.top).toBe('120px');
    } finally {
      Element.prototype.getBoundingClientRect = originalRect;
    }
  });

  it('closes an open menu when the trigger becomes disabled', async () => {
    const view = render(<ActionMenu label="Team actions" items={makeItems()} />);
    fireEvent.click(trigger()); await flush();
    expect(screen.getByRole('menu')).toBeTruthy();
    view.rerender(<ActionMenu label="Team actions" items={makeItems()} disabled />);
    await flush();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('focuses the first item on open even when it is disabled', async () => {
    const items: MenuItem[] = [
      { kind: 'action', id: 'locked', label: 'Locked', disabledReason: 'Locked for now.', onSelect: () => undefined },
      { kind: 'action', id: 'free', label: 'Free', onSelect: () => undefined },
    ];
    render(<ActionMenu label="Team actions" items={items} />);
    fireEvent.click(trigger()); await flush();
    const locked = item('Locked');
    expect(locked.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(locked);
    fireEvent.keyDown(locked, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('Free'));
  });

  it('opens with ArrowDown, Enter and Space on the first item and ArrowUp on the last', async () => {
    const user = userEvent.setup();
    const first = render(<ActionMenu label="Team actions" items={makeItems()} />);
    trigger().focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(item('One'));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    first.unmount();

    const second = render(<ActionMenu label="Team actions" items={makeItems()} />);
    trigger().focus();
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(item('One'));
    await user.keyboard('{Escape}');
    second.unmount();

    const third = render(<ActionMenu label="Team actions" items={makeItems()} />);
    trigger().focus();
    await user.keyboard(' ');
    expect(document.activeElement).toBe(item('One'));
    await user.keyboard('{Escape}');
    third.unmount();

    render(<ActionMenu label="Team actions" items={makeItems()} />);
    trigger().focus();
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(item('Four'));
  });

  it('wraps with the arrow keys and jumps with Home and End', async () => {
    const user = userEvent.setup();
    render(<ActionMenu label="Team actions" items={makeItems()} />);
    fireEvent.click(trigger()); await flush();
    expect(document.activeElement).toBe(item('One'));
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(item('Four'));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(item('One'));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(item('Four'));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(item('One'));
  });

  it('describes an item with its description text', async () => {
    const items: MenuItem[] = [{
      kind: 'action', id: 'described', label: 'Described', description: 'Clears the Claude holds.', onSelect: () => undefined,
    }];
    render(<ActionMenu label="Team actions" items={items} />);
    fireEvent.click(trigger()); await flush();
    const described = item('Described');
    const ids = (described.getAttribute('aria-describedby') ?? '').split(/\s+/);
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain('Clears the Claude holds.');
  });

  it('exposes radio, separator and grouped-heading semantics', async () => {
    render(<ActionMenu label="Team actions" items={makeItems()} />);
    fireEvent.click(trigger()); await flush();
    const radio = screen.getByRole('menuitemradio', { name: 'Three' });
    expect(radio.getAttribute('aria-checked')).toBe('true');
    expect(screen.getAllByRole('separator')).toHaveLength(1);
    const group = screen.getByRole('group', { name: 'More' });
    expect(group.textContent).toBe('More');
    expect(group.querySelector('[role="presentation"]')).not.toBeNull();
  });
});

describe('ActionMenu keyboard and submenus', () => {
  it('opens a submenu with ArrowRight and refocuses the parent with ArrowLeft or Escape', async () => {
    const user = userEvent.setup();
    render(<ActionMenu label="Team actions" items={submenuItems()} />);
    fireEvent.click(trigger()); await flush();
    const parent = item('Parent');
    expect(parent.getAttribute('aria-haspopup')).toBe('menu');
    expect(parent.getAttribute('aria-expanded')).toBe('false');
    await user.keyboard('{ArrowRight}'); await flush();
    expect(parent.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(item('Child one'));
    expect(screen.getAllByRole('menu')).toHaveLength(2);
    expect(parent.getAttribute('aria-controls')).toBe(screen.getAllByRole('menu')[1]!.id);
    await user.keyboard('{ArrowLeft}'); await flush();
    expect(parent.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(parent);
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    await user.keyboard('{Enter}'); await flush();
    expect(document.activeElement).toBe(item('Child one'));
    await user.keyboard('{Escape}'); await flush();
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(document.activeElement).toBe(parent);
    await user.keyboard('{Escape}'); await flush();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('activates an action, closes the whole menu first and passes the trigger', async () => {
    let menuVisibleAtSelect: boolean | null = null;
    const onOne = vi.fn(() => { menuVisibleAtSelect = screen.queryByRole('menu') !== null; });
    render(<ActionMenu label="Team actions" items={makeItems({ onOne })} />);
    fireEvent.click(trigger()); await flush();
    fireEvent.click(item('One')); await flush();
    expect(menuVisibleAtSelect).toBe(false);
    expect(onOne).toHaveBeenCalledTimes(1);
    expect(onOne.mock.calls[0]![0]).toBe(trigger());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('keeps a disabled item focusable, describes its reason and does not fire it', async () => {
    const onFour = vi.fn();
    const items = makeItems();
    const four = items[5]!;
    if (four.kind === 'action') four.onSelect = onFour;
    render(<ActionMenu label="Team actions" items={items} />);
    fireEvent.click(trigger()); await flush();
    const disabled = item('Four');
    expect(disabled.getAttribute('aria-disabled')).toBe('true');
    const describedBy = disabled.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)!.textContent).toBe('Four is not available.');
    disabled.focus();
    expect(document.activeElement).toBe(disabled);
    fireEvent.click(disabled); await flush();
    expect(onFour).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('jumps to the next item starting with a typed letter and matches multi-letter buffers', async () => {
    const user = userEvent.setup();
    render(<ActionMenu label="Team actions" items={makeItems()} />);
    fireEvent.click(trigger()); await flush();
    await user.keyboard('t');
    expect(document.activeElement).toBe(item('Two'));
    // "th" keeps matching Three, so the buffer is not reset to the last letter.
    await user.keyboard('h');
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Three' }));
    await user.keyboard('f');
    expect(document.activeElement).toBe(item('Four'));
    // "fo" still matches Four, so typing "o" immediately does not jump away.
    await user.keyboard('o');
    expect(document.activeElement).toBe(item('Four'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 750)); });
    await user.keyboard('o');
    expect(document.activeElement).toBe(item('One'));
  });

  it('clears the typeahead buffer when the menu closes and reopens', async () => {
    const user = userEvent.setup();
    render(<ActionMenu label="Team actions" items={makeItems()} />);
    fireEvent.click(trigger()); await flush();
    await user.keyboard('f');
    expect(document.activeElement).toBe(item('Four'));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(trigger()); await flush();
    expect(document.activeElement).toBe(item('One'));
    // If "f" survived the close, "fo" would jump back to Four.
    await user.keyboard('o');
    expect(document.activeElement).toBe(item('One'));
  });

  it('closes on Tab and lets focus continue outside the menu', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ActionMenu label="Team actions" items={makeItems()} />
        <button type="button">After</button>
      </>,
    );
    fireEvent.click(trigger()); await flush();
    expect(document.activeElement).toBe(item('One'));
    fireEvent.keyDown(item('One'), { key: 'Tab' }); await flush();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    await user.tab(); await flush();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After' }));
  });
});

describe('ActionMenu pointer and lifecycle', () => {
  it('opens a submenu on hover after 120 ms and closes it when a sibling is hovered', async () => {
    render(<ActionMenu label="Team actions" items={submenuItems()} />);
    fireEvent.click(trigger()); await flush();
    fireEvent.pointerEnter(item('Parent'));
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 140)); });
    expect(screen.getAllByRole('menu')).toHaveLength(2);
    fireEvent.pointerEnter(item('After'));
    await flush();
    expect(screen.getAllByRole('menu')).toHaveLength(1);
  });

  it('toggles a submenu with a click and closes on an outside pointerdown', async () => {
    render(<ActionMenu label="Team actions" items={submenuItems()} />);
    fireEvent.click(trigger()); await flush();
    fireEvent.click(item('Parent')); await flush();
    expect(screen.getAllByRole('menu')).toHaveLength(2);
    fireEvent.click(item('Parent')); await flush();
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    fireEvent.pointerDown(document.body); await flush();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on window resize, window blur and an outside scroll', async () => {
    render(<ActionMenu label="Team actions" items={makeItems()} />);
    fireEvent.click(trigger()); await flush();
    fireEvent(window, new Event('resize')); await flush();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(trigger()); await flush();
    fireEvent(window, new Event('blur')); await flush();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(trigger()); await flush();
    fireEvent.scroll(document.body); await flush();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('stays open when a scrolling container inside the menu scrolls', async () => {
    render(<ActionMenu label="Team actions" items={makeItems()} />);
    fireEvent.click(trigger()); await flush();
    fireEvent.scroll(menu()); await flush();
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('only allows one menu to be open at a time', async () => {
    render(
      <>
        <ActionMenu label="First menu" items={makeItems()} />
        <ActionMenu label="Second menu" items={makeItems()} />
      </>,
    );
    fireEvent.click(trigger('First menu')); await flush();
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    fireEvent.click(trigger('Second menu')); await flush();
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(trigger('First menu').getAttribute('aria-expanded')).toBe('false');
    expect(trigger('Second menu').getAttribute('aria-expanded')).toBe('true');
  });

  it('does not open when disabled', async () => {
    render(<ActionMenu label="Team actions" items={makeItems()} disabled />);
    expect(trigger().disabled).toBe(true);
    fireEvent.click(trigger()); await flush();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('ActionMenu dynamic content and activation', () => {
  it('reads items when it opens and re-reads them while it is open', async () => {
    const first: MenuItem[] = [{ kind: 'action', id: 'old', label: 'Old', onSelect: () => undefined }];
    const second: MenuItem[] = [
      { kind: 'action', id: 'new', label: 'New', onSelect: () => undefined },
      { kind: 'action', id: 'newer', label: 'Newer', onSelect: () => undefined },
    ];
    const view = render(<ActionMenu label="Team actions" items={first} />);
    view.rerender(<ActionMenu label="Team actions" items={second} />);
    fireEvent.click(trigger()); await flush();
    expect(item('New')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Old' })).toBeNull();

    const third: MenuItem[] = [{ kind: 'action', id: 'latest', label: 'Latest', onSelect: () => undefined }];
    view.rerender(<ActionMenu label="Team actions" items={third} />); await flush();
    expect(item('Latest')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'New' })).toBeNull();
  });

  it('activates an action with Enter and Space', async () => {
    const onOne = vi.fn();
    const onTwo = vi.fn();
    render(<ActionMenu label="Team actions" items={makeItems({ onOne, onTwo })} />);
    fireEvent.click(trigger()); await flush();
    fireEvent.keyDown(item('One'), { key: 'Enter' }); await flush();
    expect(onOne).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(trigger()); await flush();
    fireEvent.keyDown(item('Two'), { key: ' ' }); await flush();
    expect(onTwo).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens a submenu from its parent with Space', async () => {
    render(<ActionMenu label="Team actions" items={submenuItems()} />);
    fireEvent.click(trigger()); await flush();
    fireEvent.keyDown(item('Parent'), { key: ' ' }); await flush();
    expect(screen.getAllByRole('menu')).toHaveLength(2);
    expect(document.activeElement).toBe(item('Child one'));
  });

  it('keeps every item at tabIndex -1 and points the trigger at the open menu', async () => {
    render(<ActionMenu label="Team actions" items={makeItems()} />);
    const button = trigger();
    fireEvent.click(button); await flush();
    const menuElement = menu();
    expect(button.getAttribute('aria-controls')).toBe(menuElement.id);
    for (const entry of menuElement.querySelectorAll('[data-menu-item]')) {
      expect((entry as HTMLElement).tabIndex).toBe(-1);
    }
  });

  it('renders a visible trigger label when one is given', async () => {
    render(<ActionMenu label="Team actions" trigger={{ label: 'Actions' }} items={makeItems()} />);
    const button = screen.getByRole('button', { name: 'Team actions' });
    expect(button.textContent).toBe('Actions');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(button); await flush();
    expect(menu('Team actions')).toBeTruthy();
  });

  it('keeps a disabled submenu focusable but does not open it', async () => {
    const items: MenuItem[] = [{
      kind: 'submenu',
      id: 'locked',
      label: 'Locked',
      disabledReason: 'Nothing to do.',
      items: [{ kind: 'action', id: 'inner', label: 'Inner', onSelect: () => undefined }],
    }];
    render(<ActionMenu label="Team actions" items={items} />);
    fireEvent.click(trigger()); await flush();
    const parent = item('Locked');
    expect(parent.getAttribute('aria-disabled')).toBe('true');
    expect(parent.getAttribute('aria-expanded')).toBe('false');
    parent.focus();
    expect(document.activeElement).toBe(parent);
    fireEvent.keyDown(parent, { key: 'ArrowRight' }); await flush();
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    fireEvent.click(parent); await flush();
    expect(screen.getAllByRole('menu')).toHaveLength(1);
  });
});
