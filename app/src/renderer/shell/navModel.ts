export interface NavItem {
  id: string;
  label: string;
  disabled?: boolean;
}

export const DEFAULT_SECTION = 'home';

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'home', label: 'Home' },
  { id: 'teams', label: 'Teams' },
  { id: 'boards', label: 'Boards' },
  { id: 'configuration', label: 'Configuration' },
];
