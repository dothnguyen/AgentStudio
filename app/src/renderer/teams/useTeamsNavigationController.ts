import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectionState, ConnectionStatus, ManagementApi, Result, TeamOverview } from '../api';
import { useDashboardSection, type DashboardSectionController } from '../dashboard/useDashboardSection';
import { navigationItems, reconcileSelectedTeam, type TeamNavigationItem } from './teamsNavigationModel';

export interface TeamsNavigationController {
  overview: DashboardSectionController<TeamOverview>;
  data: TeamOverview | null;
  items: readonly TeamNavigationItem[];
  selectedKey: string | null;
  selected: TeamNavigationItem | null;
  fresh: boolean;
  stale: boolean;
  connectionState: ConnectionState | null;
  selectionVersion: number;
  sidebarSelectionVersion: number;
  selectTeam(teamKey: string): void;
  reloadAndSelect(teamKey: string): Promise<Result<TeamOverview>>;
}

interface Selection {
  workspaceId: string;
  key: string | null;
  version: number;
  sidebarVersion: number;
}

function failure(message: string): Result<TeamOverview> {
  return { ok: false, error: { code: 'INTERNAL', message, retryable: false } };
}

export function useTeamsNavigationController(
  workspaceId: string,
  load: ManagementApi['overview'],
  connection?: ConnectionStatus,
): TeamsNavigationController {
  // Tag every response with the workspace that requested it, so a value left
  // over from a previous workspace is never shown for the current one.
  const origins = useRef(new WeakMap<object, string>());
  const tagged = useCallback(async (id: string): Promise<Result<TeamOverview>> => {
    let result: Result<TeamOverview>;
    try {
      result = await load(id);
    } catch (reason) {
      result = failure(reason instanceof Error ? reason.message : String(reason));
    }
    origins.current.set(result.ok ? result.data : result.error, id);
    return result;
  }, [load]);
  const raw = useDashboardSection<TeamOverview>(tagged, workspaceId);

  const owner = raw.data ?? raw.error;
  const foreign = raw.state !== 'loading' && owner !== null && origins.current.get(owner) !== workspaceId;
  const overview: DashboardSectionController<TeamOverview> = foreign
    ? { ...raw, state: 'loading', data: null, error: null, loading: true, lastUpdatedAt: null }
    : raw;

  const retained = useRef<{ workspaceId: string; data: TeamOverview } | null>(null);
  if (overview.state === 'ready' && overview.data !== null) retained.current = { workspaceId, data: overview.data };
  if (retained.current !== null && retained.current.workspaceId !== workspaceId) retained.current = null;
  const data = overview.data ?? retained.current?.data ?? null;

  const items = useMemo(() => navigationItems(data), [data]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const [selection, setSelection] = useState<Selection>({ workspaceId, key: null, version: 0, sidebarVersion: 0 });
  const pending = useRef<{ workspaceId: string; key: string } | null>(null);
  const base: Selection = selection.workspaceId === workspaceId ? selection : { workspaceId, key: null, version: 0, sidebarVersion: 0 };
  const pendingKey = pending.current?.workspaceId === workspaceId ? pending.current.key : null;
  const wanted = pendingKey !== null && items.some((item) => item.key === pendingKey) ? pendingKey : base.key;
  const selectedKey = reconcileSelectedTeam(wanted, items);
  if (base !== selection || selectedKey !== selection.key) setSelection({ ...base, key: selectedKey });
  const selected = items.find((item) => item.key === selectedKey) ?? null;

  const choose = useCallback((ws: string, key: string, sidebar = false) => {
    setSelection((previous) => {
      const from = previous.workspaceId === ws ? previous : { workspaceId: ws, key: null, version: 0, sidebarVersion: 0 };
      return { ...from, key, version: from.version + 1, sidebarVersion: from.sidebarVersion + (sidebar ? 1 : 0) };
    });
  }, []);

  const selectTeam = useCallback((key: string) => {
    if (!itemsRef.current.some((item) => item.key === key)) return;
    choose(workspaceId, key, true);
  }, [choose, workspaceId]);

  const reloadFresh = raw.reloadFresh;
  const reloadAndSelect = useCallback(async (key: string): Promise<Result<TeamOverview>> => {
    const request = { workspaceId, key };
    pending.current = request;
    const result = reloadFresh === undefined ? failure('Teams cannot be refreshed.') : await reloadFresh();
    if (pending.current === request) pending.current = null;
    if (result.ok && navigationItems(result.data).some((item) => item.key === key)) choose(workspaceId, key);
    return result;
  }, [choose, reloadFresh, workspaceId]);

  const connectionState = connection?.state;
  const lastConnection = useRef(connectionState);
  useEffect(() => {
    const previous = lastConnection.current;
    lastConnection.current = connectionState;
    if (connectionState === 'connected' && (previous === 'connecting' || previous === 'lost')) void reloadFresh?.();
  }, [connectionState, reloadFresh]);

  const connected = connectionState === undefined || connectionState === 'connected';
  const fresh = connected && overview.state === 'ready' && overview.data !== null;
  const stale = data !== null && (!connected || overview.loading || overview.state === 'error');

  return {
    overview,
    data,
    items,
    selectedKey,
    selected,
    fresh,
    stale,
    connectionState: connectionState ?? null,
    selectionVersion: base.version,
    sidebarSelectionVersion: base.sidebarVersion,
    selectTeam,
    reloadAndSelect,
  };
}
