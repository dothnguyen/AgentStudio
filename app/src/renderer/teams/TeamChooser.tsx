import { useEffect, useRef, type JSX } from 'react';
import { RUNTIME_LABELS, definitionBadge, memberCountText, runtimeTone, teamLabel } from './teamsModel';
import { rovingIndex, type TeamViewItem } from './teamsViewModel';

export function TeamChooser(props: {
  items: readonly TeamViewItem[];
  selectedKey: string;
  onSelect(key: string): void;
}): JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusHeading = useRef(false);
  const { items } = props;
  const heading = (): void => document.getElementById('teams-detail-title')?.focus();
  useEffect(() => {
    if (!focusHeading.current) return;
    focusHeading.current = false;
    heading();
  }, [props.selectedKey]);
  return (
    <ul className="teams-card-list" aria-label="Choose a team">
      {items.map((item, index) => {
        const { team } = item;
        const badge = definitionBadge(team);
        return (
          <li key={item.key}>
            <button
              type="button"
              className="teams-card"
              aria-pressed={item.key === props.selectedKey}
              tabIndex={item.key === props.selectedKey ? 0 : -1}
              ref={(el) => { refs.current[index] = el; }}
              onClick={() => { if (item.key === props.selectedKey) { heading(); return; } focusHeading.current = true; props.onSelect(item.key); }}
              onKeyDown={(e) => {
                const next = rovingIndex(e.key, index, items.length, 'vertical');
                if (next === null) return;
                e.preventDefault();
                props.onSelect(items[next]!.key);
                refs.current[next]?.focus();
              }}
            >
              <span className="teams-card-name">{teamLabel(team)}</span>
              <span className={`status-badge teams-runtime teams-runtime-${team.runtime.state} teams-tone-${runtimeTone(team.runtime.state)}`}>
                <span className="status-dot" aria-hidden="true" />
                {RUNTIME_LABELS[team.runtime.state] ?? team.runtime.state}
              </span>
              <span className="teams-card-facts">{memberCountText(team)}</span>
              {badge !== null && <span className="status-badge teams-definition">{badge}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
