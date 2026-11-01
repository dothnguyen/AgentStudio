import type { IconName } from '../icons/Icon';

/** One selectable action inside a menu. */
export interface MenuActionItem {
  kind: 'action';
  id: string;
  label: string;
  description?: string;
  icon?: IconName;
  danger?: boolean;
  /** Radio-style marker, e.g. the member's active agent. */
  checked?: boolean;
  /** Present means disabled; the text is shown and announced. */
  disabledReason?: string;
  onSelect(trigger: HTMLElement): void;
}

/** A submenu parent. Items are read when the menu opens and while it is open. */
export interface MenuSubmenuItem {
  kind: 'submenu';
  id: string;
  label: string;
  description?: string;
  items: MenuItem[];
  disabledReason?: string;
}

export interface MenuSeparatorItem {
  kind: 'separator';
}

export interface MenuHeadingItem {
  kind: 'heading';
  label: string;
}

export type MenuItem = MenuActionItem | MenuSubmenuItem | MenuSeparatorItem | MenuHeadingItem;

export function menuFocusableItems(items: readonly MenuItem[]): Array<MenuActionItem | MenuSubmenuItem> {
  return items.filter((item): item is MenuActionItem | MenuSubmenuItem => item.kind === 'action' || item.kind === 'submenu');
}

export function menuItemsAtPath(items: readonly MenuItem[], path: readonly string[]): MenuItem[] {
  let current: readonly MenuItem[] = items;
  for (const id of path) {
    const parent = current.find((item): item is MenuSubmenuItem => item.kind === 'submenu' && item.id === id);
    if (parent === undefined) return [];
    current = parent.items;
  }
  return [...current];
}

/** Shortens a label to at most `max` characters, including the ellipsis. */
export function shortenText(value: string, max = 40): string {
  if (max <= 0) return '';
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export interface MenuRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

export interface MenuViewport {
  width: number;
  height: number;
}

export type MenuAlign = 'end' | 'start';

export interface MenuPlacement {
  left: number;
  top: number;
  maxHeight: number;
  flippedX: boolean;
  flippedY: boolean;
}

export const MENU_MARGIN = 8;
export const MENU_GAP = 4;

/**
 * Positions a fixed menu from the trigger's bounding rectangle.
 *
 * `end` right-aligns the menu with the trigger (the header menu). `start`
 * opens to the right of the trigger (a submenu) and flips to the left when
 * there is no room. jsdom has no layout, so this is a pure, unit-tested function.
 */
export function placeMenu(
  triggerRect: MenuRect,
  menuSize: MenuSize,
  viewport: MenuViewport,
  align: MenuAlign = 'end',
): MenuPlacement {
  let flippedX = false;
  let left: number;
  if (align === 'start') {
    left = triggerRect.left + triggerRect.width + MENU_GAP;
    if (left + menuSize.width > viewport.width - MENU_MARGIN) {
      left = triggerRect.left - MENU_GAP - menuSize.width;
      flippedX = true;
    }
  } else {
    left = triggerRect.left + triggerRect.width - menuSize.width;
  }

  const maxLeft = Math.max(MENU_MARGIN, viewport.width - menuSize.width - MENU_MARGIN);
  if (left < MENU_MARGIN) {
    left = MENU_MARGIN;
    flippedX = true;
  } else if (left > maxLeft) {
    left = maxLeft;
    flippedX = true;
  }

  let flippedY = false;
  let top: number;
  if (align === 'start') {
    top = triggerRect.top;
    if (top + menuSize.height > viewport.height - MENU_MARGIN) {
      top = viewport.height - menuSize.height - MENU_MARGIN;
    }
  } else {
    top = triggerRect.top + triggerRect.height + MENU_GAP;
    if (top + menuSize.height > viewport.height - MENU_MARGIN && triggerRect.top - MENU_GAP - menuSize.height >= MENU_MARGIN) {
      top = triggerRect.top - MENU_GAP - menuSize.height;
      flippedY = true;
    }
  }
  if (top < MENU_MARGIN) top = MENU_MARGIN;

  return {
    left,
    top,
    maxHeight: Math.max(0, viewport.height - MENU_MARGIN * 2),
    flippedX,
    flippedY,
  };
}
