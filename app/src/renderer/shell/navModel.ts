export type SectionId = 'home' | 'teams' | 'boards' | 'configuration';

export interface NavItem {
  id: string;
  label: string;
  disabled?: boolean;
}

export const DEFAULT_SECTION: SectionId = 'home';

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'home', label: 'Home' },
  { id: 'teams', label: 'Teams' },
  { id: 'boards', label: 'Boards' },
  { id: 'configuration', label: 'Configuration' },
];
