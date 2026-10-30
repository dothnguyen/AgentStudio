import { SectionError } from './SectionError';
import { TeamOverviewPanel } from './TeamOverviewPanel';
import { MembersView } from './MembersView';
import { RoutingSettingsPanel } from './RoutingSettingsPanel';
import { TeamViewTabs } from './TeamViewTabs';
import { INITIAL_TEAMS_VIEW, TEAMS_CHILD_VIEWS, selectChildView, selectTeamView, teamsPanelId, teamsTabId, type TeamsChildView, type TeamsViewState } from './teamsViewModel';
import { useEffect, useRef, useState, type JSX } from 'react';
import type {
  AgentCatalogList,
  AgentDef,
  BoardRunResult,
  BoardSettings,
  ConnectionStatus,
  ManagementApi,
  ManagementResult,
  OverviewTeam,
  OverviewMember,
  RoleCatalogItem,
  RoleCatalogList,
  TeamEditResult,
  TeamOverview,
  Workspace,
} from '../api';
import { navigationItems } from './teamsNavigationModel';
import type { TeamsNavigationController } from './useTeamsNavigationController';
import { useDashboardSection, type DashboardSectionController } from '../dashboard/useDashboardSection';
import { ShellIcon } from '../shell/ShellIcon';
import { boardErrorFeedback, boardResultText, type BoardAction } from './boardControlModel';
import { memberActionKey, assignmentConfirmation, lastSwitchSignature, matchingTerminalSwitch, SWITCH_REFRESH_INTERVAL_MS, SWITCH_REFRESH_LIMIT, type MemberActionInFlight } from './memberAgentActionsModel';
import { FormAlertContext, WriteFeedbackView } from './TeamEditForms';
import { TeamCreateDialog } from './TeamCreateDialog';
import {
  addMemberInput,
  errorFeedback,
  nextStartSuffix,
  problemsSuffix,
  thrownError,
  type TeamWrites,
  type WriteFeedback,
} from './teamEditModel';
import {

  memberName,
  overviewNotices,
  teamLabel,
  type MemberSelection,
} from './teamsModel';

export interface TeamsScreenProps {
  workspace: Workspace;
  management: ManagementApi;
  navigation: TeamsNavigationController;
  connection?: ConnectionStatus;
  onViewRole?(roleId: string): void;
  createTeamRequested: boolean;
  onCreateTeamRequestedChange(requested: boolean): void;
  onTeamsWritePendingChange(pending: boolean): void;
  onCreateFocusRequest(target: CreateFocusTarget): void;
}

export type CreateFocusTarget = { kind: 'new-team' } | { kind: 'team'; key: string };

export type { TeamWrites } from './teamEditModel';

export function TeamsScreen(props: TeamsScreenProps): JSX.Element {
  return <TeamsOverview key={props.workspace.id} {...props} />;
}



function TeamsOverview(props: TeamsScreenProps): JSX.Element {
  const connectionState = props.connection?.state ?? null;
  const connected = connectionState === null || connectionState === 'connected';
  const navigation = props.navigation;
  const overview = navigation.overview;
  const agents = useDashboardSection<AgentCatalogList>(props.management.agents, props.workspace.id);
  const board = useDashboardSection<BoardSettings>(props.management.boardSettings, props.workspace.id);
  const roleCatalog = useDashboardSection<RoleCatalogList>(props.management.roles, props.workspace.id);
  const [boardAction, setBoardAction] = useState<BoardAction | null>(null);
  const [selectedMember, setSelectedMember] = useState<MemberSelection | null>(null);
  const [viewState, setViewState] = useState<TeamsViewState>(INITIAL_TEAMS_VIEW);
  const refreshLock = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const busy = refreshing || overview.loading || agents.loading || board.loading || roleCatalog.loading;
  const [feedback, setFeedback] = useState<WriteFeedback | null>(null);
  const [routingError, setRoutingError] = useState(false);
  const [formAlert, setFormAlert] = useState(false);
  const [memberNotice, setMemberNotice] = useState(false);
  const [pending, setPending] = useState(false);
  const [savedRevision, setSavedRevision] = useState(0);
  const [createError, setCreateError] = useState<Extract<WriteFeedback, { kind: 'error' }> | null>(null);
  const writeLock = useRef(false);
  const actionLocks = useRef(new Set<string>());
  const [actions, setActions] = useState<Record<string, MemberActionInFlight>>({});
  const [polling, setPolling] = useState<Record<string, boolean>>({});
  const [confirmation, setConfirmation] = useState<{ teamDefId: string; memberId: string; memberName: string; agentId: string; agentLabel: string; assignmentId: string; trigger: HTMLButtonElement; signature: string | null; selectionKey: string; changed: boolean } | null>(null);
  const alertSource = confirmation?.changed ? 'confirmation' : createError !== null && props.createTeamRequested ? 'create' : formAlert ? 'form' : feedback?.kind === 'error' ? 'feedback' : routingError ? 'routing' : overview.state === 'error' ? 'overview' : roleCatalog.error !== null ? 'roles' : agents.error !== null ? 'agents' : board.error !== null ? 'board' : null;
  const confirmationGeneration = useRef(0);
  const selectionIdentity = JSON.stringify([props.workspace.id, navigation.selectedKey, navigation.selectionVersion, viewState.teamKey, viewState.view, selectedMember?.teamKey, selectedMember?.memberId]);
  const previousSelectionIdentity = useRef(selectionIdentity);
  if (previousSelectionIdentity.current !== selectionIdentity) {
    previousSelectionIdentity.current = selectionIdentity;
    confirmationGeneration.current++;
  }
  const selectedMemberRef = useRef(selectedMember);
  selectedMemberRef.current = selectedMember;
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const timers = useRef(new Map<ReturnType<typeof setTimeout>, () => void>());
  const lastAgents = useRef<AgentCatalogList | null>(null);
  const lastRoles = useRef<RoleCatalogList | null>(null);
  const lastBoard = useRef<BoardSettings | null>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<string | null>(null);
  const [, bumpFocus] = useState(0);
  const readOnlyRef = useRef(false);
  const actionRefreshQueue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const connectedRef = useRef(connected);
  const connectionGeneration = useRef(0);
  if (connectedRef.current !== connected) connectionGeneration.current++;
  connectedRef.current = connected;
  const confirmationActionInFlight = confirmation !== null && !!actions[memberActionKey(confirmation.teamDefId, confirmation.memberId)];
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; timers.current.forEach((resolve, timer) => { clearTimeout(timer); resolve(); }); timers.current.clear(); };
  }, []);

  const onWritePending = props.onTeamsWritePendingChange;
  useEffect(() => { onWritePending(pending); }, [pending, onWritePending]);
  useEffect(() => () => onWritePending(false), [onWritePending]);

  useEffect(() => {
    if (connected) return;
    timers.current.forEach((resolve, timer) => { clearTimeout(timer); resolve(); });
    timers.current.clear();
  }, [connected]);

  async function runWrite<T>(
    failTitle: string,
    call: () => Promise<ManagementResult<T>>,
    onOk: (data: T) => { text: string; selectCreated?: string },
  ): Promise<boolean> {
    if (writeLock.current) return false;
    if (readOnlyRef.current) {
      setFeedback({ kind: 'error', title: failTitle, code: 'STALE_DATA', message: 'Team data is not current.', remediation: 'Wait for the connection and team data to finish loading, then try again.', problems: [], hint: null });
      return false;
    }
    writeLock.current = true;
    setPending(true);
    setFeedback(null);
    let result: ManagementResult<T>;
    try {
      result = await call();
    } catch (reason) {
      result = { ok: false, error: thrownError(reason) };
    } finally {
      writeLock.current = false;
      if (mounted.current) setPending(false);
    }
    if (!mounted.current) return false;
    if (!result.ok) {
      setFeedback(errorFeedback(failTitle, result.error));
      return false;
    }
    setSavedRevision(r => r + 1);
    const { text: message, selectCreated } = onOk(result.data);
    setFeedback({ kind: 'success', text: message });
    if (selectCreated !== undefined) {
      void navigation.reloadAndSelect(selectCreated);
    }
    else void overview.reload();
    return true;
  }

  useEffect(() => {
    if (confirmation) { cancelRef.current?.focus(); return; }
    const trigger = restoreFocus.current;
    if (trigger) {
      if (trigger.isConnected && !trigger.disabled) trigger.focus();
      else document.getElementById('teams-member-detail-title')?.focus();
      restoreFocus.current = null;
    }
  }, [confirmation, connected, confirmationActionInFlight]);
  useEffect(() => {
    if (confirmation && (selectedMember?.memberId !== confirmation.memberId || selectedMember?.teamKey !== confirmation.selectionKey || navigation.selectedKey !== confirmation.selectionKey || viewState.view !== 'overview')) {
      confirmationGeneration.current++;
      restoreFocus.current = null;
      setConfirmation(null);
      document.getElementById('teams-member-detail-title')?.focus();
    }
  }, [selectedMember, viewState, confirmation, navigation.selectedKey, props.workspace.id]);
  function closeConfirmation(trigger: HTMLButtonElement): void {
    confirmationGeneration.current++;
    restoreFocus.current = trigger;
    setConfirmation(null);
  }
  const ws = props.workspace.id;
  const mgmt = props.management;
  const writes: TeamWrites = {
    rename: (team, name) => runWrite('Team was not renamed.', () => mgmt.renameTeam(ws, team.id!, name), (d) => ({
      text: `Renamed team to "${d.team.name}".${nextStartSuffix(d.appliesOnNextStart)}${problemsSuffix(d.problems)}`,
    })),
    deleteTeam: (team) => runWrite('Team was not deleted.', () => mgmt.deleteTeam(ws, team.id!), () => ({
      text: `Deleted team "${teamLabel(team)}".`,
    })),
    addMember: (team, values) => runWrite('Member was not added.', () => mgmt.addMember(ws, team.id!, addMemberInput(values)), (d) => ({
      text: `Added ${d.member.name} to ${teamLabel(team)}.${nextStartSuffix(d.appliesOnNextStart)}${problemsSuffix(d.problems)}`,
    })),
    updateMember: (team, memberId, changes) => runWrite('Member was not saved.', () => mgmt.updateMember(ws, team.id!, memberId, changes), (d) => ({
      text: `Saved ${d.member.name}.${nextStartSuffix(d.appliesOnNextStart)}${problemsSuffix(d.problems)}`,
    })),
    removeMember: (team, memberId) => runWrite('Member was not removed.', () => mgmt.removeMember(ws, team.id!, memberId), (d) => ({
      text: `Removed ${d.removed.name} from ${teamLabel(team)}.${problemsSuffix(d.problems)}`,
    })),
  };

  function lock(teamDefId: string, memberId: string, agentId: string, kind: 'switch' | 'resume'): boolean {
    const key = memberActionKey(teamDefId, memberId);
    if (actionLocks.current.has(key)) return false;
    actionLocks.current.add(key);
    setActions(a => ({ ...a, [key]: { memberId, agentId, kind } }));
    setFeedback(null);
    return true;
  }
  function unlock(teamDefId: string, memberId: string): void {
    const key = memberActionKey(teamDefId, memberId);
    actionLocks.current.delete(key);
    if (mounted.current) setActions(a => { const next = { ...a }; delete next[key]; return next; });
  }
  async function waitForPoll(): Promise<void> {
    await new Promise<void>(resolve => { const timer = setTimeout(() => { timers.current.delete(timer); resolve(); }, SWITCH_REFRESH_INTERVAL_MS); timers.current.set(timer, resolve); });
  }
  function refreshForAction() {
    const refresh = actionRefreshQueue.current.then(() => {
      if (!mounted.current) return { ok: false as const, error: { code: 'INTERNAL', message: 'Section is inactive.', retryable: false } };
      return overview.reloadFresh!();
    });
    actionRefreshQueue.current = refresh.then(() => undefined, () => undefined);
    return refresh;
  }
  async function switchAgent(context: { teamDefId: string; memberId: string; memberName: string; agentId: string; agentLabel: string; trigger: HTMLButtonElement; signature: string | null; selectionKey: string }, assignmentId?: string): Promise<void> {
    if (readOnlyRef.current || !connectedRef.current) return;
    if (!lock(context.teamDefId, context.memberId, context.agentId, 'switch')) return;
    const generation = confirmationGeneration.current;
    const connectionAtRequest = connectionGeneration.current;
    try {
      let result;
      try { result = assignmentId === undefined ? await mgmt.switchMemberAgent(ws, context.teamDefId, context.memberId, context.agentId) : await mgmt.switchMemberAgent(ws, context.teamDefId, context.memberId, context.agentId, { cancelActive: true, assignmentId }); }
      catch (reason) { result = { ok: false as const, error: thrownError(reason) }; }
      if (!mounted.current || !connectedRef.current || connectionAtRequest !== connectionGeneration.current) return;
      if (!result.ok) {
        const match = assignmentConfirmation(result.error);
        if (match && (assignmentId === undefined || match.assignmentId !== assignmentId)) {
          if (confirmationGeneration.current !== generation || !connectedRef.current) return;
          if (selectedMemberRef.current?.memberId !== context.memberId || selectedMemberRef.current?.teamKey !== context.selectionKey) return;
          setConfirmation({ ...context, assignmentId: match.assignmentId, changed: assignmentId !== undefined });
        } else {
          if (assignmentId !== undefined && confirmationGeneration.current === generation) closeConfirmation(context.trigger);
          setFeedback({ ...errorFeedback('Switch request failed.', result.error), dataText: result.error.data === undefined ? null : JSON.stringify(result.error.data) });
        }
        return;
      }
      if (assignmentId !== undefined && confirmationGeneration.current === generation) closeConfirmation(context.trigger);
      setPolling(a => ({ ...a, [memberActionKey(context.teamDefId, context.memberId)]: true }));
      for (let i = 0; i < SWITCH_REFRESH_LIMIT; i++) {
        await waitForPoll();
        if (!mounted.current) return;
        if (!connectedRef.current) { setFeedback(errorFeedback('Switch status check stopped.', { code: 'DISCONNECTED', message: 'Connection lost before the switch result was confirmed.', retryable: true, remediation: 'Reconnect, then refresh to check the switch result.' })); return; }
        if (connectionAtRequest !== connectionGeneration.current) return;
        const refreshed = await refreshForAction();
        if (!mounted.current || !connectedRef.current || connectionAtRequest !== connectionGeneration.current) return;
        if (!refreshed.ok) { setFeedback(errorFeedback('Refresh failed.', refreshed.error)); return; }
        const member = refreshed.data.teams.find(t => t.id === context.teamDefId)?.members.find(m => m.memberId === context.memberId);
        if (member && matchingTerminalSwitch(member, context.agentId, context.signature)) return;
      }
      setFeedback({ kind: 'success', text: 'Switch accepted; completion is still pending. Refresh to check again.' });
    } finally { if (mounted.current) setPolling(a => { const next = { ...a }; delete next[memberActionKey(context.teamDefId, context.memberId)]; return next; }); unlock(context.teamDefId, context.memberId); }
  }
  async function resumeAgent(teamDefId: string, memberId: string, agentId: string, label: string): Promise<void> {
    if (readOnlyRef.current || !connectedRef.current) return;
    if (!lock(teamDefId, memberId, agentId, 'resume')) return;
    const connectionAtRequest = connectionGeneration.current;
    const stale = (): boolean => !mounted.current || !connectedRef.current || connectionAtRequest !== connectionGeneration.current;
    try {
      let result;
      try { result = await mgmt.resumeMemberAgent(ws, teamDefId, memberId, agentId); }
      catch (reason) { result = { ok: false as const, error: thrownError(reason) }; }
      if (stale()) return;
      if (!result.ok) { setFeedback({ ...errorFeedback('Resume request failed.', result.error), dataText: result.error.data === undefined ? null : JSON.stringify(result.error.data) }); return; }
      const refreshed = await refreshForAction();
      if (stale()) return;
      if (!refreshed.ok) { setFeedback(errorFeedback('Refresh failed.', refreshed.error)); return; }
      const d = result.data;
      setFeedback({ kind: 'success', text: !d.cleared ? `No recorded quota hold was cleared for ${label}; quota was not verified.` : d.activeAgent !== d.option ? `Quota hold cleared for inactive option ${label}; quota was not verified. The live agent and assignment were not changed.` : `Quota hold cleared for active option ${label}; quota was not verified. Availability is shown from refreshed backend state.` });
    } finally { unlock(teamDefId, memberId); }
  }

  async function boardWrite(action: BoardAction, team: OverviewTeam): Promise<void> {
    if (writeLock.current || readOnlyRef.current || !connectedRef.current || board.state !== 'ready' || board.data === null) return;
    const runTeamId = team.runtime.teamId;
    if (action === 'run' && runTeamId === null) return;
    writeLock.current = true;
    setPending(true);
    setBoardAction(action);
    setFeedback(null);
    let result: ManagementResult<BoardRunResult>;
    try {
      result = action === 'run' ? await mgmt.runBoard(ws, runTeamId!) : await mgmt.stopBoard(ws);
    } catch (reason) {
      result = { ok: false, error: thrownError(reason) };
    } finally {
      writeLock.current = false;
      if (mounted.current) {
        setPending(false);
        setBoardAction(null);
      }
    }
    if (!mounted.current) return;
    setFeedback(result.ok ? { kind: 'success', text: boardResultText(action, team, result.data) } : boardErrorFeedback(action, result.error));
    void overview.reload();
    void board.reload();
  }

  function closeCreate(target: CreateFocusTarget): void {
    props.onCreateTeamRequestedChange(false);
    props.onCreateFocusRequest(target);
    setCreateError(null);
  }

  async function createTeam(name: string): Promise<void> {
    if (writeLock.current || readOnlyRef.current || !connectedRef.current) return;
    writeLock.current = true;
    setPending(true);
    setCreateError(null);
    try {
      let result: ManagementResult<TeamEditResult>;
      try {
        result = await mgmt.createTeam(ws, { name });
      } catch (reason) {
        result = { ok: false, error: thrownError(reason) };
      }
      if (!mounted.current) return;
      if (!result.ok) {
        setCreateError(errorFeedback('Team was not created.', result.error));
        return;
      }
      const createdId = result.data.team.id;
      let text = `Created team "${result.data.team.name}".${problemsSuffix(result.data.problems)}`;
      setSavedRevision((r) => r + 1);
      const refreshed = await navigation.reloadAndSelect(createdId);
      if (!mounted.current) return;
      let target: CreateFocusTarget = { kind: 'new-team' };
      if (!refreshed.ok) {
        text += ` Team list refresh failed (${refreshed.error.code}: ${refreshed.error.message}). Refresh Teams to select it.`;
      } else {
        const row = navigationItems(refreshed.data).find((item) => item.team.id === createdId);
        if (row === undefined) text += ` The refreshed team list did not include team "${createdId}"; refresh Teams to select it.`;
        else target = { kind: 'team', key: row.key };
      }
      setFeedback({ kind: 'success', text });
      closeCreate(target);
    } finally {
      writeLock.current = false;
      if (mounted.current) setPending(false);
    }
  }

  async function refreshAll(announce = false, includeOverview = true): Promise<void> {
    if (refreshLock.current) return;
    refreshLock.current = true;
    setRefreshing(true);
    if (announce) setFeedback((f) => (f?.kind === 'success' ? null : f));
    try {
      const results = await Promise.all((includeOverview ? [overview, agents, board, roleCatalog] : [agents, board, roleCatalog]).map(async (section) => {
        if (!section.reloadFresh) { await section.reload(); return true; }
        return (await section.reloadFresh()).ok;
      }));
      if (announce && mounted.current && results.every(Boolean)) setFeedback({ kind: 'success', text: 'Teams data refreshed.' });
    } finally {
      refreshLock.current = false;
      if (mounted.current) { setRefreshing(false); if (announce && !document.activeElement?.closest('.teams-roster')) refreshRef.current?.focus(); }
    }
  }
  async function retrySection(section: DashboardSectionController<unknown>, retryId: string, headingId: string): Promise<void> {
    const result = section.reloadFresh ? await section.reloadFresh() : null;
    if (!result) await section.reload();
    if (!mounted.current) return;
    focusAfter.current = result?.ok === false ? retryId : headingId;
    bumpFocus(n => n + 1);
  }
  useEffect(() => {
    const id = focusAfter.current;
    if (id === null) return;
    const el = document.getElementById(id) ?? (id === 'teams-detail-title' || id === 'teams-board-title' ? document.getElementById('teams-list-title') : null);
    if (!el) return;
    focusAfter.current = null;
    el.focus();
  });

  const lastConnection = useRef(connectionState);
  useEffect(() => {
    const previous = lastConnection.current;
    lastConnection.current = connectionState;
    if (connectionState === 'connected' && previous !== null && previous !== 'connected') void refreshAll(false, false);
  }, [connectionState]);

  if (agents.state === 'ready' && agents.data !== null) lastAgents.current = agents.data;
  if (roleCatalog.state === 'ready' && roleCatalog.data !== null) lastRoles.current = roleCatalog.data;
  if (board.state === 'ready' && board.data !== null) lastBoard.current = board.data;
  const data = navigation.data;
  const overviewFresh = navigation.fresh;
  const agentsFresh = agents.state === 'ready' && agents.data !== null && connected;
  const rolesData = roleCatalog.data ?? lastRoles.current;
  const rolesFresh = roleCatalog.state === 'ready' && roleCatalog.data !== null && connected;
  readOnlyRef.current = !overviewFresh;
  const agentList = (agents.data ?? lastAgents.current)?.agents ?? null;
  const roleItems: RoleCatalogItem[] | null = rolesData !== null && rolesData.state !== 'invalid' ? rolesData.items : null;
  const roleCatalogMessage = roleItems !== null ? null
    : roleCatalog.loading ? 'Loading the role catalog…'
    : roleCatalog.error !== null ? 'The role catalog could not be loaded. Retry loading it to choose or change a role.'
    : rolesData?.state === 'invalid' ? 'The role catalog is invalid. Fix it in Roles before choosing a role.'
    : 'The role catalog is unavailable. Retry loading it to choose or change a role.';
  const selected = navigation.selected;
  const view = selected !== null && viewState.teamKey === selected.key ? viewState : selectTeamView(INITIAL_TEAMS_VIEW, selected?.key ?? null);
  const [seenIntent, setSeenIntent] = useState({ key: navigation.selectedKey, version: navigation.selectionVersion, sidebarVersion: navigation.sidebarSelectionVersion });
  const focusDetail = useRef(false);
  if (seenIntent.key !== navigation.selectedKey || seenIntent.version !== navigation.selectionVersion) {
    if (seenIntent.sidebarVersion !== navigation.sidebarSelectionVersion) focusDetail.current = true;
    setSeenIntent({ key: navigation.selectedKey, version: navigation.selectionVersion, sidebarVersion: navigation.sidebarSelectionVersion });
    setSelectedMember(null);
    setViewState(selectTeamView(INITIAL_TEAMS_VIEW, navigation.selectedKey));
  }
  useEffect(() => {
    if (!focusDetail.current) return;
    focusDetail.current = false;
    document.getElementById('teams-detail-title')?.focus();
  }, [seenIntent]);
  useEffect(() => { if (selectedMember && selectedMember.teamKey !== view.teamKey) setSelectedMember(null); }, [selectedMember, view.teamKey]);
  const notices = data === null ? [] : overviewNotices(data);
  const rolesPending = roleCatalog.loading && roleCatalog.error === null;
  const agentsPending = agents.loading && agents.error === null;
  const catalogStatus = connected && overview.state !== 'loading' && (rolesPending || agentsPending);
  const announceBase = connected && overview.state !== 'loading' && !catalogStatus;
  const announceFeedback = announceBase && !memberNotice;
  const announceChild = announceBase && (memberNotice || feedback?.kind !== 'success');

  return (
    <div className="teams-screen" data-section="teams">
      <header className="dashboard-header">
        <div className="dashboard-title">
          <nav className="breadcrumb" aria-label="Breadcrumb"><ol><li>Workspace</li><li aria-current="page">Teams</li></ol></nav>
          <h1>Teams</h1>
          <p className="teams-subtitle">Manage team membership, routing, and live operation in this workspace.</p>
        </div>
        <div className="dashboard-actions">
          <button type="button" className="refresh-button" aria-busy={busy} ref={refreshRef} onClick={() => { void refreshAll(true); }}>
            <ShellIcon name="refresh" />
            Refresh
          </button>
        </div>
      </header>
      {roleCatalog.error !== null && <SectionError section={roleCatalog} alert={alertSource === 'roles'} label="Role catalog" retryLabel="Retry loading roles" retryId="teams-retry-roles" stale={rolesData !== null} onRetry={() => { void retrySection(roleCatalog, 'teams-retry-roles', 'teams-detail-title'); }} />}
      {agents.error !== null && <SectionError section={agents} alert={alertSource === 'agents'} label="Agent catalog" retryLabel="Retry loading agents" retryId="teams-retry-agents" stale={lastAgents.current !== null} onRetry={() => { void retrySection(agents, 'teams-retry-agents', 'teams-detail-title'); }} />}
      <WriteFeedbackView feedback={feedback} alert={alertSource === 'feedback'} announce={announceFeedback} onDismiss={() => setFeedback(null)} />
      {!connected && (
        <p className="panel-note teams-connection-note" role="status">
          {connectionState === 'lost' ? 'Connection lost. Showing previously loaded data.' : 'Connecting to Agent Studio…'}
        </p>
      )}
      {rolesPending && <p className="panel-loading teams-catalog-loading" role={catalogStatus ? 'status' : undefined}>{rolesData === null ? 'Loading the role catalog…' : 'Refreshing the role catalog… Showing previously loaded data.'}</p>}
      {agentsPending && <p className="panel-loading teams-catalog-loading" role={catalogStatus && !rolesPending ? 'status' : undefined}>{lastAgents.current === null ? 'Loading the agent catalog…' : 'Refreshing the agent catalog… Showing previously loaded data.'}</p>}
      {data !== null && notices.length > 0 && (
        <ul className="teams-notices" aria-label="Data notices">
          {notices.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      {confirmation && <div className="modal-overlay teams-live-modal"><div role="dialog" aria-modal="true" aria-labelledby="teams-switch-title" aria-describedby="teams-switch-description" onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); closeConfirmation(confirmation.trigger); }
        if (e.key === 'Tab') { if (confirmRef.current?.disabled) { e.preventDefault(); cancelRef.current?.focus(); } else if (e.shiftKey && document.activeElement === confirmRef.current) { e.preventDefault(); cancelRef.current?.focus(); } else if (!e.shiftKey && document.activeElement === cancelRef.current) { e.preventDefault(); confirmRef.current?.focus(); } }
      }}><h2 id="teams-switch-title">Confirm cancellation</h2><p id="teams-switch-description">Switch {confirmation.memberName} to {confirmation.agentLabel} and cancel assignment <code>{confirmation.assignmentId}</code>?</p>{confirmation.changed && <p role="alert">The assignment changed; fresh confirmation is required.</p>}<div className="dialog-actions"><button ref={confirmRef} type="button" disabled={!overviewFresh || confirmationActionInFlight} onClick={() => { void switchAgent(confirmation, confirmation.assignmentId); }}>Confirm cancellation</button><button ref={cancelRef} type="button" onClick={() => closeConfirmation(confirmation.trigger)}>Cancel</button></div></div></div>}
      {props.createTeamRequested && (
        <TeamCreateDialog
          pending={pending}
          readOnly={!overviewFresh || !connected}
          error={createError}
          onSubmit={(name) => { void createTeam(name); }}
          onCancel={() => closeCreate({ kind: 'new-team' })}
          onDismissError={() => setCreateError(null)}
        />
      )}
      <FormAlertContext.Provider value={setFormAlert}>
      {(overview.state !== 'ready' || (data !== null && selected === null) || (selected === null && (board.state === 'loading' || board.state === 'error'))) && (
        <section className="dashboard-panel teams-status-panel" aria-labelledby="teams-list-title">
          <h2 id="teams-list-title" tabIndex={-1}>Teams data status</h2>
          {overview.state === 'loading' && data === null && <p className="panel-loading" role={connected ? 'status' : undefined}>Loading teams…</p>}
          {overview.state === 'loading' && data !== null && connected && <p className="panel-loading" role="status">Refreshing teams… Showing previously loaded data.</p>}
          {overview.state === 'error' && <SectionError section={overview} alert={alertSource === 'overview'} stale={data !== null} retryId="teams-retry-overview" onRetry={() => { void retrySection(overview, 'teams-retry-overview', 'teams-detail-title'); }} />}
          {data !== null && navigation.items.length === 0 && (
            <p className="panel-empty">No teams defined in this workspace.</p>
          )}
          {selected === null && (board.state === 'loading' || board.state === 'error') && (
            <section className="teams-board" aria-labelledby="teams-board-title">
              <h3 id="teams-board-title" tabIndex={-1}>Board control</h3>
              {board.state === 'loading' && <p className="panel-loading" role={announceChild ? 'status' : undefined}>{lastBoard.current === null ? 'Loading board state…' : 'Refreshing board state… Showing previously loaded data.'}</p>}
              {board.state === 'error' && <SectionError section={board} alert={alertSource === 'board'} label="Board" stale={lastBoard.current !== null} retryId="teams-retry-board" onRetry={() => { void retrySection(board, 'teams-retry-board', 'teams-board-title'); }} />}
            </section>
          )}
        </section>
      )}
        {data !== null && selected !== null && (
          <TeamDetailPanel
            key={selected.key}
            workspaceId={ws}
            management={mgmt}
            savedRevision={savedRevision}
            team={selected.team}
            teamKey={selected.key}
            selection={selectedMember}
            onSelectMember={setSelectedMember}
            overview={data}
            agents={agentList}
            agentsFresh={agentsFresh}
            rolesFresh={rolesFresh}
            readOnly={!overviewFresh}
            roleItems={roleItems}
            roleCatalogMessage={roleCatalogMessage}
            onViewRole={props.onViewRole}
            writes={writes}
            connected={connected}
            actions={actions}
            polling={polling}
            onSwitch={(team, member, agentId, agentLabel, trigger) => { if (team.id && member.memberId) void switchAgent({ teamDefId: team.id, memberId: member.memberId, memberName: memberName(member), agentId, agentLabel, trigger, selectionKey: selectedMember?.teamKey ?? '', signature: lastSwitchSignature(member.runtime?.lastSwitch ?? null) }); }}
            onResume={(team, member, agentId, label) => { if (team.id && member.memberId) void resumeAgent(team.id, member.memberId, agentId, label); }}
            pending={pending}
            announce={announceChild}
            onMemberNoticeChange={setMemberNotice}
            view={view.view}
            onSelectView={(next) => { if (next !== 'overview') setSelectedMember(null); setViewState(selectChildView(view, next)); }}
            routing={<RoutingSettingsPanel workspaceId={props.workspace.id} management={props.management} section={board} connected={connected} announce={announceChild} alert={alertSource === 'board' || alertSource === 'routing'} onLocalErrorChange={setRoutingError} roleItems={roleItems} onViewRole={props.onViewRole} />}
            board={{
              section: board,
              lastSettings: lastBoard.current,
              connected: overviewFresh,
              alert: alertSource === 'board',
              announce: announceChild,
              onRetry: () => { void retrySection(board, 'teams-retry-board', 'teams-board-title'); },
              action: boardAction,
              onRun: (t) => { void boardWrite('run', t); },
              onStop: (t) => { void boardWrite('stop', t); },
            }}
          />
        )}
      </FormAlertContext.Provider>
    </div>
  );
}

function TeamDetailPanel(props: {
  workspaceId: string; management: ManagementApi; savedRevision: number;
  team: OverviewTeam;
  overview: TeamOverview;
  teamKey: string; selection: MemberSelection | null; onSelectMember(selection: MemberSelection | null): void;
  agents: AgentDef[] | null;
  agentsFresh: boolean; rolesFresh: boolean;
  roleItems: RoleCatalogItem[] | null;
  roleCatalogMessage: string | null;
  onViewRole?(roleId: string): void;
  connected: boolean;
  actions: Record<string, MemberActionInFlight>;
  polling: Record<string, boolean>;
  onSwitch(team: OverviewTeam, member: OverviewMember, id: string, label: string, trigger: HTMLButtonElement): void;
  onResume(team: OverviewTeam, member: OverviewMember, id: string, label: string): void;
  announce: boolean;
  onMemberNoticeChange(active: boolean): void;
  readOnly: boolean;
  writes: TeamWrites;
  pending: boolean;
  view: TeamsChildView;
  onSelectView(view: TeamsChildView): void;
  routing: JSX.Element;
  board: {
    section: DashboardSectionController<BoardSettings>;
    lastSettings: BoardSettings | null;
    alert?: boolean;
    announce?: boolean;
    onRetry(): void;
    connected: boolean;
    action: BoardAction | null;
    onRun(team: OverviewTeam): void;
    onStop(team: OverviewTeam): void;
  };
}): JSX.Element {
  const { team, overview, writes, pending, board } = props;

  const panel = (id: TeamsChildView): JSX.Element | null => {
    if (id === 'routing') return props.routing;
    if (id === 'overview') return (
      <MembersView workspaceId={props.workspaceId} management={props.management} savedRevision={props.savedRevision} teamKey={props.teamKey} team={team} selection={props.selection} onSelect={props.onSelectMember}
        agents={props.agents} agentsFresh={props.agentsFresh} rolesFresh={props.rolesFresh} readOnly={props.readOnly} roleItems={props.roleItems} roleCatalogMessage={props.roleCatalogMessage} onViewRole={props.onViewRole}
        writes={writes} pending={pending} announce={props.announce} onNoticeChange={props.onMemberNoticeChange} connected={props.connected && !props.readOnly} actions={props.actions} polling={props.polling}
        onSwitch={props.onSwitch} onResume={props.onResume}
        summary={<TeamOverviewPanel team={team} overview={overview} stale={props.readOnly} writes={writes} pending={pending} readOnly={props.readOnly} board={board} />} />
    );
    return null;
  };
  return (
    <section className="dashboard-panel teams-detail" aria-labelledby="teams-detail-title">
      <h2 id="teams-detail-title" tabIndex={-1}>{teamLabel(team)}</h2>
      <TeamViewTabs teamName={teamLabel(team)} selected={props.view} onSelect={props.onSelectView} />
      {TEAMS_CHILD_VIEWS.map(({ id }) => (
        <div key={id} role="tabpanel" id={teamsPanelId(id)} aria-labelledby={teamsTabId(id)} className="teams-view-panel" hidden={id !== props.view} tabIndex={id === props.view ? 0 : undefined}>
          {id === props.view && panel(id)}
        </div>
      ))}
    </section>
  );
}
