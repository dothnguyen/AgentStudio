import { Fragment, useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import type { ConnectionStatus, DashboardApi, ManagementApi, Workspace } from '../api';
import { DashboardHome } from '../dashboard/DashboardHome';
import { getSectionContent, SectionPlaceholder } from '../sections/SectionPlaceholder';
import { AgentsScreen } from '../agents/AgentsScreen';
import { RolesScreen } from '../roles/RolesScreen';
import { SkillsScreen } from '../skills/SkillsScreen';
import { RoutingScreen } from '../routing/RoutingScreen';
import { CurrentPhaseScreen } from '../boards/CurrentPhaseScreen';
import { BacklogScreen } from '../boards/BacklogScreen';
import { PhasesScreen } from '../boards/PhasesScreen';
import { TicketScreen } from '../boards/TicketScreen';
import { TeamsScreen, type CreateFocusTarget } from '../teams/TeamsScreen';
import { WorkspaceTeamNavigation } from '../teams/WorkspaceTeamNavigation';
import { useTeamsNavigationController } from '../teams/useTeamsNavigationController';
import { ShellIcon } from './ShellIcon';
import {
  BOARD_NAV_ITEMS,
  BOARDS_DEFAULT_ROUTE,
  DEFAULT_SECTION,
  NAV_ITEMS,
  boardTicketKey,
  boardTicketRoute,
  findNavItem,
  findNavItemById,
  isBoardRoute,
  navItemRoute,
  workspaceInitials,
  type NavItem,
} from './navModel';

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
  const [requestedSkillId, setRequestedSkillId] = useState<string | null>(null);
  const [focusSkillList, setFocusSkillList] = useState(false);
  const [requestedMember, setRequestedMember] = useState<{ teamId: string; memberId: string } | null>(null);
  const teamsNavigation = useTeamsNavigationController(props.workspace.id, props.management.overview, props.connection);
  const [teamChildCurrent, setTeamChildCurrent] = useState(false);
  const teamsParentRef = useRef<HTMLButtonElement>(null);
  const newTeamRef = useRef<HTMLButtonElement>(null);
  const teamRows = useRef(new Map<string, HTMLButtonElement>());
  const [createTeamRequested, setCreateTeamRequested] = useState(false);
  const [teamsWritePending, setTeamsWritePending] = useState(false);
  const [pendingFocus, setPendingFocus] = useState<CreateFocusTarget | null>(null);
  const [currentPhaseTicketCount, setCurrentPhaseTicketCount] = useState<number | null>(null);
  const connected = props.connection.state === 'connected';
  const boardsItem = items.find((item) => item.id === 'boards');
  const boardsEnabled = boardsItem !== undefined && boardsItem.disabled !== true;

  useEffect(() => {
    setSectionId(DEFAULT_SECTION);
    setRequestedRoleId(null);
    setRequestedSkillId(null);
    setFocusSkillList(false);
    setRequestedMember(null);
    setTeamChildCurrent(false);
    setCreateTeamRequested(false);
    setPendingFocus(null);
    setCurrentPhaseTicketCount(null);
  }, [props.workspace.id]);

  // The Boards sidebar badge is a read of the current phase. Keep it truthful:
  // no badge while disconnected or when the read fails, and never from another workspace.
  useEffect(() => {
    if (!boardsEnabled || !connected) {
      setCurrentPhaseTicketCount(null);
      return;
    }
    let cancelled = false;
    setCurrentPhaseTicketCount(null);
    void props.management.boardPhases(props.workspace.id).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setCurrentPhaseTicketCount(null);
        return;
      }
      const current = result.data.phases.find((phase) => phase.slug === result.data.currentPhase.slug);
      setCurrentPhaseTicketCount(current?.ticketCount ?? 0);
    }).catch(() => {
      if (!cancelled) setCurrentPhaseTicketCount(null);
    });
    return () => { cancelled = true; };
  }, [boardsEnabled, connected, props.management, props.workspace.id]);

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

  function navigate(nextId: string, options?: {
    roleId?: string;
    skillId?: string;
    focusSkillList?: boolean;
    member?: { teamId: string; memberId: string };
  }): void {
    if (createTeamRequested && teamsWritePending && nextId !== 'teams') return;
    const item = findNavItemById(items, nextId) ?? findNavItem(items, nextId);
    const route = item === undefined ? nextId : navItemRoute(item);
    if (isBoardRoute(route) && !boardsEnabled) return;
    if (item === undefined ? !isBoardRoute(route) : item.disabled === true) return;
    const roleId = nextId === 'roles' && options?.roleId ? options.roleId : null;
    const skillId = nextId === 'skills' && options?.skillId ? options.skillId : null;
    setRequestedRoleId(roleId);
    setRequestedSkillId(skillId);
    setFocusSkillList(nextId === 'skills' && options?.focusSkillList === true);
    setRequestedMember(nextId === 'teams' && options?.member ? options.member : null);
    if (nextId !== 'teams') setCreateTeamRequested(false);
    setTeamChildCurrent(false);
    setSectionId(route);
  }

  const selectedItem = findNavItem(items, sectionId);
  const ticketKey = boardTicketKey(sectionId);
  const section = props.renderSection?.(sectionId, (nextId) => navigate(nextId));
  const content = getSectionContent(sectionId, selectedItem?.label ?? ticketKey ?? sectionId);
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
      onOpenRouting={items.some((i) => i.id === 'routing' && i.disabled !== true) ? () => navigate('routing') : undefined}
      onOpenBoard={boardsEnabled ? () => navigate(BOARDS_DEFAULT_ROUTE) : undefined}
      onOpenAgents={items.some((i) => i.id === 'agents' && i.disabled !== true) ? () => navigate('agents') : undefined}
      onOpenTicket={boardsEnabled ? (key) => navigate(boardTicketRoute(key)) : undefined}
      requestedMember={requestedMember}
      onRequestedMemberConsumed={() => setRequestedMember(null)}
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
      onOpenMember={(teamId, memberId) => navigate('teams', { member: { teamId, memberId } })}
      onOpenSkill={(skillId) => navigate('skills', { skillId })}
      onOpenSkills={() => navigate('skills', { focusSkillList: true })}
    />
  ) : sectionId === 'skills' ? (
    <SkillsScreen
      workspace={props.workspace}
      management={props.management}
      connection={props.connection}
      requestedSkillId={requestedSkillId}
      focusListOnMount={focusSkillList}
      onViewRole={(roleId) => navigate('roles', { roleId })}
    />
  ) : sectionId === 'routing' ? (
    <RoutingScreen
      key={props.workspace.id}
      workspace={props.workspace}
      management={props.management}
      connection={props.connection}
      navigation={teamsNavigation}
      onViewRole={(roleId) => navigate('roles', { roleId })}
      onOpenTeam={(teamId) => {
        const item = teamId === null ? undefined : teamsNavigation.items.find(candidate => candidate.team.id === teamId);
        if (item !== undefined) teamsNavigation.selectTeam(item.key);
        navigate('teams');
      }}
      onOpenTeams={() => navigate('teams')}
    />
  ) : sectionId === BOARDS_DEFAULT_ROUTE ? (
    <CurrentPhaseScreen
      key={props.workspace.id}
      workspace={props.workspace}
      management={props.management}
      onOpenPhases={() => navigate('boards/phases')}
      onOpenTicket={(key) => navigate(boardTicketRoute(key))}
    />
  ) : sectionId === 'boards/backlog' ? (
    <BacklogScreen key={props.workspace.id} workspace={props.workspace} management={props.management} onOpenTicket={(key) => navigate(boardTicketRoute(key))} />
  ) : sectionId === 'boards/phases' ? (
    <PhasesScreen key={props.workspace.id} workspace={props.workspace} management={props.management} />
  ) : ticketKey !== null ? (
    <TicketScreen
      key={`${props.workspace.id}:${ticketKey}`}
      workspace={props.workspace}
      management={props.management}
      ticketKey={ticketKey}
      onOpenBoard={() => navigate(BOARDS_DEFAULT_ROUTE)}
      onOpenTicket={(key) => navigate(boardTicketRoute(key))}
    />
  ) : (
    <SectionPlaceholder sectionId={sectionId} title={content.title} description={content.description} />
  );

  return (
    <div className="workspace-shell">
      <aside className="workspace-sidebar" aria-label="Workspace sidebar">
        <div className="sidebar-brand">
          <span className="sidebar-brand-tile" aria-hidden="true"><ShellIcon name="terminal" size={15} strokeWidth={2.4} /></span>
          <span className="sidebar-product">Agent Studio</span>
        </div>
        <button
          type="button"
          className="workspace-selector"
          aria-label={`Current workspace: ${props.workspace.name} (${props.workspace.path}). Choose another workspace`}
          onClick={props.onSwitchWorkspace}
        >
          <span className="workspace-avatar" aria-hidden="true">{workspaceInitials(props.workspace.name)}</span>
          <span className="workspace-selector-text">
            <span className="workspace-name" title={props.workspace.name}>{props.workspace.name}</span>
            <span className="workspace-path" title={props.workspace.path}>{props.workspace.path}</span>
          </span>
          <ShellIcon name="chevrons-up-down" size={14} strokeWidth={2} className="workspace-selector-chevron" />
        </button>
        <nav aria-label="Workspace" className="workspace-nav">
          {items.map((item) => {
            const isTeams = item.id === 'teams';
            const isBoards = item.id === 'boards';
            const boardsOpen = isBoards && isBoardRoute(sectionId);
            const teamsOpen = isTeams && sectionId === 'teams';
            const current = isBoards
              ? undefined
              : item.id === sectionId && !(isTeams && teamChildCurrent && teamsNavigation.selectedKey !== null)
                ? 'page'
                : undefined;
            return (
              <Fragment key={item.id}>
                <button
                  type="button"
                  className={`nav-item${teamsOpen || boardsOpen ? ' nav-item-open' : ''}`}
                  ref={isTeams ? teamsParentRef : undefined}
                  disabled={item.disabled === true}
                  aria-current={current}
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
                  {(isTeams || isBoards) && item.disabled !== true && (
                    <ShellIcon name="chevron" size={14} strokeWidth={2} className="nav-expand-icon" />
                  )}
                </button>
                {isTeams && item.disabled !== true && (
                  <WorkspaceTeamNavigation
                    controller={teamsNavigation}
                    active={sectionId === 'teams' && teamChildCurrent}
                    teamsOpen={sectionId === 'teams'}
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
                {isBoards && item.disabled !== true && (
                  <div className="boards-nav">
                    <ul className="boards-nav-list" aria-label="Boards">
                      {(item.children ?? BOARD_NAV_ITEMS).map((child) => {
                        const route = navItemRoute(child);
                        const active = sectionId === route || (route === BOARDS_DEFAULT_ROUTE && ticketKey !== null);
                        return (
                          <li key={child.id}>
                            <button
                              type="button"
                              className={`boards-nav-item${active ? ' boards-nav-item-selected' : ''}`}
                              aria-current={active ? 'page' : undefined}
                              onClick={() => navigate(child.id)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault();
                                  navigate(child.id);
                                }
                              }}
                            >
                              <span className="nav-label">{child.label}</span>
                              {route === BOARDS_DEFAULT_ROUTE && currentPhaseTicketCount !== null && (
                                <span
                                  className="boards-nav-count"
                                  aria-hidden="true"
                                  title={`${currentPhaseTicketCount} tickets in the current phase`}
                                >
                                  {currentPhaseTicketCount}
                                </span>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </Fragment>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <button type="button" className="switch-workspace" onClick={props.onSwitchWorkspace}>
            <ShellIcon name="switch" />
            <span>Switch workspace</span>
          </button>
        </div>
      </aside>
      <main className="workspace-content">
        {section === undefined ? defaultSection : section}
      </main>
    </div>
  );
}
