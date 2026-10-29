import type { JSX } from 'react';
import { Icon } from '../icons/Icon';

export type ShellIconName = 'home' | 'teams' | 'agents' | 'roles' | 'boards' | 'configuration' | 'switch' | 'chevron' | 'refresh' | 'item';

export function ShellIcon(props: { name: ShellIconName }): JSX.Element {
  return <Icon name={props.name} className="shell-icon" />;
}
