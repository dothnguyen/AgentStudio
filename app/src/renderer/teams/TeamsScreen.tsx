import { SectionError } from './SectionError';
import { TeamOverviewPanel } from './TeamOverviewPanel';
import { MembersView } from './MembersView';
import type { MemberListActions } from './MemberList';
import { INITIAL_TEAMS_VIEW, selectTeamView, type TeamsViewState } from './teamsViewModel';
import { useEffect, useRef, useState, type JSX } from 'react';
import type {
  AgentCatalogList,
  AgentDef,
  AttentionRun,
  AttachInfo,
  BoardRunResult,
  BoardSettings,
  ConnectionStatus,
  ManagementApi,
  ManagementError,
  ManagementResult,
  OverviewTeam,
  OverviewMember,
  Result,
  RoleCatalogItem,
  RoleCatalogList,
  RunRetryResult,
  TeamEditResult,
  TeamOverview,
  Workspace,
} from '../api';
import { navigationItems } from './teamsNavigationModel';
import type { TeamsNavigationController } from './useTeamsNavigationController';
import { useDashboardSection, type DashboardSectionController } from '../dashboard/useDashboardSection';
import { TeamPageHeader } from './TeamPageHeader';
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
  type ErrorFeedback,
  type TeamActions,
  type TeamWrites,
  type WriteFeedback,
} from './teamEditModel';
import { useCopyStatus } from '../ui/useCopyStatus';
import { buildStopPlan, TeamStopSequence, type StopMode, type StopRefresh, type StopSequenceState } from './teamStopModel';
import {

  memberName,
  overviewNotices,
  plural,
  teamLabel,
  type MemberSelection,
} from './teamsModel';

export interface TeamsScreenProps {
  workspace: Workspace;
  management: ManagementApi;
  navigation: TeamsNavigationController;
  connection?: ConnectionStatus;
  onViewRole?(roleId: string): void;
  onOpenBoard?(): void;
  /** Navigates to the workspace Routing screen. */
  onOpenRouting?(): void;
  /** Navigates to the Agents catalog from the Edit agent options dialog. */
  onOpenAgents?(): void;
  /** Opens the read-only ticket page for a key shown on the team page. */
  onOpenTicket?(key: string): void;
  /** One-shot request to open a member page, usually from a role's Used by list. */
  requestedMember?: { teamId: string; memberId: string } | null;
  onRequestedMemberConsumed?(): void;
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
  const appliedMemberRequest = useRef<string | null>(null);
  const [viewState, setViewState] = useState<TeamsViewState>(INITIAL_TEAMS_VIEW);
  const refreshLock = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const busy = refreshing || overview.loading || agents.loading || board.loading || roleCatalog.loading;
  const [feedback, setFeedback] = useState<WriteFeedback | null>(null);
  const { status: copyStatus, copy } = useCopyStatus();
  const [formAlert, setFormAlert] = useState(false);
  const [memberNotice, setMemberNotice] = useState(false);
  const [pending, setPending] = useState(false);
  const [teamTransition, setTeamTransition] = useState<StopMode | null>(null);
  const [stopState, setStopState] = useState<StopSequenceState | null>(null);
  const stopSequence = useRef<TeamStopSequence | null>(null);
  const [savedRevision, setSavedRevision] = useState(0);
  const [createError, setCreateError] = useState<Extract<WriteFeedback, { kind: 'error' }> | null>(null);
  const writeLock = useRef(false);
  const actionLocks = useRef(new Set<string>());
  const [actions, setActions] = useState<Record<string, MemberActionInFlight>>({});
  const [polling, setPolling] = useState<Record<string, boolean>>({});
  const [confirmation, setConfirmation] = useState<{ teamDefId: string; memberId: string; memberName: string; agentId: string; agentLabel: string; assignmentId: string; trigger: HTMLButtonElement; signature: string | null; selectionKey: string; changed: boolean; fromRow?: boolean } | null>(null);
  const alertSource = confirmation?.changed ? 'confirmation' : createError !== null && props.createTeamRequested ? 'create' : formAlert ? 'form' : feedback?.kind === 'error' ? 'feedback' : overview.state === 'error' ? 'overview' : roleCatalog.error !== null ? 'roles' : agents.error !== null ? 'agents' : board.error !== null ? 'board' : null;
  const confirmationGeneration = useRef(0);
  const selectionIdentity = JSON.stringify([props.workspace.id, navigation.selectedKey, navigation.selectionVersion, viewState.teamKey, selectedMember?.teamKey, selectedMember?.memberId]);
  const previousSelectionIdentity = useRef(selectionIdentity);
  if (previousSelectionIdentity.current !== selectionIdentity) {
    previousSelectionIdentity.current = selectionIdentity;
    confirmationGeneration.current++;
  }
  const selectionIdentityRef = useRef(selectionIdentity);
  selectionIdentityRef.current = selectionIdentity;
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
    options: { inlineFailure?: boolean; feedback?: { current: ErrorFeedback | null } } = {},
  ): Promise<boolean> {
    const reportFailure = options.inlineFailure !== true;
    const recordFailure = (feedback: ErrorFeedback): void => {
      if (options.feedback !== undefined) options.feedback.current = feedback;
      if (reportFailure) setFeedback(feedback);
    };
    if (writeLock.current) return false;
    if (readOnlyRef.current) {
      recordFailure({ kind: 'error', title: failTitle, code: 'STALE_DATA', message: 'Team data is not current.', remediation: 'Wait for the connection and team data to finish loading, then try again.', problems: [], hint: null });
      return false;
    }
    writeLock.current = true;
    setPending(true);
    setFeedback(null);
    const startedAt = selectionIdentityRef.current;
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
    if (selectionIdentityRef.current !== startedAt) {
      // The user left the team/member this write was started from: never announce or select in the new context.
      if (result.ok) { setSavedRevision(r => r + 1); void overview.reload(); }
      return result.ok;
    }
    if (!result.ok) {
      recordFailure(errorFeedback(failTitle, result.error));
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
    if (confirmation && (
      (!confirmation.fromRow && (selectedMember?.memberId !== confirmation.memberId || selectedMember?.teamKey !== confirmation.selectionKey))
      || navigation.selectedKey !== confirmation.selectionKey
    )) {
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

  function handleStopChange(next: StopSequenceState): void {
    if (!mounted.current) return;
    setStopState(next.phase === 'done' || next.phase === 'aborted' ? null : next);
    if (next.feedback !== null) setFeedback(next.feedback);
    if (next.phase === 'done' || next.phase === 'aborted') {
      setTeamTransition(null);
      stopSequence.current = null;
    }
  }

  function openStopSequence(mode: StopMode, team: OverviewTeam): void {
    if (stopSequence.current !== null) return;
    const runtimeTeamId = team.runtime.teamId;
    if (runtimeTeamId === null) {
      setFeedback(errorFeedback(mode === 'restart' ? 'The team was not restarted.' : 'The team was not stopped.', {
        code: 'TEAM_NOT_RUNNING', message: 'The team is not running.', retryable: false,
      }));
      return;
    }
    if (mode === 'restart' && team.id === null) {
      setFeedback(errorFeedback('The team was not restarted.', {
        code: 'NO_DEFINITION', message: 'This team has no definition id.', retryable: false,
      }));
      return;
    }
    const runner = (board.data ?? lastBoard.current)?.runner ?? null;
    const plan = buildStopPlan(team, navigation.data, runner);
    const refresh = async (): Promise<ManagementResult<StopRefresh>> => {
      const loaded = overview.reloadFresh === undefined ? null : await overview.reloadFresh();
      if (loaded === null) {
        return { ok: false, error: { code: 'INTERNAL', message: 'Teams cannot be refreshed.', retryable: true } };
      }
      if (!loaded.ok) return { ok: false, error: loaded.error };
      let currentRunner = (board.data ?? lastBoard.current)?.runner ?? null;
      if (board.reloadFresh !== undefined) {
        const refreshedBoard = await board.reloadFresh();
        if (refreshedBoard.ok) currentRunner = refreshedBoard.data.runner;
      }
      return { ok: true, data: { overview: loaded.data, runner: currentRunner } };
    };
    const sequence = new TeamStopSequence({
      mode,
      teamDefId: team.id ?? '',
      runtimeTeamId,
      teamName: teamLabel(team),
      plan,
      deps: {
        stopBoard: () => mgmt.stopBoard(ws),
        stopTeam: (teamId) => mgmt.stopTeam(ws, teamId),
        startTeam: (teamDefId) => mgmt.startTeam(ws, teamDefId),
        refresh,
      },
      onChange: handleStopChange,
    });
    stopSequence.current = sequence;
    setTeamTransition(mode);
    setFeedback(null);
    setStopState(sequence.snapshot);
  }

  useEffect(() => {
    return () => { stopSequence.current?.abort(); stopSequence.current = null; };
  }, []);
  useEffect(() => {
    return () => { stopSequence.current?.abort(); };
  }, [ws, navigation.selectedKey]);
  useEffect(() => {
    if (!connected) stopSequence.current?.abort();
  }, [connected]);

  const stopDialogActions = {
    chooseSafe: () => stopSequence.current?.chooseSafe(),
    stopNow: () => stopSequence.current?.stopNow(),
    cancelWaiting: () => stopSequence.current?.cancelWaiting(),
    confirmPaused: () => stopSequence.current?.confirmPaused(),
    cancel: () => stopSequence.current?.cancel(),
  };

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
    updateMember: (team, memberId, changes, options) => {
      const feedback: { current: ErrorFeedback | null } = { current: null };
      return runWrite('Member was not saved.', () => mgmt.updateMember(ws, team.id!, memberId, changes), (d) => ({
        text: `Saved ${d.member.name}.${nextStartSuffix(d.appliesOnNextStart)}${problemsSuffix(d.problems)}`,
      }), { inlineFailure: options?.inlineFailure, feedback }).then(ok => ({ ok, feedback: feedback.current }));
    },
    removeMember: (team, memberId) => runWrite('Member was not removed.', () => mgmt.removeMember(ws, team.id!, memberId), (d) => ({
      text: `Removed ${d.removed.name} from ${teamLabel(team)}.${problemsSuffix(d.problems)}`,
    })),
  };

  function commandText(id: string): string {
    for (const item of navigation.data?.teams ?? []) {
      const request = item.attention.commandRequests.find((entry) => entry.id === id);
      if (request !== undefined) return request.command;
    }
    return id;
  }

  async function retryRuns(runs: AttentionRun[]): Promise<ManagementResult<{ retried: number }>> {
    let retried = 0;
    let firstFailure: ManagementError | null = null;
    for (const run of runs) {
      let result: ManagementResult<RunRetryResult>;
      try { result = await mgmt.retryRun(ws, run.workflowRunId); }
      catch (reason) { result = { ok: false, error: thrownError(reason) }; }
      if (!result.ok) {
        // Keep going: one paused run failing must not leave the later ones retried.
        if (firstFailure === null) firstFailure = result.error;
        continue;
      }
      retried += 1;
    }
    if (firstFailure !== null) {
      return { ok: false, error: { ...firstFailure, message: `${firstFailure.message} Retried ${retried} of ${runs.length} paused runs.` } };
    }
    return { ok: true, data: { retried } };
  }

  const teamActions: TeamActions = {
    resetUsage: (team, provider) => runWrite('Usage limits were not reset.', () => mgmt.resetUsage(ws, team.id!, provider), (d) => {
      const cleared = d.members.filter((member) => member.cleared.length > 0).length;
      const switched = d.members.filter((member) => member.switched);
      const switchedText = switched.length === 0
        ? ''
        : `, ${switched.length} switched to ${[...new Set(switched.map((member) => member.activeAgent ?? 'another agent'))].join(', ')}`;
      return { text: `Reset ${d.provider} usage limits: ${plural(cleared, 'member cleared', 'members cleared')}${switchedText}.` };
    }),
    unblockTicket: (key, to) => runWrite('Ticket was not unblocked.', () => mgmt.unblockTicket(ws, key, to), (d) => ({
      text: `Unblocked ${d.ticket.key} to ${d.ticket.status}.`,
    })),
    retryPausedRuns: (runs) => runWrite('Paused runs were not retried.', () => retryRuns(runs), (d) => ({
      text: `Retried ${plural(d.retried, 'paused run', 'paused runs')}.`,
    })),
    retryRun: (run) => runWrite('Run was not retried.', () => mgmt.retryRun(ws, run.workflowRunId), () => ({
      text: `Retried the ${run.stage ?? 'current'} stage of ${run.ticketKey ?? run.workflowRunId}.`,
    })),
    requeueTicket: (key) => runWrite('Ticket was not requeued.', () => mgmt.retryTicket(ws, key), () => ({
      text: `Requeued ${key}.`,
    })),
    stopRun: (run) => runWrite('Run was not stopped.', () => mgmt.cancelRun(ws, run.workflowRunId), () => ({
      text: `Stopped the run for ${run.ticketKey ?? run.workflowRunId}; the ticket is blocked.`,
    })),
    approveCommand: (id) => runWrite('Command was not approved.', () => mgmt.approveCommand(ws, id), () => ({
      text: `Approved ${commandText(id)}.`,
    })),
    rejectCommand: (id, reason) => runWrite('Command was not rejected.', () => mgmt.rejectCommand(ws, id, reason), () => ({
      text: `Rejected ${commandText(id)}.`,
    })),
    cancelCommand: (id, reason) => runWrite('Command was not cancelled.', () => mgmt.cancelCommand(ws, id, reason), () => ({
      text: `Cancelled ${commandText(id)}.`,
    })),
    attachCommand: async (team, kind) => {
      const runtimeId = team.runtime.teamId;
      if (runtimeId === null) {
        setFeedback(errorFeedback('Attach command could not be copied.', { code: 'NOT_RUNNING', message: 'The team is not running.', retryable: false }));
        return false;
      }
      let result: ManagementResult<AttachInfo>;
      try { result = await mgmt.attachInfo(ws, runtimeId); }
      catch (reason) { result = { ok: false, error: thrownError(reason) }; }
      if (!mounted.current) return false;
      if (!result.ok) {
        setFeedback(errorFeedback('Attach command could not be copied.', result.error));
        return false;
      }
      copy(result.data[kind], kind === 'wsl' ? 'Attach command (WSL)' : 'Attach command (Windows Terminal)');
      return true;
    },
    startTeam: (team) => {
      if (team.id === null) {
        setFeedback(errorFeedback('The team was not started.', { code: 'NO_DEFINITION', message: 'This team has no definition id.', retryable: false }));
        return Promise.resolve(false);
      }
      const boardRunning = ((board.data ?? lastBoard.current)?.runner.status === 'running');
      return runWrite('The team was not started.', () => mgmt.startTeam(ws, team.id!), () => ({
        text: `Started ${teamLabel(team)}.${boardRunning ? '' : ' The board is not running; use Run board to start claiming tickets.'}`,
      }));
    },
    stopTeam: (team, mode) => { openStopSequence(mode, team); return Promise.resolve(true); },
    restartTeam: (team, mode) => { openStopSequence(mode, team); return Promise.resolve(true); },
    copy,
  };

  const memberActions: MemberListActions = {
    onRetryRun: (run) => { void teamActions.retryRun(run); },
    onRequeueTicket: (key) => { void teamActions.requeueTicket(key); },
    onStopRun: (run) => { void teamActions.stopRun(run); },
    onUnblockTicket: (key, to) => { void teamActions.unblockTicket(key, to); },
    onApproveCommand: (id) => { void teamActions.approveCommand(id); },
    onRejectCommand: (id, reason) => { void teamActions.rejectCommand(id, reason); },
    onCancelCommand: (id, reason) => { void teamActions.cancelCommand(id, reason); },
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
  async function switchAgent(context: { teamDefId: string; memberId: string; memberName: string; agentId: string; agentLabel: string; trigger: HTMLButtonElement; signature: string | null; selectionKey: string; fromRow?: boolean }, assignmentId?: string): Promise<void> {
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
          if (!context.fromRow && (selectedMemberRef.current?.memberId !== context.memberId || selectedMemberRef.current?.teamKey !== context.selectionKey)) return;
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
        const terminal = member ? matchingTerminalSwitch(member, context.agentId, context.signature) : null;
        if (terminal === 'completed') {
          setFeedback({ kind: 'success', text: `Switched ${context.memberName} to ${context.agentLabel}.` });
          return;
        }
        if (terminal === 'failed') {
          const result = member?.runtime?.lastSwitch ?? null;
          setFeedback(errorFeedback('Switch failed.', {
            code: result?.code ?? 'SWITCH_FAILED',
            message: result?.message ?? `Switching ${context.memberName} to ${context.agentLabel} did not complete.`,
            retryable: false,
          }));
          return;
        }
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
  useEffect(() => {
    const request = props.requestedMember;
    if (request === null || request === undefined) { appliedMemberRequest.current = null; return; }
    const requestKey = `${request.teamId}:${request.memberId}`;
    if (appliedMemberRequest.current === requestKey) return;
    const item = navigation.items.find((candidate) => candidate.team.id === request.teamId || candidate.team.runtime.teamId === request.teamId);
    if (item === undefined) return;
    const exists = item.team.members.some((member) => member.memberId === request.memberId);
    if (!exists) {
      appliedMemberRequest.current = requestKey;
      props.onRequestedMemberConsumed?.();
      return;
    }
    // Selecting another team resets the member selection during the render that
    // applies the new team key; wait for that render, then open the member.
    if (navigation.selectedKey !== item.key) {
      navigation.selectTeam(item.key);
      return;
    }
    appliedMemberRequest.current = requestKey;
    setViewState({ teamKey: item.key, memberId: request.memberId });
    setSelectedMember({ teamKey: item.key, memberId: request.memberId });
    props.onRequestedMemberConsumed?.();
  }, [props.requestedMember, navigation.items, navigation.selectTeam, navigation.selectedKey]);
  const notices = data === null ? [] : overviewNotices(data);
  const rolesPending = roleCatalog.loading && roleCatalog.error === null;
  const agentsPending = agents.loading && agents.error === null;
  const catalogStatus = connected && overview.state !== 'loading' && (rolesPending || agentsPending);
  const announceBase = connected && overview.state !== 'loading' && !catalogStatus;
  const announceFeedback = announceBase && !memberNotice;
  const announceChild = announceBase && (memberNotice || feedback?.kind !== 'success');

  return (
    <div className="teams-screen teams-screen-v4" data-section="teams">
      <TeamPageHeader
        key={data !== null && selected !== null ? selected.key : 'none'}
        team={data !== null && selected !== null ? selected.team : null}
        busy={busy}
        refreshRef={refreshRef}
        onRefresh={() => { void refreshAll(true); }}
        writes={writes}
        teamActions={teamActions}
        blockedTickets={data?.blockedTickets ?? []}
        blockedTicketsTruncated={data?.blockedTicketsTruncated ?? false}
        boardStatuses={(board.data ?? lastBoard.current)?.statuses ?? null}
        connected={connected}
        pending={pending || teamTransition !== null}
        readOnly={!overviewFresh}
        stopDialog={stopState === null ? null : { state: stopState, ...stopDialogActions }}
      />
      {roleCatalog.error !== null && <SectionError section={roleCatalog} alert={alertSource === 'roles'} label="Role catalog" retryLabel="Retry loading roles" retryId="teams-retry-roles" stale={rolesData !== null} onRetry={() => { void retrySection(roleCatalog, 'teams-retry-roles', 'teams-detail-title'); }} />}
      {agents.error !== null && <SectionError section={agents} alert={alertSource === 'agents'} label="Agent catalog" retryLabel="Retry loading agents" retryId="teams-retry-agents" stale={lastAgents.current !== null} onRetry={() => { void retrySection(agents, 'teams-retry-agents', 'teams-detail-title'); }} />}
      <WriteFeedbackView feedback={feedback} alert={alertSource === 'feedback'} announce={announceFeedback} onDismiss={() => setFeedback(null)} />
      {copyStatus !== null && <p className="teams-copy-status" role="status">{copyStatus}</p>}
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
            roleCatalogSha={roleItems !== null ? rolesData?.sha256 ?? null : null}
            reloadRoleCatalog={() => roleCatalog.reloadFresh
              ? roleCatalog.reloadFresh()
              : Promise.resolve({ ok: false as const, error: { code: 'INTERNAL', message: 'Role catalog reload is unavailable.', retryable: true } })}
            roleCatalogMessage={roleCatalogMessage}
            onViewRole={props.onViewRole}
            onManageAgents={props.onOpenAgents}
            onOpenTicket={props.onOpenTicket}
            writes={writes}
            connected={connected}
            actions={actions}
            polling={polling}
            onSwitch={(team, member, agentId, agentLabel, trigger) => { if (team.id && member.memberId) void switchAgent({ teamDefId: team.id, memberId: member.memberId, memberName: memberName(member), agentId, agentLabel, trigger, selectionKey: selected.key, signature: lastSwitchSignature(member.runtime?.lastSwitch ?? null), fromRow: selectedMember === null }); }}
            onResume={(team, member, agentId, label) => { if (team.id && member.memberId) void resumeAgent(team.id, member.memberId, agentId, label); }}
            memberActions={memberActions}
            copy={copy}
            pending={pending || teamTransition !== null}
            announce={announceChild}
            onMemberNoticeChange={setMemberNotice}
            onOpenRouting={props.onOpenRouting}
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
              onOpenBoard: props.onOpenBoard,
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
  roleCatalogSha: string | null;
  reloadRoleCatalog(): Promise<Result<RoleCatalogList>>;
  roleCatalogMessage: string | null;
  onViewRole?(roleId: string): void;
  onManageAgents?(): void;
  onOpenTicket?(key: string): void;
  connected: boolean;
  actions: Record<string, MemberActionInFlight>;
  polling: Record<string, boolean>;
  onSwitch(team: OverviewTeam, member: OverviewMember, id: string, label: string, trigger: HTMLButtonElement): void;
  onResume(team: OverviewTeam, member: OverviewMember, id: string, label: string): void;
  memberActions: MemberListActions;
  copy(text: string, label: string): void;
  announce: boolean;
  onMemberNoticeChange(active: boolean): void;
  readOnly: boolean;
  writes: TeamWrites;
  pending: boolean;
  onOpenRouting?(): void;
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
    onOpenBoard?(): void;
  };
}): JSX.Element {
  const { team, overview, writes, pending, board } = props;
  return (
    <section className="teams-detail" aria-labelledby="teams-detail-title">
      <section className="teams-view-panel" aria-label="Overview">
        <MembersView workspaceId={props.workspaceId} management={props.management} savedRevision={props.savedRevision} teamKey={props.teamKey} team={team} selection={props.selection} onSelect={props.onSelectMember}
          agents={props.agents} agentsFresh={props.agentsFresh} rolesFresh={props.rolesFresh} readOnly={props.readOnly} roleItems={props.roleItems} roleCatalogSha={props.roleCatalogSha} reloadRoleCatalog={props.reloadRoleCatalog} roleCatalogMessage={props.roleCatalogMessage} onViewRole={props.onViewRole}
          onManageAgents={props.onManageAgents}
          writes={writes} pending={pending} announce={props.announce} onNoticeChange={props.onMemberNoticeChange} connected={props.connected && !props.readOnly} actions={props.actions} polling={props.polling}
          onSwitch={props.onSwitch} onResume={props.onResume}
          attention={team.attention}
          blockedTickets={overview.blockedTickets}
          boardStatuses={props.board.section.data?.statuses ?? props.board.lastSettings?.statuses ?? null}
          memberActions={props.memberActions}
          copy={props.copy}
          onOpenTicket={props.onOpenTicket}
          summary={<TeamOverviewPanel team={team} overview={overview} stale={props.readOnly} pending={pending} board={board} />} />
      </section>
      {props.onOpenRouting !== undefined && (
        <p className="teams-routing-link">
          Autonomous work follows the board&apos;s routing.{' '}
          <button type="button" className="teams-routing-link-button" onClick={props.onOpenRouting}>Open Routing</button>
        </p>
      )}
    </section>
  );
}
