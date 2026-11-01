import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Icon, type IconName } from '../icons/Icon';
import {
  menuFocusableItems,
  menuItemsAtPath,
  placeMenu,
  type MenuAlign,
  type MenuItem,
  type MenuPlacement,
  type MenuRect,
  type MenuSize,
} from './actionMenuModel';

export interface ActionMenuTrigger {
  /** Glyph button (default: more). */
  icon?: IconName;
  /** Visible label; when omitted the trigger is an icon button. */
  label?: string;
  /** Accessible name. Defaults to the menu label. */
  ariaLabel?: string;
}

export interface ActionMenuProps {
  /** Accessible name of the menu and default trigger name. */
  label: string;
  trigger?: ActionMenuTrigger;
  items: MenuItem[];
  disabled?: boolean;
  align?: MenuAlign;
  triggerClassName?: string;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  /** Controlled open state; omit to let the trigger manage it. */
  open?: boolean;
  onOpenChange?(open: boolean): void;
  /** Open at a viewport point (the pointer) instead of under the trigger. */
  anchorPoint?: { x: number; y: number };
  /** Element to focus when the menu closes with Escape/Tab; defaults to the trigger. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

interface PendingFocus {
  level: number;
  index: number | 'last';
}

/** Only one menu may be open at a time, including menus from other instances. */
let activeMenuClose: (() => void) | null = null;
const HOVER_OPEN_MS = 120;
const TYPEAHEAD_RESET_MS = 700;
const MENU_ESTIMATED_WIDTH = 240;

function rectOf(element: Element): MenuRect {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function estimateSize(items: readonly MenuItem[], viewportHeight: number): MenuSize {
  const height = Math.min(viewportHeight - 16, items.length * 34 + 8);
  return { width: MENU_ESTIMATED_WIDTH, height: Math.max(34, height) };
}

/**
 * Uses the rendered menu box when the browser has laid it out (jsdom returns
 * all zeros) and falls back to an estimate so tests and first paints still get
 * a usable placement.
 */
function measureSize(element: HTMLElement | null, items: readonly MenuItem[], viewportHeight: number): MenuSize {
  if (element !== null) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height };
    if (element.offsetWidth > 0 && element.offsetHeight > 0) return { width: element.offsetWidth, height: element.offsetHeight };
  }
  return estimateSize(items, viewportHeight);
}

function viewportSize(): { width: number; height: number } {
  return typeof window === 'undefined'
    ? { width: 1024, height: 768 }
    : { width: window.innerWidth, height: window.innerHeight };
}

function toLetter(event: KeyboardEvent<HTMLElement>): string | null {
  if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return null;
  return event.key.toLowerCase();
}

export function ActionMenu(props: ActionMenuProps): JSX.Element {
  const { label, items, disabled = false, align = 'end' } = props;
  const trigger = props.trigger ?? { icon: 'more' as IconName };
  const reactId = useId().replace(/:/g, '');
  const menuId = `ui-menu-${reactId}`;
  const triggerId = `${menuId}-trigger`;
  const levelId = useCallback((level: number) => (level === 0 ? menuId : `${menuId}-${level}`), [menuId]);

  const [internalOpen, setInternalOpen] = useState(false);
  const open = props.open ?? internalOpen;
  const setOpen = useCallback((next: boolean) => {
    if (props.open === undefined) setInternalOpen(next);
  }, [props.open]);
  const [openPath, setOpenPath] = useState<string[]>([]);
  const [placed, setPlaced] = useState<MenuPlacement | null>(null);
  const [submenuPlacements, setSubmenuPlacements] = useState<Record<number, MenuPlacement>>({});
  const [focusTick, setFocusTick] = useState(0);

  const triggerElement = useRef<HTMLButtonElement | null>(null);
  const portalRoot = useRef<HTMLDivElement | null>(null);
  const levelElements = useRef(new Map<number, HTMLDivElement>());
  const submenuParents = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<PendingFocus | null>(null);
  const keyboardOpenAt = useRef(0);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typeahead = useRef<{ text: string; timer: ReturnType<typeof setTimeout> | null }>({ text: '', timer: null });
  const openPathKey = openPath.join('\u0000');

  const setTriggerRef = useCallback((element: HTMLButtonElement | null) => {
    triggerElement.current = element;
    if (props.triggerRef) props.triggerRef.current = element;
  }, [props.triggerRef]);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  const resetTypeahead = useCallback(() => {
    if (typeahead.current.timer !== null) {
      clearTimeout(typeahead.current.timer);
      typeahead.current.timer = null;
    }
    typeahead.current.text = '';
  }, []);

  const reset = useCallback(() => {
    resetTypeahead();
    pendingFocus.current = null;
    setOpen(false);
    setOpenPath([]);
    setPlaced(null);
    setSubmenuPlacements({});
  }, [resetTypeahead, setOpen]);

  const close = useCallback((refocusTrigger: boolean) => {
    clearHoverTimer();
    reset();
    props.onOpenChange?.(false);
    if (refocusTrigger) (props.returnFocusRef?.current ?? triggerElement.current)?.focus();
  }, [clearHoverTimer, props, reset]);

  const openMenu = useCallback((focus: 'first' | 'last') => {
    if (disabled) return;
    activeMenuClose?.();
    resetTypeahead();
    setOpen(true);
    setOpenPath([]);
    pendingFocus.current = { level: 0, index: focus === 'first' ? 0 : 'last' };
    setFocusTick((tick) => tick + 1);
    props.onOpenChange?.(true);
  }, [disabled, props, resetTypeahead, setOpen]);

  const wasOpen = useRef(false);
  // A controlled `open` can turn true without the trigger (right-click or the
  // Menu key): close any other open menu and focus the first item. This effect
  // runs before this instance registers itself as the active menu, so the
  // close call can only reach a different menu.
  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    if (!wasOpen.current && pendingFocus.current === null) {
      activeMenuClose?.();
      resetTypeahead();
      pendingFocus.current = { level: 0, index: 0 };
      setFocusTick((tick) => tick + 1);
    }
    wasOpen.current = true;
  }, [open, resetTypeahead]);

  useEffect(() => {
    if (!open) return;
    const closeOther = (): void => {
      reset();
      props.onOpenChange?.(false);
    };
    activeMenuClose = closeOther;
    return () => {
      if (activeMenuClose === closeOther) activeMenuClose = null;
    };
  }, [open, reset, props]);

  useEffect(() => {
    if (disabled && open) close(false);
  }, [disabled, open, close]);

  useEffect(() => () => {
    clearHoverTimer();
    if (typeahead.current.timer !== null) clearTimeout(typeahead.current.timer);
  }, [clearHoverTimer]);

  // Position the root menu and any open submenus from real bounding rectangles
  // and the measured box of each level (a fixed estimate is only the fallback).
  useLayoutEffect(() => {
    if (!open) {
      setPlaced(null);
      setSubmenuPlacements({});
      return;
    }
    const viewport = viewportSize();
    const anchor = props.anchorPoint;
    const anchorRect = anchor === undefined ? null : { left: anchor.x, top: anchor.y, width: 0, height: 0 };
    const triggerRect = anchorRect ?? (triggerElement.current !== null ? rectOf(triggerElement.current) : null);
    if (triggerRect !== null) {
      const rootElement = levelElements.current.get(0) ?? null;
      setPlaced(placeMenu(triggerRect, measureSize(rootElement, items, viewport.height), viewport, anchorRect !== null ? 'start' : align));
    }
    const next: Record<number, MenuPlacement> = {};
    for (let depth = 0; depth < openPath.length; depth += 1) {
      const parent = submenuParents.current.get(`${depth}:${openPath[depth]}`);
      if (parent === undefined) continue;
      const childItems = menuItemsAtPath(items, openPath.slice(0, depth + 1));
      const childElement = levelElements.current.get(depth + 1) ?? null;
      next[depth + 1] = placeMenu(rectOf(parent), measureSize(childElement, childItems, viewport.height), viewport, 'start');
    }
    setSubmenuPlacements(next);
    // openPathKey and focusTick are the intentional triggers; items are read through the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, openPathKey, align, focusTick, props.anchorPoint?.x, props.anchorPoint?.y]);

  // Focus is requested explicitly so opening a submenu can move focus into it.
  // A level is only focused once it has a placement: the first commit renders
  // the menu off-screen/transparent while it is measured, and real browsers
  // ignore .focus() inside a hidden subtree.
  useLayoutEffect(() => {
    if (!open) return;
    const pending = pendingFocus.current;
    if (pending === null) return;
    const placement = pending.level === 0 ? placed : submenuPlacements[pending.level];
    if (placement === null || placement === undefined) return;
    pendingFocus.current = null;
    const level = levelElements.current.get(pending.level) ?? document.getElementById(levelId(pending.level));
    const elements = Array.from(level?.querySelectorAll<HTMLButtonElement>('[data-menu-item]') ?? []);
    const target = pending.index === 'last' ? elements[elements.length - 1] : elements[pending.index];
    target?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, openPathKey, focusTick, placed, submenuPlacements]);

  // Outside pointer down closes everything.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (triggerElement.current?.contains(target) === true) return;
      if (portalRoot.current?.contains(target) === true) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, close]);

  // Resize, window blur and any scrolling container outside the menu close it.
  useEffect(() => {
    if (!open) return;
    const onResize = (): void => close(false);
    const onBlur = (): void => close(false);
    const onScroll = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && portalRoot.current?.contains(target) === true) return;
      close(false);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onBlur);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close]);

  useEffect(() => () => clearHoverTimer(), [clearHoverTimer]);

  function levelItems(level: number): MenuItem[] {
    return menuItemsAtPath(items, openPath.slice(0, level));
  }

  function elementsAt(level: number): HTMLButtonElement[] {
    const element = levelElements.current.get(level) ?? document.getElementById(levelId(level));
    return Array.from(element?.querySelectorAll<HTMLButtonElement>('[data-menu-item]') ?? []);
  }

  function focusElementAt(level: number, index: number): void {
    const elements = elementsAt(level);
    if (elements.length === 0) return;
    const wrapped = ((index % elements.length) + elements.length) % elements.length;
    elements[wrapped]?.focus();
  }

  function openSubmenu(depth: number, id: string, focusFirst: boolean): void {
    clearHoverTimer();
    setOpenPath((current) => [...current.slice(0, depth), id]);
    if (focusFirst) {
      pendingFocus.current = { level: depth + 1, index: 0 };
      setFocusTick((tick) => tick + 1);
    }
  }

  function closeSubmenu(childLevel: number, focusParent = true): void {
    const parentLevel = childLevel - 1;
    const parentId = openPath[parentLevel];
    setOpenPath((current) => current.slice(0, parentLevel));
    if (focusParent && parentId !== undefined) {
      const focusables = menuFocusableItems(levelItems(parentLevel));
      const index = focusables.findIndex((item) => item.id === parentId);
      pendingFocus.current = { level: parentLevel, index: index < 0 ? 0 : index };
      setFocusTick((tick) => tick + 1);
    }
  }

  function activate(depth: number, item: MenuItem, focusIndex: number): void {
    if (item.kind === 'separator' || item.kind === 'heading') return;
    if (item.disabledReason !== undefined) return;
    if (item.kind === 'submenu') {
      if (openPath[depth] === item.id) closeSubmenu(depth + 1);
      else openSubmenu(depth, item.id, true);
      return;
    }
    const triggerElementNow = triggerElement.current;
    // The menu is removed from the DOM before the action runs, so an action
    // that opens a dialog never competes with an open menu for focus.
    flushSync(() => close(false));
    triggerElementNow?.focus();
    item.onSelect(triggerElementNow ?? document.body);
    void focusIndex;
  }

  function runTypeahead(depth: number, focusIndex: number, letter: string): void {
    if (typeahead.current.timer !== null) clearTimeout(typeahead.current.timer);
    typeahead.current.text += letter;
    typeahead.current.timer = setTimeout(() => {
      typeahead.current.text = '';
      typeahead.current.timer = null;
    }, TYPEAHEAD_RESET_MS);
    const focusables = menuFocusableItems(levelItems(depth));
    for (let offset = 1; offset <= focusables.length; offset += 1) {
      const index = (focusIndex + offset) % focusables.length;
      if (focusables[index]!.label.toLowerCase().startsWith(typeahead.current.text)) {
        focusElementAt(depth, index);
        return;
      }
    }
    if (typeahead.current.text.length > 1) {
      // A multi-letter buffer that still matches the focused item keeps it in place.
      if (focusables[focusIndex]?.label.toLowerCase().startsWith(typeahead.current.text)) return;
      typeahead.current.text = letter;
      for (let offset = 1; offset <= focusables.length; offset += 1) {
        const index = (focusIndex + offset) % focusables.length;
        if (focusables[index]!.label.toLowerCase().startsWith(letter)) {
          focusElementAt(depth, index);
          return;
        }
      }
    }
  }

  function onItemKeyDown(event: KeyboardEvent<HTMLButtonElement>, depth: number, item: MenuItem, focusIndex: number): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusElementAt(depth, focusIndex + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusElementAt(depth, focusIndex - 1);
        return;
      case 'Home':
        event.preventDefault();
        focusElementAt(depth, 0);
        return;
      case 'End':
        event.preventDefault();
        focusElementAt(depth, menuFocusableItems(levelItems(depth)).length - 1);
        return;
      case 'ArrowRight':
        if (item.kind === 'submenu' && item.disabledReason === undefined) {
          event.preventDefault();
          openSubmenu(depth, item.id, true);
        }
        return;
      case 'ArrowLeft':
        if (depth > 0) {
          event.preventDefault();
          closeSubmenu(depth);
        }
        return;
      case 'Escape':
        event.preventDefault();
        if (depth > 0) closeSubmenu(depth);
        else close(true);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        activate(depth, item, focusIndex);
        return;
      case 'Tab':
        // Do not prevent the default: focus is parked on the trigger first, so
        // the browser continues the tab sequence from the trigger.
        close(true);
        return;
      default: {
        const letter = toLetter(event);
        if (letter !== null) {
          event.preventDefault();
          runTypeahead(depth, focusIndex, letter);
        }
      }
    }
  }

  function onItemPointerEnter(depth: number, item: MenuItem): void {
    clearHoverTimer();
    if (item.kind === 'submenu' && item.disabledReason === undefined) {
      if (openPath[depth] === item.id) return;
      hoverTimer.current = setTimeout(() => {
        hoverTimer.current = null;
        openSubmenu(depth, item.id, false);
      }, HOVER_OPEN_MS);
      return;
    }
    if (openPath.length > depth) setOpenPath((current) => current.slice(0, depth));
  }

  function onItemPointerDown(event: ReactPointerEvent<HTMLButtonElement>): void {
    // Keep focus where the click landed and stop the document listener from
    // treating the item as an outside pointer-down.
    event.stopPropagation();
  }

  function renderItem(item: MenuItem, depth: number, index: number, focusables: Array<{ id: string }>): ReactNode {
    if (item.kind === 'separator') {
      return <div key={`separator-${depth}-${index}`} role="separator" className="ui-menu-separator" />;
    }
    if (item.kind === 'heading') {
      return (
        <div key={`heading-${depth}-${index}`} role="group" aria-label={item.label} className="ui-menu-group">
          <div role="presentation" className="ui-menu-heading">{item.label}</div>
        </div>
      );
    }
    const actionItem = item.kind === 'action' ? item : null;
    const submenuItem = item.kind === 'submenu' ? item : null;
    const focusIndex = focusables.findIndex((entry) => entry === item);
    const reasonId = `${menuId}-${depth}-${index}-reason`;
    const descriptionId = `${menuId}-${depth}-${index}-description`;
    const describedBy = [
      item.description !== undefined ? descriptionId : null,
      item.disabledReason !== undefined ? reasonId : null,
    ].filter((id): id is string => id !== null);
    const isSubmenu = submenuItem !== null;
    const expanded = isSubmenu && openPath[depth] === item.id;
    const role = actionItem !== null && actionItem.checked !== undefined ? 'menuitemradio' : 'menuitem';
    const classes = ['ui-menu-item'];
    if (actionItem?.danger === true) classes.push('ui-menu-item-danger');
    if (isSubmenu) classes.push('ui-menu-item-submenu');
    return (
      <button
        key={`${item.kind}-${item.id}-${depth}-${index}`}
        type="button"
        role={role}
        id={`${menuId}-${depth}-${index}-item`}
        className={classes.join(' ')}
        tabIndex={-1}
        data-menu-item="true"
        data-menu-item-id={item.id}
        aria-label={item.label}
        aria-disabled={item.disabledReason === undefined ? undefined : 'true'}
        aria-describedby={describedBy.length === 0 ? undefined : describedBy.join(' ')}
        aria-checked={role === 'menuitemradio' ? actionItem?.checked === true : undefined}
        aria-haspopup={isSubmenu ? 'menu' : undefined}
        aria-expanded={isSubmenu ? expanded : undefined}
        aria-controls={isSubmenu && expanded ? levelId(depth + 1) : undefined}
        ref={(element) => {
          if (isSubmenu && element !== null) submenuParents.current.set(`${depth}:${item.id}`, element);
          else if (isSubmenu) submenuParents.current.delete(`${depth}:${item.id}`);
        }}
        onKeyDown={(event) => onItemKeyDown(event, depth, item, focusIndex)}
        onClick={() => activate(depth, item, focusIndex)}
        onPointerEnter={() => onItemPointerEnter(depth, item)}
        onPointerDown={onItemPointerDown}
      >
        {role === 'menuitemradio' && (
          <span className="ui-menu-check" aria-hidden="true">
            {actionItem?.checked === true ? <Icon name="check" size={12} /> : null}
          </span>
        )}
        {actionItem?.icon !== undefined && <Icon name={actionItem.icon} size={14} className="ui-menu-icon" />}
        <span className="ui-menu-item-body">
          <span className="ui-menu-label">{item.label}</span>
          {item.description !== undefined && <span className="ui-menu-description" id={descriptionId}>{item.description}</span>}
          {item.disabledReason !== undefined && <span className="ui-menu-reason" id={reasonId}>{item.disabledReason}</span>}
        </span>
        {isSubmenu && (
          <span className="ui-menu-chevron" aria-hidden="true">
            <Icon name="chevron-right" size={12} />
          </span>
        )}
      </button>
    );
  }

  function renderLevel(depth: number, menuItems: MenuItem[], menuLabel: string): ReactNode {
    const focusables = menuFocusableItems(menuItems);
    const placement = depth === 0 ? placed : submenuPlacements[depth];
    // While a level is being measured it stays laid out but invisible; using
    // visibility:hidden would make .focus() a no-op in real browsers.
    const style = placement === null || placement === undefined
      ? { left: 0, top: 0, opacity: 0, pointerEvents: 'none' as const }
      : { left: placement.left, top: placement.top, maxHeight: placement.maxHeight, opacity: 1, visibility: 'visible' as const };
    const openChild = menuItems.find((item): item is Extract<MenuItem, { kind: 'submenu' }> =>
      item.kind === 'submenu' && openPath[depth] === item.id);
    return (
      <div key={`level-${depth}`} className="ui-menu-level">
        <div
          role="menu"
          id={levelId(depth)}
          aria-label={menuLabel}
          className="ui-menu"
          data-menu-level={depth}
          style={style}
          ref={(element) => {
            if (element === null) levelElements.current.delete(depth);
            else levelElements.current.set(depth, element);
          }}
        >
          {menuItems.map((item, index) => renderItem(item, depth, index, focusables))}
        </div>
        {openChild !== undefined && renderLevel(depth + 1, openChild.items, openChild.label)}
      </div>
    );
  }

  const hasVisibleTrigger = trigger.label !== undefined;
  return (
    <>
      <button
        type="button"
        id={triggerId}
        ref={setTriggerRef}
        className={props.triggerClassName ?? 'ui-menu-trigger'}
        aria-label={trigger.ariaLabel ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={disabled}
        onClick={() => {
          // Some browsers synthesise a click after Enter/Space even though the
          // key handler prevented the default; do not toggle the menu closed.
          if (Date.now() - keyboardOpenAt.current < 150) return;
          if (open) close(true);
          else openMenu('first');
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (event.key === 'Enter' || event.key === ' ') keyboardOpenAt.current = Date.now();
            openMenu('first');
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu('last');
          }
        }}
      >
        {hasVisibleTrigger
          ? trigger.label
          : <span className="ui-menu-trigger-icon" aria-hidden="true"><Icon name={trigger.icon ?? 'more'} size={16} /></span>}
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div className="ui-menu-layer" ref={portalRoot} data-action-menu-root={menuId}>
          {renderLevel(0, items, label)}
        </div>,
        document.body,
      )}
    </>
  );
}
