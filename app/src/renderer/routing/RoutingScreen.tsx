import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type {
  BoardSettings,
  ConnectionStatus,
  ManagementApi,
  RoleCatalogItem,
  RoleCatalogList,
  Workspace,
} from '../api';
import { useDashboardSection, type DashboardSectionController } from '../dashboard/useDashboardSection';
import { SectionError } from '../teams/SectionError';
import { RoutingSettingsPanel } from '../teams/RoutingSettingsPanel';
import { useTeamsNavigationController, type TeamsNavigationController } from '../teams/useTeamsNavigationController';

export interface RoutingScreenProps {
  workspace: Workspace;
  management: ManagementApi;
  connection?: ConnectionStatus;
  /** Opens a role in the Roles section, as the Teams screen does today. */
  onViewRole?(roleId: string): void;
  /** The Teams screen's shared overview, so Routing does not fetch it a second time. */
  navigation?: TeamsNavigationController;
  onOpenTeam?(teamId: string | null): void;
  onOpenTeams?(): void;
}

/** Routing belongs to the workspace board, so it owns its own screen and reads. */
export function RoutingScreen(props: RoutingScreenProps): JSX.Element {
  return props.navigation !== undefined
    ? <RoutingBrowser key={props.workspace.id} {...props} navigation={props.navigation} />
    : <RoutingWithOwnTeams key={props.workspace.id} {...props} />;
}

/** Standalone use (for example a test or a host that does not mount the Teams sidebar). */
function RoutingWithOwnTeams(props: RoutingScreenProps): JSX.Element {
  const navigation = useTeamsNavigationController(props.workspace.id, props.management.overview, props.connection);
  return <RoutingBrowser {...props} navigation={navigation} />;
}

function RoutingBrowser(props: RoutingScreenProps & { navigation: TeamsNavigationController }): JSX.Element {
  const { navigation } = props;
  const board = useDashboardSection<BoardSettings>(props.management.boardSettings, props.workspace.id);
  const roleCatalog = useDashboardSection<RoleCatalogList>(props.management.roles, props.workspace.id);
  const connected = props.connection === undefined || props.connection.state === 'connected';
  const heading = useRef<HTMLHeadingElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<string | null>(null);
  const [, bumpFocus] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [routingError, setRoutingError] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const lastRoles = useRef<RoleCatalogList | null>(null);
  if (roleCatalog.data !== null) lastRoles.current = roleCatalog.data;
  const rolesData = roleCatalog.data ?? lastRoles.current;
  const roleItems: RoleCatalogItem[] | null = rolesData !== null && rolesData.state !== 'invalid' ? rolesData.items : null;
  const roleCatalogMessage = roleItems !== null ? null
    : roleCatalog.loading ? 'Loading the role catalog…'
    : roleCatalog.error !== null ? 'The role catalog could not be loaded. Retry loading it to choose or change a role.'
    : rolesData?.state === 'invalid' ? 'The role catalog is invalid. Fix it in Roles before choosing a role.'
    : 'The role catalog is unavailable. Retry loading it to choose or change a role.';
  const rolesPending = roleCatalog.loading && roleCatalog.error === null;
  const panelAlert = routingError || board.error !== null;
  // The role-catalog loading line owns the single status while it is pending;
  // otherwise the panel and the refresh announcement may use one.
  const announce = connected && !rolesPending;

  const retrySection = useCallback(async (section: DashboardSectionController<unknown>, retryId: string, headingId: string): Promise<void> => {
    const result = section.reloadFresh ? await section.reloadFresh() : null;
    if (!result) await section.reload();
    focusAfter.current = result?.ok === false ? retryId : headingId;
    bumpFocus((n) => n + 1);
  }, []);

  useEffect(() => {
    const id = focusAfter.current;
    if (id === null) return;
    const element = document.getElementById(id) ?? heading.current;
    if (element === null) return;
    focusAfter.current = null;
    element.focus();
  });

  async function refresh(): Promise<void> {
    if (refreshing) return;
    setRefreshing(true);
    setAnnouncement('');
    try {
      const results = await Promise.all([board, roleCatalog, navigation.overview].map(async (section) => {
        if (!section.reloadFresh) { await section.reload(); return true; }
        return (await section.reloadFresh()).ok;
      }));
      if (results.every(Boolean)) {
        setAnnouncement('Routing data refreshed.');
        refreshRef.current?.focus();
      }
    } finally {
      setRefreshing(false);
    }
  }

  // Follow the same reconnect refresh rule the Teams screen uses for its reads.
  const connectionState = props.connection?.state ?? null;
  const lastConnection = useRef(connectionState);
  useEffect(() => {
    const previous = lastConnection.current;
    lastConnection.current = connectionState;
    if (connectionState === 'connected' && previous !== null && previous !== 'connected') {
      void board.reloadFresh?.();
      void roleCatalog.reloadFresh?.();
    }
  }, [connectionState, board.reloadFresh, roleCatalog.reloadFresh]);

  return (
    <div className="routing-screen" data-section="routing">
      <header className="routing-header">
        <div className="routing-heading">
          <h1 id="routing-heading" ref={heading} tabIndex={-1}>Routing</h1>
          <p className="routing-subtitle">How tickets move on its own. When a ticket reaches a status, the role named here works it in the running team, and the result decides the next status.</p>
        </div>
        <button type="button" className="routing-refresh" aria-busy={refreshing} ref={refreshRef} onClick={() => { void refresh(); }}>Refresh</button>
      </header>
      <div className="routing-notice">
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4M12 16h.01" />
        </svg>
        <span>Routing belongs to the workspace board, not to one team. Changes apply to every team that uses this board. Without routing, teams still work when you give them a task, and you can move tickets by hand.</span>
      </div>
      {!connected && (
        <p className="panel-note routing-connection-note" role="status">
          {props.connection?.state === 'lost' ? 'Connection lost. Showing previously loaded routing data.' : 'Connecting to Agent Studio…'}
        </p>
      )}
      {roleCatalog.error !== null && (
        <SectionError
          section={roleCatalog}
          label="Role catalog"
          retryLabel="Retry loading roles"
          retryId="routing-retry-roles"
          stale={rolesData !== null}
          alert={!panelAlert}
          onRetry={() => { void retrySection(roleCatalog, 'routing-retry-roles', 'routing-heading'); }}
        />
      )}
      {rolesPending && (
        <p className="panel-loading" role={connected ? 'status' : undefined}>
          {rolesData === null ? 'Loading the role catalog…' : 'Refreshing the role catalog… Showing previously loaded data.'}
        </p>
      )}
      {announcement !== '' && <p role="status">{announcement}</p>}
      <RoutingSettingsPanel
        workspaceId={props.workspace.id}
        management={props.management}
        section={board}
        connected={connected}
        announce={announce}
        alert={panelAlert}
        onLocalErrorChange={setRoutingError}
        roleItems={roleItems}
        onViewRole={props.onViewRole}
        teams={navigation.data}
        teamsState={navigation.data !== null ? 'ready' : navigation.overview.state}
        onOpenTeam={props.onOpenTeam}
        onOpenTeams={props.onOpenTeams}
      />
      {roleCatalogMessage !== null && roleItems === null && roleCatalog.error === null && !rolesPending && (
        <p className="panel-note routing-role-catalog-note">{roleCatalogMessage}</p>
      )}
    </div>
  );
}
