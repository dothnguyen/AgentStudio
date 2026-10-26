import type { JSX } from 'react';

export type IconName =
  | 'home' | 'teams' | 'boards' | 'configuration' | 'switch' | 'chevron' | 'refresh' | 'item'
  | 'document' | 'ticket' | 'check-circle' | 'check' | 'clock' | 'arrow-right' | 'lock'
  | 'box' | 'git-branch' | 'code' | 'search' | 'gear' | 'warning';
export type IconTone = 'success' | 'info' | 'warning' | 'danger';
export interface IconSpec { name: IconName; tone: IconTone | null }

const PATHS: Record<IconName, string> = {
  home: 'M2.5 7.5 8 3l5.5 4.5V13H10V9.5H6V13H2.5z',
  teams: 'M6 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5zM2 13c0-2.2 1.8-3.5 4-3.5s4 1.3 4 3.5M11 7a1.75 1.75 0 1 0 0-3.5M11.5 9.5c1.5.3 2.5 1.4 2.5 3.5',
  boards: 'M2.5 2.5h11v11h-11zM8 2.5v11',
  configuration: 'M3 4h10M3 8h10M3 12h10M6 2.5v3M10 6.5v3M5 10.5v3',
  switch: 'M3 5h9l-2.5-2.5M13 11H4l2.5 2.5',
  chevron: 'm4.5 6.5 3.5 3.5 3.5-3.5',
  refresh: 'M13.2 5.5A5.5 5.5 0 1 0 13 11m.2-5.5V2m0 3.5H9.7',
  item: 'M5 8h6',
  document: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3M6 8.5h4M6 11h4',
  ticket: 'M2.5 4.5h11v2a1.5 1.5 0 0 0 0 3v2h-11v-2a1.5 1.5 0 0 0 0-3zM9.5 4.5v7',
  'check-circle': 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM5.5 8l1.75 1.75L10.5 6.5',
  check: 'm3.5 8.5 3 3 6-7',
  clock: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3l2 1.5',
  'arrow-right': 'M3 8h10M9.5 4.5 13 8l-3.5 3.5',
  lock: 'M4 7.5h8v6H4zM5.5 7.5v-2a2.5 2.5 0 0 1 5 0v2',
  box: 'M2.5 5 8 2.5 13.5 5v6L8 13.5 2.5 11zM2.5 5 8 7.5 13.5 5M8 7.5v6',
  'git-branch': 'M5 2.5v8M5 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM11 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM11 6.5c0 2.5-6 1.5-6 4',
  code: 'm5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5 14 8l-3.5 3.5',
  search: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.5 10.5l3 3',
  gear: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  warning: 'M8 2.5 14 13H2zM8 6.5v3M8 11.25v.01',
};

export function Icon(props: { name: IconName; size?: number; tone?: IconTone | null; className?: string }): JSX.Element {
  const size = props.size ?? 16;
  const classes = ['icon', props.tone ? `icon-${props.tone}` : null, props.className ?? null].filter(Boolean).join(' ');
  return (
    <svg className={classes} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" data-icon={props.name}>
      <path d={PATHS[props.name]} />
    </svg>
  );
}
