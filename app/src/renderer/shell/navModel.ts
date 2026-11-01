export type SectionId = 'home' | 'teams' | 'agents' | 'roles' | 'boards' | 'routing' | 'configuration';

export type NavIconName = 'home' | 'teams' | 'agents' | 'roles' | 'boards' | 'routing' | 'configuration';

export interface NavItem {
  id: string;
  label: string;
  icon?: NavIconName;
  disabled?: boolean;
}

export const DEFAULT_SECTION: SectionId = 'home';

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'teams', label: 'Teams', icon: 'teams' },
  { id: 'agents', label: 'Agents', icon: 'agents' },
  { id: 'roles', label: 'Roles', icon: 'roles' },
  { id: 'boards', label: 'Boards', icon: 'boards' },
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
