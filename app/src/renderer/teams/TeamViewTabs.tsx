import { useRef, type JSX } from 'react';
import { TEAMS_CHILD_VIEWS, rovingIndex, teamsPanelId, teamsTabId, type TeamsChildView } from './teamsViewModel';

export function TeamViewTabs(props: {
  teamName: string;
  selected: TeamsChildView;
  onSelect(view: TeamsChildView): void;
}): JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div role="tablist" aria-label={`${props.teamName} views`} className="teams-view-tabs">
      {TEAMS_CHILD_VIEWS.map(({ id, label }, i) => (
        <button
          key={id}
          type="button"
          role="tab"
          className="teams-view-tab"
          id={teamsTabId(id)}
          aria-selected={id === props.selected}
          aria-controls={teamsPanelId(id)}
          tabIndex={id === props.selected ? 0 : -1}
          ref={(el) => { refs.current[i] = el; }}
          onClick={() => props.onSelect(id)}
          onKeyDown={(e) => {
            const next = rovingIndex(e.key, i, TEAMS_CHILD_VIEWS.length, 'horizontal');
            if (next === null) return;
            e.preventDefault();
            props.onSelect(TEAMS_CHILD_VIEWS[next]!.id);
            refs.current[next]?.focus();
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
