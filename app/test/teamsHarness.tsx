import { useEffect, useRef, useState, type JSX } from 'react';
import { within } from '@testing-library/react';
import type { ConnectionStatus, ManagementApi, Workspace } from '../src/renderer/api';
import { TeamsScreen, type CreateFocusTarget } from '../src/renderer/teams/TeamsScreen';
import { WorkspaceTeamNavigation } from '../src/renderer/teams/WorkspaceTeamNavigation';
import { useTeamsNavigationController, type TeamsNavigationController } from '../src/renderer/teams/useTeamsNavigationController';

export interface TeamsHarnessProps {
  workspace: Workspace;
  management: ManagementApi;
  connection?: ConnectionStatus;
  onViewRole?(roleId: string): void;
  onController?(controller: TeamsNavigationController): void;
  /** Render the real nested sidebar navigation next to the Teams screen. */
  sidebar?: boolean;
}

// Stands in for WorkspaceShell: owns the shared navigation controller and the
// creation state, with one New team trigger (in the nested sidebar when asked).
export function TeamsHarness(props: TeamsHarnessProps): JSX.Element {
  const navigation = useTeamsNavigationController(props.workspace.id, props.management.overview, props.connection);
  const parent = useRef<HTMLButtonElement>(null);
  const newTeam = useRef<HTMLButtonElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const [requested, setRequested] = useState(false);
  const [writePending, setWritePending] = useState(false);
  const [focus, setFocus] = useState<CreateFocusTarget | null>(null);
  props.onController?.(navigation);
  useEffect(() => { setRequested(false); setFocus(null); }, [props.workspace.id]);
  useEffect(() => {
    if (focus === null || requested) return;
    const row = focus.kind === 'team' ? rows.current.get(focus.key) : undefined;
    const target = row ?? newTeam.current;
    if (target?.disabled && writePending) return;
    setFocus(null);
    if (target && !target.disabled) target.focus();
  }, [focus, requested, writePending]);
  const disabled = !navigation.fresh || writePending || requested;
  const trigger = {
    disabled,
    buttonRef: newTeam,
    onClick: () => setRequested(true),
    registerRow: (key: string, element: HTMLButtonElement | null) => { if (element === null) rows.current.delete(key); else rows.current.set(key, element); },
  };
  return (
    <>
      <nav aria-label="Harness sidebar">
        <button type="button" ref={parent}>Teams</button>
        {props.sidebar === true
          ? <WorkspaceTeamNavigation controller={navigation} active parentButtonRef={parent} onOpenTeam={(key) => navigation.selectTeam(key)} newTeam={trigger} />
          : <button type="button" ref={newTeam} disabled={disabled} onClick={trigger.onClick}>New team</button>}
      </nav>
      <TeamsScreen
        workspace={props.workspace}
        management={props.management}
        navigation={navigation}
        connection={props.connection}
        onViewRole={props.onViewRole}
        createTeamRequested={requested}
        onCreateTeamRequestedChange={setRequested}
        onTeamsWritePendingChange={setWritePending}
        onCreateFocusRequest={setFocus}
      />
    </>
  );
}

/** A team row in the nested sidebar list, found by team name. */
export function teamRow(root: HTMLElement, name: string): HTMLButtonElement {
  return within(root).getByRole('button', { name: new RegExp(`^Open ${name},`) }) as HTMLButtonElement;
}

export function teamRowNames(root: HTMLElement): (string | null)[] {
  return Array.from(root.querySelectorAll('.team-nav-label')).map((node) => node.textContent);
}
