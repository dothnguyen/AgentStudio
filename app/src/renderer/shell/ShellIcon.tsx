import type { JSX } from 'react';

export type ShellIconName = 'home' | 'teams' | 'boards' | 'configuration' | 'switch' | 'chevron' | 'refresh' | 'item';

const PATHS: Record<ShellIconName, string> = {
  home: 'M2.5 7.5 8 3l5.5 4.5V13H10V9.5H6V13H2.5z',
  teams: 'M6 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5zM2 13c0-2.2 1.8-3.5 4-3.5s4 1.3 4 3.5M11 7a1.75 1.75 0 1 0 0-3.5M11.5 9.5c1.5.3 2.5 1.4 2.5 3.5',
  boards: 'M2.5 2.5h11v11h-11zM8 2.5v11',
  configuration: 'M3 4h10M3 8h10M3 12h10M6 2.5v3M10 6.5v3M5 10.5v3',
  switch: 'M3 5h9l-2.5-2.5M13 11H4l2.5 2.5',
  chevron: 'm4.5 6.5 3.5 3.5 3.5-3.5',
  refresh: 'M13.2 5.5A5.5 5.5 0 1 0 13 11m.2-5.5V2m0 3.5H9.7',
  item: 'M5 8h6',
};

export function ShellIcon(props: { name: ShellIconName }): JSX.Element {
  return (
    <svg className="shell-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={PATHS[props.name]} />
    </svg>
  );
}
