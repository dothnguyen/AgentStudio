export type SectionId = 'home' | 'teams' | 'boards' | 'configuration';

export type NavIconName = 'home' | 'teams' | 'boards' | 'configuration';

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
  { id: 'boards', label: 'Boards', icon: 'boards' },
  { id: 'configuration', label: 'Configuration', icon: 'configuration' },
];
