import { useEffect, useRef, type JSX, type RefObject } from 'react';
import { compactTeamState, teamNavigationNotices } from './teamsNavigationModel';
import { teamLabel } from './teamsModel';
import type { TeamsNavigationController } from './useTeamsNavigationController';

export interface WorkspaceTeamNavigationProps {
  controller: TeamsNavigationController;
  active: boolean;
  onOpenTeam(teamKey: string): void;
  parentButtonRef: RefObject<HTMLButtonElement | null>;
  /** The single creation trigger; omitted where creation is not offered. */
  newTeam?: {
    disabled: boolean;
    /** Unavailable but still focusable (stale data), so focus can return here after a failed refresh. */
    softDisabled?: boolean;
    buttonRef: RefObject<HTMLButtonElement | null>;
    onClick(): void;
    registerRow(teamKey: string, element: HTMLButtonElement | null): void;
  };
}

export function WorkspaceTeamNavigation(props: WorkspaceTeamNavigationProps): JSX.Element {
  const { controller, active } = props;
  const { overview, data, items, selectedKey } = controller;
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const focusedKey = useRef<string | null>(null);
  const hasData = data !== null;
  const keys = items.map((item) => item.key).join('\u0000');

  useEffect(() => {
    const key = focusedKey.current;
    if (key === null) return;
    const lostFocus = document.activeElement === null || document.activeElement === document.body;
    const present = items.some((item) => item.key === key);
    if (present) {
      // Reordering can detach the focused row for a moment; put focus back on it.
      if (lostFocus) rows.current.get(key)?.focus();
      return;
    }
    focusedKey.current = null;
    if (!lostFocus) return;
    const target = selectedKey === null ? props.parentButtonRef.current : rows.current.get(selectedKey) ?? props.parentButtonRef.current;
    target?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, selectedKey]);

  let status: JSX.Element | null = null;
  if (overview.loading) {
    status = hasData
      ? <p className="team-nav-status">Refreshing teams… Showing previously loaded teams.</p>
      : <p className="team-nav-status" role="status">Loading teams…</p>;
  } else if (overview.state === 'error') {
    const message = overview.error?.message ?? 'The request failed.';
    status = hasData ? (
      <p className="team-nav-status team-nav-error">Team list unavailable. Showing previously loaded teams. {message}</p>
    ) : (
      <p className="team-nav-status team-nav-error" role="alert">Teams unavailable. {message}</p>
    );
  } else if (hasData && controller.connectionState === 'lost') {
    status = <p className="team-nav-status" role="status">Connection lost. Showing previously loaded teams.</p>;
  } else if (hasData && controller.stale) {
    status = <p className="team-nav-status" role="status">Connecting… Showing previously loaded teams.</p>;
  } else if (hasData && items.length === 0) {
    status = <p className="team-nav-status">No teams defined.</p>;
  }
  const notices = hasData ? teamNavigationNotices(data) : [];

  return (
    <div className="team-nav">
      {props.newTeam !== undefined && (
        <button type="button" className="team-nav-new" ref={props.newTeam.buttonRef} disabled={props.newTeam.disabled} aria-disabled={props.newTeam.softDisabled === true ? true : undefined} onClick={props.newTeam.softDisabled === true ? undefined : props.newTeam.onClick}>
          New team
        </button>
      )}
      {items.length > 0 && (
        <ul className="team-nav-list" aria-label="Workspace teams">
          {items.map((item) => {
            const label = teamLabel(item.team);
            const state = compactTeamState(item.team);
            const name = `Open ${label}, ${state.runtime}${state.definition === null ? '' : `, ${state.definition}`}`;
            const current = active && item.key === selectedKey;
            return (
              <li key={item.key}>
                <button
                  type="button"
                  className={`team-nav-item${current ? ' team-nav-item-current' : ''}`}
                  aria-label={name}
                  aria-current={current ? 'page' : undefined}
                  title={label}
                  ref={(element) => {
                    if (element === null) rows.current.delete(item.key);
                    else rows.current.set(item.key, element);
                    props.newTeam?.registerRow(item.key, element);
                  }}
                  onFocus={() => { focusedKey.current = item.key; }}
                  onBlur={(event) => { if (event.relatedTarget !== null && focusedKey.current === item.key) focusedKey.current = null; }}
                  onClick={() => props.onOpenTeam(item.key)}
                >
                  <span className="team-nav-label">{label}</span>
                  <span className="team-nav-state">{state.runtime}</span>
                  {state.definition !== null && <span className="team-nav-warning">{state.definition}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {status}
      {overview.state === 'error' && (
        <button type="button" className="team-nav-retry" onClick={() => { void overview.reloadFresh?.(); }}>Retry teams</button>
      )}
      {notices.length > 0 && (
        <ul className="team-nav-notices" aria-label="Team navigation notices">
          {notices.map((notice) => <li key={notice}>{notice}</li>)}
        </ul>
      )}
    </div>
  );
}
