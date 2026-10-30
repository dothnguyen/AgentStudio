import { useRef, type JSX } from 'react';
import { within } from '@testing-library/react';
import type { ConnectionStatus, ManagementApi, Workspace } from '../src/renderer/api';
import { TeamsScreen } from '../src/renderer/teams/TeamsScreen';
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

// Stands in for WorkspaceShell: owns the shared navigation controller.
export function TeamsHarness(props: TeamsHarnessProps): JSX.Element {
  const navigation = useTeamsNavigationController(props.workspace.id, props.management.overview, props.connection);
  const parent = useRef<HTMLButtonElement>(null);
  props.onController?.(navigation);
  return (
    <>
      {props.sidebar === true && (
        <nav aria-label="Harness sidebar">
          <button type="button" ref={parent}>Teams</button>
          <WorkspaceTeamNavigation controller={navigation} active parentButtonRef={parent} onOpenTeam={(key) => navigation.selectTeam(key)} />
        </nav>
      )}
      <TeamsScreen workspace={props.workspace} management={props.management} navigation={navigation} connection={props.connection} onViewRole={props.onViewRole} />
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
