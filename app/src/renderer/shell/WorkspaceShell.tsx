import { Fragment, useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import type { ConnectionStatus, DashboardApi, ManagementApi, Workspace } from '../api';
import { DashboardHome } from '../dashboard/DashboardHome';
import { getSectionContent, SectionPlaceholder } from '../sections/SectionPlaceholder';
import { AgentsScreen } from '../agents/AgentsScreen';
import { RolesScreen } from '../roles/RolesScreen';
import { TeamsScreen, type CreateFocusTarget } from '../teams/TeamsScreen';
import { WorkspaceTeamNavigation } from '../teams/WorkspaceTeamNavigation';
import { useTeamsNavigationController } from '../teams/useTeamsNavigationController';
import { StudioMark } from '../WorkspacesScreen';
import { ShellIcon } from './ShellIcon';
import { DEFAULT_SECTION, NAV_ITEMS, type NavItem } from './navModel';

export interface WorkspaceShellProps {
  workspace: Workspace;
  dashboard: DashboardApi;
  management: ManagementApi;
  connection: ConnectionStatus;
  onSwitchWorkspace(): void;
  items?: readonly NavItem[];
  renderSection?: (
    sectionId: string,
    navigate: (sectionId: string) => void,
  ) => ReactNode | undefined;
}

export function WorkspaceShell(props: WorkspaceShellProps): JSX.Element {
  const items = props.items ?? NAV_ITEMS;
  const [sectionId, setSectionId] = useState<string>(DEFAULT_SECTION);

  const [requestedRoleId, setRequestedRoleId] = useState<string | null>(null);
  const teamsNavigation = useTeamsNavigationController(props.workspace.id, props.management.overview, props.connection);
  const [teamChildCurrent, setTeamChildCurrent] = useState(false);
  const teamsParentRef = useRef<HTMLButtonElement>(null);
  const newTeamRef = useRef<HTMLButtonElement>(null);
  const teamRows = useRef(new Map<string, HTMLButtonElement>());
  const [createTeamRequested, setCreateTeamRequested] = useState(false);
  const [teamsWritePending, setTeamsWritePending] = useState(false);
  const [pendingFocus, setPendingFocus] = useState<CreateFocusTarget | null>(null);
  const connected = props.connection.state === 'connected';

  useEffect(() => {
    setSectionId(DEFAULT_SECTION);
    setRequestedRoleId(null);
    setTeamChildCurrent(false);
    setCreateTeamRequested(false);
    setPendingFocus(null);
  }, [props.workspace.id]);

  // Fulfil a focus request once the dialog is gone and the sidebar has rerendered.
  useEffect(() => {
    if (pendingFocus === null || createTeamRequested) return;
    const row = pendingFocus.kind === 'team' ? teamRows.current.get(pendingFocus.key) : undefined;
    let target = row ?? newTeamRef.current;
    // The trigger stays disabled until the Teams write releases; wait for that rerender.
    if (target?.disabled && teamsWritePending) return;
    // A natively disabled trigger cannot take focus; use the Teams parent.
    if (target === null || target === undefined || target.disabled) target = teamsParentRef.current;
    setPendingFocus(null);
    if (row !== undefined) setTeamChildCurrent(true);
    target?.focus();
  }, [pendingFocus, createTeamRequested, teamsWritePending, teamsNavigation.items]);

  useEffect(() => {
    if (teamsNavigation.selectedKey === null) setTeamChildCurrent(false);
  }, [teamsNavigation.selectedKey]);

  function navigate(nextId: string, options?: { roleId?: string }): void {
    if (createTeamRequested && teamsWritePending && nextId !== 'teams') return;
    const item = items.find((candidate) => candidate.id === nextId);
    if (item === undefined || item.disabled === true) return;
    const roleId = nextId === 'roles' && options?.roleId ? options.roleId : null;
    setRequestedRoleId(roleId);
    if (nextId !== 'teams') setCreateTeamRequested(false);
    setTeamChildCurrent(false);
    setSectionId(nextId);
  }

  const selectedItem = items.find((item) => item.id === sectionId);
  const section = props.renderSection?.(sectionId, (nextId) => navigate(nextId));
  const content = getSectionContent(sectionId, selectedItem?.label ?? sectionId);
  const defaultSection = sectionId === 'home' ? (
    <DashboardHome
      workspace={props.workspace}
      dashboard={props.dashboard}
      connection={props.connection}
      onNavigate={(nextId) => navigate(nextId)}
    />
  ) : sectionId === 'teams' ? (
    <TeamsScreen
      workspace={props.workspace}
      management={props.management}
      navigation={teamsNavigation}
      connection={props.connection}
      onViewRole={(roleId) => navigate('roles', { roleId })}
      createTeamRequested={createTeamRequested}
      onCreateTeamRequestedChange={setCreateTeamRequested}
      onTeamsWritePendingChange={setTeamsWritePending}
      onCreateFocusRequest={setPendingFocus}
    />
  ) : sectionId === 'agents' ? (
    <AgentsScreen workspace={props.workspace} management={props.management} connection={props.connection} />
  ) : sectionId === 'roles' ? (
    <RolesScreen
      workspace={props.workspace}
      management={props.management}
      connection={props.connection}
      requestedRoleId={requestedRoleId}
    />
  ) : (
    <SectionPlaceholder sectionId={sectionId} title={content.title} description={content.description} />
  );

  return (
    <div className="workspace-shell">
      <aside className="workspace-sidebar" aria-label="Workspace sidebar">
        <header className="workspace-identity">
          <div className="sidebar-brand">
            <StudioMark />
            <span className="sidebar-product">Agent Studio</span>
          </div>
          <div className="workspace-label">Workspace</div>
          <button
            type="button"
            className="workspace-selector"
            aria-label={`Current workspace: ${props.workspace.name} (${props.workspace.path}). Choose another workspace`}
            onClick={props.onSwitchWorkspace}
          >
            <span className="workspace-selector-text">
              <span className="workspace-name" title={props.workspace.name}>{props.workspace.name}</span>
              <span className="workspace-path" title={props.workspace.path}>{props.workspace.path}</span>
            </span>
            <ShellIcon name="chevron" />
          </button>
        </header>
        <nav aria-label="Workspace" className="workspace-nav">
          {items.map((item) => (
            <Fragment key={item.id}>
              <button
                type="button"
                className="nav-item"
                ref={item.id === 'teams' ? teamsParentRef : undefined}
                disabled={item.disabled === true}
                aria-current={item.id === sectionId && !(item.id === 'teams' && teamChildCurrent && teamsNavigation.selectedKey !== null) ? 'page' : undefined}
                onClick={() => navigate(item.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    navigate(item.id);
                  }
                }}
              >
                <ShellIcon name={item.icon ?? 'item'} />
                <span className="nav-label">{item.label}</span>
              </button>
              {item.id === 'teams' && item.disabled !== true && (
                <WorkspaceTeamNavigation
                  controller={teamsNavigation}
                  active={sectionId === 'teams' && teamChildCurrent}
                  parentButtonRef={teamsParentRef}
                  newTeam={{
                    disabled: !connected || teamsWritePending || createTeamRequested,
                    softDisabled: !teamsNavigation.fresh,
                    buttonRef: newTeamRef,
                    onClick: () => {
                      if (sectionId !== 'teams') navigate('teams');
                      setCreateTeamRequested(true);
                    },
                    registerRow: (key, element) => {
                      if (element === null) teamRows.current.delete(key);
                      else teamRows.current.set(key, element);
                    },
                  }}
                  onOpenTeam={(key) => {
                    if (createTeamRequested && teamsWritePending) return;
                    teamsNavigation.selectTeam(key);
                    navigate('teams');
                    setTeamChildCurrent(true);
                  }}
                />
              )}
            </Fragment>
          ))}
        </nav>
        <button type="button" className="switch-workspace" onClick={props.onSwitchWorkspace}>
          <ShellIcon name="switch" />
          <span>Switch workspace</span>
        </button>
      </aside>
      <main className="workspace-content">
        {section === undefined ? defaultSection : section}
      </main>
    </div>
  );
}
