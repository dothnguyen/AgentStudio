export type SectionId = 'home' | 'teams' | 'agents' | 'roles' | 'skills' | 'boards' | 'routing' | 'configuration';

export type NavIconName = 'home' | 'teams' | 'agents' | 'roles' | 'skills' | 'boards' | 'routing' | 'configuration';

export interface NavItem {
  id: string;
  label: string;
  icon?: NavIconName;
  disabled?: boolean;
  /** Route opened when the item is activated. Defaults to the item id. */
  route?: string;
  /** Expandable children rendered directly under the item. */
  children?: readonly NavItem[];
}

export const DEFAULT_SECTION: SectionId = 'home';

/** Route opened by the Boards group itself (and by its Current Phase child). */
export const BOARDS_DEFAULT_ROUTE = 'boards/current';

export const BOARD_NAV_ITEMS: readonly NavItem[] = [
  { id: BOARDS_DEFAULT_ROUTE, label: 'Current Phase' },
  { id: 'boards/backlog', label: 'Backlog' },
  { id: 'boards/phases', label: 'Phases' },
];

const BOARD_TICKET_PREFIX = 'boards/ticket/';

/** Route for the read-only ticket page of one ticket. */
export function boardTicketRoute(key: string): string {
  return `${BOARD_TICKET_PREFIX}${key}`;
}

/** The ticket key in a `boards/ticket/<key>` route, or null for any other route. */
export function boardTicketKey(route: string): string | null {
  const match = /^boards\/ticket\/(T-\d{3,})$/.exec(route);
  return match?.[1] ?? null;
}

/** True for the Boards group and every route below it. */
export function isBoardRoute(route: string): boolean {
  return route === 'boards' || route.startsWith('boards/');
}

export function navItemRoute(item: NavItem): string {
  return item.route ?? item.id;
}

export function findNavItem(items: readonly NavItem[], route: string): NavItem | undefined {
  for (const item of items) {
    const child = item.children?.find((candidate) => navItemRoute(candidate) === route);
    if (child !== undefined) return child;
    if (navItemRoute(item) === route) return item;
  }
  return undefined;
}

export function findNavItemById(items: readonly NavItem[], id: string): NavItem | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const child = item.children?.find((candidate) => candidate.id === id);
    if (child !== undefined) return child;
  }
  return undefined;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'teams', label: 'Teams', icon: 'teams' },
  { id: 'agents', label: 'Agents', icon: 'agents' },
  { id: 'roles', label: 'Roles', icon: 'roles' },
  { id: 'skills', label: 'Skills', icon: 'skills' },
  {
    id: 'boards',
    label: 'Boards',
    icon: 'boards',
    route: BOARDS_DEFAULT_ROUTE,
    children: BOARD_NAV_ITEMS,
  },
  { id: 'routing', label: 'Routing', icon: 'routing' },
  { id: 'configuration', label: 'Configuration', icon: 'configuration' },
];

/** Two-letter avatar initials for a workspace name; `?` when the name has no characters. */
export function workspaceInitials(name: string): string {
  const parts = name.split(/[\s\-_./\\]+/).filter((part) => part.length > 0);
  if (parts.length === 0) return '?';
  const letters = parts.length === 1
    ? Array.from(parts[0]).slice(0, 2)
    : [Array.from(parts[0])[0], Array.from(parts[1])[0]];
  return letters.join('').toUpperCase();
}
