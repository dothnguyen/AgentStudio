import { RoutingSettingsPanel } from './RoutingSettingsPanel';
import { useEffect, useRef, useState, type JSX } from 'react';
import type {
  AgentCatalogList,
  AgentDef,
  BoardRunResult,
  BoardSettings,
  ConnectionStatus,
  ManagementApi,
  ManagementResult,
  MemberChanges,
  OverviewTeam,
  OverviewMember,
  TeamOverview,
  Workspace,
} from '../api';
import { useDashboardSection, type DashboardSectionController } from '../dashboard/useDashboardSection';
import { ShellIcon } from '../shell/ShellIcon';
import { boardControlView, boardErrorFeedback, boardResultText, type BoardAction } from './boardControlModel';
import { assignmentConfirmation, lastSwitchSignature, matchingTerminalSwitch, memberAgentActions, SWITCH_REFRESH_INTERVAL_MS, SWITCH_REFRESH_LIMIT, type MemberActionInFlight } from './memberAgentActionsModel';
import { MemberForm, TeamNameForm, WriteFeedbackView } from './TeamEditForms';
import {
  addMemberInput,
  canEditMember,
  canEditTeam,
  emptyMemberForm,
  errorFeedback,
  knownRoles,
  liveNote,
  memberChanges,
  memberFormInitial,
  nextStartSuffix,
  problemsSuffix,
  thrownError,
  uneditableNote,
  type MemberFormValues,
  type WriteFeedback,
} from './teamEditModel';
import {
  RUNTIME_LABELS,
  definitionBadge,
  memberCountText,
  memberName,
  savedAgentOptionText,
  liveAgentText,
  memberSourceNote,
  orderTeams,
  overviewNotices,
  presenceLabel,
  presenceTone,
  providerModelText,
  roleNote,
  roleText,
  runtimeTone,
  teamKey,
  teamLabel,
  text,
  workText,
} from './teamsModel';

export interface TeamsScreenProps {
  workspace: Workspace;
  management: ManagementApi;
  connection?: ConnectionStatus;
}

export interface TeamWrites {
  rename(team: OverviewTeam, name: string): Promise<boolean>;
  deleteTeam(team: OverviewTeam): Promise<boolean>;
  addMember(team: OverviewTeam, values: MemberFormValues): Promise<boolean>;
  updateMember(team: OverviewTeam, memberId: string, changes: MemberChanges): Promise<boolean>;
  removeMember(team: OverviewTeam, memberId: string): Promise<boolean>;
}

export function TeamsScreen(props: TeamsScreenProps): JSX.Element {
  return <TeamsOverview key={props.workspace.id} {...props} />;
}

function SectionError(props: { section: DashboardSectionController<unknown> }): JSX.Element | null {
  const { section } = props;
  if (section.error === null) return null;
  return (
    <div className="panel-error" role="alert">
      <p><code className="entity-id">{section.error.code}</code>: {section.error.message}</p>
      {typeof section.error.remediation === 'string' && section.error.remediation !== '' && (
        <p>{section.error.remediation}</p>
      )}
      <button type="button" onClick={() => { void section.reload(); }}>Retry</button>
    </div>
  );
}

function actionKey(teamDefId: string, memberId: string): string { return JSON.stringify([teamDefId, memberId]); }

function TeamsOverview(props: TeamsScreenProps): JSX.Element {
  const overview = useDashboardSection<TeamOverview>(props.management.overview, props.workspace.id);
  const agents = useDashboardSection<AgentCatalogList>(props.management.agents, props.workspace.id);
  const board = useDashboardSection<BoardSettings>(props.management.boardSettings, props.workspace.id);
  const [boardAction, setBoardAction] = useState<BoardAction | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const refreshLock = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const busy = refreshing || overview.loading || agents.loading || board.loading;
  const [feedback, setFeedback] = useState<WriteFeedback | null>(null);
  const [pending, setPending] = useState(false);
  const [creating, setCreating] = useState(false);
  const writeLock = useRef(false);
  const actionLocks = useRef(new Set<string>());
  const [actions, setActions] = useState<Record<string, MemberActionInFlight>>({});
  const [polling, setPolling] = useState<Record<string, boolean>>({});
  const [confirmation, setConfirmation] = useState<{ teamDefId: string; memberId: string; memberName: string; agentId: string; agentLabel: string; assignmentId: string; trigger: HTMLButtonElement; signature: string | null; changed: boolean } | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const timers = useRef(new Map<ReturnType<typeof setTimeout>, () => void>());
  const lastData = useRef<TeamOverview | null>(null);
  const actionRefreshQueue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; timers.current.forEach((resolve, timer) => { clearTimeout(timer); resolve(); }); timers.current.clear(); };
  }, []);

  async function runWrite<T>(
    failTitle: string,
    call: () => Promise<ManagementResult<T>>,
    onOk: (data: T) => { text: string; selectKey?: string | null },
  ): Promise<boolean> {
    if (writeLock.current) return false;
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
    const { text: message, selectKey } = onOk(result.data);
    setFeedback({ kind: 'success', text: message });
    if (selectKey !== undefined) setSelectedKey(selectKey);
    void overview.reload();
    return true;
  }

  useEffect(() => { if (confirmation && mounted.current) confirmRef.current?.focus(); else if (!confirmation && restoreFocus.current && mounted.current && restoreFocus.current.isConnected && !restoreFocus.current.disabled) { restoreFocus.current.focus(); restoreFocus.current = null; } }, [confirmation, actions]);
  function closeConfirmation(trigger: HTMLButtonElement): void {
    restoreFocus.current = trigger;
    setConfirmation(null);
    if (mounted.current && trigger.isConnected && !trigger.disabled) trigger.focus();
  }
  const ws = props.workspace.id;
  const mgmt = props.management;
  const writes: TeamWrites = {
    rename: (team, name) => runWrite('Team was not renamed.', () => mgmt.renameTeam(ws, team.id!, name), (d) => ({
      text: `Renamed team to "${d.team.name}".${nextStartSuffix(d.appliesOnNextStart)}${problemsSuffix(d.problems)}`,
    })),
    deleteTeam: (team) => runWrite('Team was not deleted.', () => mgmt.deleteTeam(ws, team.id!), () => ({
      text: `Deleted team "${teamLabel(team)}".`,
      selectKey: null,
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
    const key = actionKey(teamDefId, memberId);
    if (actionLocks.current.has(key)) return false;
    actionLocks.current.add(key);
    setActions(a => ({ ...a, [key]: { memberId, agentId, kind } }));
    setFeedback(null);
    return true;
  }
  function unlock(teamDefId: string, memberId: string): void {
    const key = actionKey(teamDefId, memberId);
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
  async function switchAgent(context: { teamDefId: string; memberId: string; memberName: string; agentId: string; agentLabel: string; trigger: HTMLButtonElement; signature: string | null }, assignmentId?: string): Promise<void> {
    if (!lock(context.teamDefId, context.memberId, context.agentId, 'switch')) return;
    try {
      let result;
      try { result = assignmentId === undefined ? await mgmt.switchMemberAgent(ws, context.teamDefId, context.memberId, context.agentId) : await mgmt.switchMemberAgent(ws, context.teamDefId, context.memberId, context.agentId, { cancelActive: true, assignmentId }); }
      catch (reason) { result = { ok: false as const, error: thrownError(reason) }; }
      if (!mounted.current) return;
      if (!result.ok) {
        const match = assignmentConfirmation(result.error);
        if (match && (assignmentId === undefined || match.assignmentId !== assignmentId)) {
          setConfirmation({ ...context, assignmentId: match.assignmentId, changed: assignmentId !== undefined });
        } else {
          if (assignmentId !== undefined) closeConfirmation(context.trigger);
          setFeedback({ ...errorFeedback('Switch request failed.', result.error), dataText: result.error.data === undefined ? null : JSON.stringify(result.error.data) });
        }
        return;
      }
      if (assignmentId !== undefined) closeConfirmation(context.trigger);
      setPolling(a => ({ ...a, [actionKey(context.teamDefId, context.memberId)]: true }));
      for (let i = 0; i < SWITCH_REFRESH_LIMIT; i++) {
        await waitForPoll();
        if (!mounted.current) return;
        const refreshed = await refreshForAction();
        if (!mounted.current) return;
        if (!refreshed.ok) { setFeedback(errorFeedback('Refresh failed.', refreshed.error)); return; }
        const member = refreshed.data.teams.find(t => t.id === context.teamDefId)?.members.find(m => m.memberId === context.memberId);
        if (member && matchingTerminalSwitch(member, context.agentId, context.signature)) return;
      }
      setFeedback({ kind: 'success', text: 'Switch accepted; completion is still pending. Refresh to check again.' });
    } finally { if (mounted.current) setPolling(a => { const next = { ...a }; delete next[actionKey(context.teamDefId, context.memberId)]; return next; }); unlock(context.teamDefId, context.memberId); }
  }
  async function resumeAgent(teamDefId: string, memberId: string, agentId: string, label: string): Promise<void> {
    if (!lock(teamDefId, memberId, agentId, 'resume')) return;
    try {
      let result;
      try { result = await mgmt.resumeMemberAgent(ws, teamDefId, memberId, agentId); }
      catch (reason) { result = { ok: false as const, error: thrownError(reason) }; }
      if (!mounted.current) return;
      if (!result.ok) { setFeedback({ ...errorFeedback('Resume request failed.', result.error), dataText: result.error.data === undefined ? null : JSON.stringify(result.error.data) }); return; }
      const refreshed = await refreshForAction();
      if (!mounted.current) return;
      if (!refreshed.ok) { setFeedback(errorFeedback('Refresh failed.', refreshed.error)); return; }
      const d = result.data;
      setFeedback({ kind: 'success', text: !d.cleared ? `No recorded quota hold was cleared for ${label}; quota was not verified.` : d.activeAgent !== d.option ? `Quota hold cleared for inactive option ${label}; quota was not verified. The live agent and assignment were not changed.` : `Quota hold cleared for active option ${label}; quota was not verified. Availability is shown from refreshed backend state.` });
    } finally { unlock(teamDefId, memberId); }
  }

  async function boardWrite(action: BoardAction, team: OverviewTeam): Promise<void> {
    if (writeLock.current) return;
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

  async function createTeam(name: string): Promise<void> {
    const ok = await runWrite('Team was not created.', () => mgmt.createTeam(ws, { name }), (d) => ({
      text: `Created team "${d.team.name}".${problemsSuffix(d.problems)}`,
      selectKey: d.team.id,
    }));
    if (ok && mounted.current) setCreating(false);
  }

  async function refreshAll(): Promise<void> {
    if (refreshLock.current) return;
    refreshLock.current = true;
    setRefreshing(true);
    try {
      await Promise.all([overview.reload(), agents.reload(), board.reload()]);
    } finally {
      refreshLock.current = false;
      setRefreshing(false);
    }
  }

  const connectionState = props.connection?.state ?? null;
  const connected = connectionState === null || connectionState === 'connected';
  const lastConnection = useRef(connectionState);
  useEffect(() => {
    const previous = lastConnection.current;
    lastConnection.current = connectionState;
    if (connectionState === 'connected' && previous !== null && previous !== 'connected') void refreshAll();
  }, [connectionState]);

  if (overview.state === 'ready' && overview.data !== null) lastData.current = overview.data;
  const data = overview.data ?? lastData.current;
  const ordered = data === null
    ? []
    : orderTeams(data.teams.map((team, index) => ({ key: teamKey(team, index), team })));
  const selected = ordered.find((item) => item.key === selectedKey) ?? ordered[0] ?? null;
  const notices = data === null ? [] : overviewNotices(data);

  return (
    <div className="teams-screen" data-section="teams">
      <header className="dashboard-header">
        <div className="dashboard-title">
          <nav className="breadcrumb" aria-label="Breadcrumb"><ol><li>Workspace</li><li aria-current="page">Teams</li></ol></nav>
          <h1>Teams</h1>
          <p className="teams-subtitle">Manage team membership, routing, and live operation in this workspace.</p>
        </div>
        <div className="dashboard-actions">
          <button type="button" className="teams-new-button" disabled={pending} onClick={() => setCreating(true)}>
            New team
          </button>
          <button type="button" className="refresh-button" aria-busy={busy} onClick={() => { void refreshAll(); }}>
            <ShellIcon name="refresh" />
            Refresh
          </button>
        </div>
      </header>
      <WriteFeedbackView feedback={feedback} onDismiss={() => setFeedback(null)} />
      {!connected && (
        <p className="panel-note teams-connection-note">
          {connectionState === 'lost'
            ? 'Connection to the backend was lost. Live state may be out of date and board controls are disabled.'
            : 'Connecting to the backend… Live state may be out of date and board controls are disabled.'}
        </p>
      )}
      {overview.state === 'ready' && notices.length > 0 && (
        <ul className="teams-notices" aria-label="Data notices">
          {notices.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      {confirmation && <div className="modal-overlay teams-live-modal"><div role="dialog" aria-modal="true" aria-labelledby="teams-switch-title" aria-describedby="teams-switch-description" onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); closeConfirmation(confirmation.trigger); }
        if (e.key === 'Tab') { if (confirmRef.current?.disabled) { e.preventDefault(); cancelRef.current?.focus(); } else if (e.shiftKey && document.activeElement === confirmRef.current) { e.preventDefault(); cancelRef.current?.focus(); } else if (!e.shiftKey && document.activeElement === cancelRef.current) { e.preventDefault(); confirmRef.current?.focus(); } }
      }}><h2 id="teams-switch-title">Confirm cancellation</h2><p id="teams-switch-description">Switch {confirmation.memberName} to {confirmation.agentLabel} and cancel assignment <code>{confirmation.assignmentId}</code>?</p>{confirmation.changed && <p role="alert">The assignment changed; fresh confirmation is required.</p>}<div className="dialog-actions"><button ref={confirmRef} type="button" disabled={!!actions[actionKey(confirmation.teamDefId, confirmation.memberId)]} onClick={() => { void switchAgent(confirmation, confirmation.assignmentId); }}>Confirm cancellation</button><button ref={cancelRef} type="button" onClick={() => closeConfirmation(confirmation.trigger)}>Cancel</button></div></div></div>}
      <div className="teams-layout">
        <section className="dashboard-panel teams-list-panel" aria-labelledby="teams-list-title">
          <h2 id="teams-list-title">Workspace teams</h2>
          {creating && (
            <TeamNameForm
              heading="New team"
              submitLabel="Create team"
              initialName=""
              pending={pending}
              onSubmit={(name) => { void createTeam(name); }}
              onCancel={() => setCreating(false)}
            />
          )}
          {overview.state === 'loading' && <p className="panel-loading" role="status">Loading teams…</p>}
          {overview.state === 'error' && <SectionError section={overview} />}
          {data !== null && ordered.length === 0 && (
            <p className="panel-empty">No teams defined in this workspace.</p>
          )}
          {data !== null && selected !== null && (
            <ul className="teams-card-list">
              {ordered.map((item) => {
                const { team } = item;
                const badge = definitionBadge(team);
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      className="teams-card"
                      aria-pressed={item.key === selected.key}
                      onClick={() => setSelectedKey(item.key)}
                    >
                      <span className="teams-card-name">{teamLabel(team)}</span>
                      <span className={`status-badge teams-runtime teams-runtime-${team.runtime.state} teams-tone-${runtimeTone(team.runtime.state)}`}>
                        <span className="status-dot" aria-hidden="true" />
                        {RUNTIME_LABELS[team.runtime.state] ?? team.runtime.state}
                      </span>
                      <span className="teams-card-facts">{memberCountText(team)}</span>
                      {badge !== null && <span className="status-badge teams-definition">{badge}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        {data !== null && selected !== null && (
          <TeamDetailPanel
            key={selected.key}
            team={selected.team}
            overview={data}
            agents={agents.state === 'ready' && agents.data !== null ? agents.data.agents : null}
            writes={writes}
            connected={connected}
            actions={actions}
            polling={polling}
            onSwitch={(team, member, agentId, agentLabel, trigger) => { if (team.id && member.memberId) void switchAgent({ teamDefId: team.id, memberId: member.memberId, memberName: memberName(member), agentId, agentLabel, trigger, signature: lastSwitchSignature(member.runtime?.lastSwitch ?? null) }); }}
            onResume={(team, member, agentId, label) => { if (team.id && member.memberId) void resumeAgent(team.id, member.memberId, agentId, label); }}
            pending={pending}
            board={{
              section: board,
              connected,
              action: boardAction,
              onRun: (t) => { void boardWrite('run', t); },
              onStop: (t) => { void boardWrite('stop', t); },
            }}
          />
        )}
        <RoutingSettingsPanel workspaceId={props.workspace.id} management={props.management} section={board} connected={connected} />
      </div>
    </div>
  );
}

function TeamDetailPanel(props: {
  team: OverviewTeam;
  overview: TeamOverview;
  agents: AgentDef[] | null;
  writes: TeamWrites;
  connected: boolean;
  actions: Record<string, MemberActionInFlight>;
  polling: Record<string, boolean>;
  onSwitch(team: OverviewTeam, member: OverviewMember, id: string, label: string, trigger: HTMLButtonElement): void;
  onResume(team: OverviewTeam, member: OverviewMember, id: string, label: string): void;
  pending: boolean;
  board: {
    section: DashboardSectionController<BoardSettings>;
    connected: boolean;
    action: BoardAction | null;
    onRun(team: OverviewTeam): void;
    onStop(team: OverviewTeam): void;
  };
}): JSX.Element {
  const { team, overview, agents, writes, pending, board } = props;
  const [teamForm, setTeamForm] = useState<'rename' | 'delete' | null>(null);
  const [memberForm, setMemberForm] = useState<{ mode: 'add' } | { mode: 'edit'; memberId: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const editable = canEditTeam(team);
  const unNote = uneditableNote(team);
  const runNote = liveNote(team);
  const editing = memberForm?.mode === 'edit'
    ? team.members.find((m) => m.memberId === memberForm.memberId) ?? null
    : null;
  return (
    <section className="dashboard-panel teams-detail" aria-labelledby="teams-detail-title">
      <h2 id="teams-detail-title">{teamLabel(team)}</h2>
      <p className="teams-detail-facts">
        <span>{memberCountText(team)}</span>
        <span>{`Runtime: ${RUNTIME_LABELS[team.runtime.state] ?? team.runtime.state}`}</span>
        {team.runtime.teamId !== null && <code className="entity-id">{team.runtime.teamId}</code>}
      </p>
      {unNote !== null && <p className="panel-note">{unNote}</p>}
      {runNote !== null && <p className="panel-note">{runNote}</p>}
      <BoardControl team={team} pending={pending} {...board} />
      {editable && (
        <div className="teams-team-actions">
          <button type="button" disabled={pending} onClick={() => setTeamForm('rename')}>Rename team</button>
          <button type="button" disabled={pending} onClick={() => setTeamForm('delete')}>Delete team</button>
          <button type="button" disabled={pending} onClick={() => setMemberForm({ mode: 'add' })}>Add member</button>
        </div>
      )}
      {teamForm === 'rename' && (
        <TeamNameForm
          heading="Rename team"
          submitLabel="Save name"
          initialName={team.name ?? ''}
          pending={pending}
          onSubmit={(name) => { void writes.rename(team, name).then((ok) => { if (ok) setTeamForm(null); }); }}
          onCancel={() => setTeamForm(null)}
        />
      )}
      {teamForm === 'delete' && (
        <div className="teams-confirm" role="group" aria-label="Confirm team deletion">
          <p>{`Delete team "${teamLabel(team)}"? Its definition file is removed.`}</p>
          <button
            type="button"
            disabled={pending}
            onClick={() => { void writes.deleteTeam(team).then((ok) => { if (ok) setTeamForm(null); }); }}
          >
            Confirm delete
          </button>
          <button type="button" onClick={() => setTeamForm(null)}>Cancel</button>
        </div>
      )}
      {team.definition.problems.length > 0 && (
        <ul className="teams-problems" aria-label="Definition problems">
          {team.definition.problems.map((p, i) => <li key={i}>{`${p.path}: ${p.message}`}</li>)}
        </ul>
      )}
      {team.members.length === 0 ? (
        <p className="panel-empty">This team has no members.</p>
      ) : (
        <table className="teams-members-table">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Role</th>
              <th scope="col">Saved options</th>
              <th scope="col">Live agent</th>
              <th scope="col">Status</th>
              <th scope="col">Current work</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {team.members.map((m, index) => {
              const source = memberSourceNote(m);
              const role = roleNote(m);
              const name = memberName(m);
              const memberId = m.memberId;
              return (
                <tr key={memberId ?? index}>
                  <td>
                    <span className="teams-member-name">{name}</span>
                    {source !== null && <p className="teams-cell-note">{source}</p>}
                  </td>
                  <td>
                    {roleText(m)}
                    {role !== null && <p className="teams-role-description">{role}</p>}
                  </td>
                  <td>{m.source === 'runtime' ? 'Not available' : m.agentMode === 'inline'
                    ? `Inline — ${providerModelText(m.provider, m.model)}${m.reasoning ? ` · Reasoning: ${m.reasoning}` : ''}`
                    : <ol>{m.agentOptions.map((option, i) => <li key={`${option.id}-${i}`}>{savedAgentOptionText(option, i)}</li>)}</ol>}</td>
                  <td>{liveAgentText(m)}{(() => {
                    const view = memberAgentActions(team, m, agents, props.connected, memberId ? props.actions[actionKey(team.id ?? '', memberId)] ?? null : null);
                    if (!view.visible) return null;
                    return <section className="teams-live-actions" aria-label={`Live agent actions for ${name}`}><h4>Live agent actions</h4><p>{view.activeText}</p><p>{view.availabilityText}</p><p>{view.assignmentText}</p>{view.pendingText && <p>{view.pendingText}</p>}{view.lastResultText && <p>{view.lastResultText}</p>}{view.notice && <p>{view.notice}</p>}{memberId && props.actions[actionKey(team.id ?? '', memberId)] && !props.polling[actionKey(team.id ?? '', memberId)] && <p role="status">Requesting…</p>}<ul>{view.options.map(option => <li key={option.id}><span>{option.label}{option.active && ' · Active'}{option.holdText && ` · ${option.holdText}`}</span>{!option.active && m.runtime?.configuredAgents?.includes(option.id) && <button type="button" disabled={!option.canSwitch || !team.id || !memberId} onClick={e => props.onSwitch(team, m, option.id, option.label, e.currentTarget)}>Switch</button>}{option.holdText && <button type="button" disabled={!option.canResume || !team.id || !memberId} onClick={() => props.onResume(team, m, option.id, option.label)}>Resume</button>}{option.disabledReason && !(memberId && props.polling[actionKey(team.id ?? '', memberId)] && option.disabledReason === 'Requesting…') && <p className="teams-live-reason">{option.disabledReason}</p>}</li>)}</ul></section>;
                  })()}</td>
                  <td>
                    <span className={`status-badge teams-presence teams-tone-${presenceTone(m.presence)}`}>
                      <span className="status-dot" aria-hidden="true" />
                      {presenceLabel(m.presence)}
                    </span>
                  </td>
                  <td>{workText(m.work)}</td>
                  <td className="teams-member-actions">
                    {memberId !== null && canEditMember(team, m) && (confirmRemove === memberId ? (
                      <>
                        <button
                          type="button"
                          aria-label={`Confirm remove ${name}`}
                          disabled={pending}
                          onClick={() => {
                            void writes.removeMember(team, memberId).then((ok) => { if (ok) setConfirmRemove(null); });
                          }}
                        >
                          Confirm remove
                        </button>
                        <button type="button" aria-label={`Cancel removing ${name}`} onClick={() => setConfirmRemove(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          aria-label={`Edit ${name}`}
                          disabled={pending}
                          onClick={() => setMemberForm({ mode: 'edit', memberId })}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${name}`}
                          disabled={pending}
                          onClick={() => setConfirmRemove(memberId)}
                        >
                          Remove
                        </button>
                      </>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {team.membersTruncated && <p className="panel-note">{`Showing the first ${team.members.length} members.`}</p>}
      {memberForm?.mode === 'add' && (
        <MemberForm
          mode="add"
          heading="Add member"
          initial={emptyMemberForm()}
          originalOptions={[]}
          inlineContext={null}
          agents={agents}
          roles={knownRoles(overview)}
          pending={pending}
          onSubmit={(values) => { void writes.addMember(team, values).then((ok) => { if (ok) setMemberForm(null); }); }}
          onCancel={() => setMemberForm(null)}
        />
      )}
      {editing !== null && memberForm?.mode === 'edit' && (
        <MemberForm
          key={memberForm.memberId}
          mode="edit"
          heading={`Edit ${memberName(editing)}`}
          initial={memberFormInitial(editing)}
          originalOptions={editing.agentOptions}
          inlineContext={editing.agentMode === 'inline' ? { provider: editing.provider, model: editing.model, reasoning: editing.reasoning } : null}
          agents={agents}
          roles={knownRoles(overview)}
          pending={pending}
          onSubmit={(values) => {
            const changes = memberChanges(memberFormInitial(editing), values);
            if (changes === null) return;
            void writes.updateMember(team, memberForm.memberId, changes).then((ok) => { if (ok) setMemberForm(null); });
          }}
          onCancel={() => setMemberForm(null)}
        />
      )}
    </section>
  );
}

function BoardControl(props: {
  team: OverviewTeam;
  section: DashboardSectionController<BoardSettings>;
  connected: boolean;
  action: BoardAction | null;
  pending: boolean;
  onRun(team: OverviewTeam): void;
  onStop(team: OverviewTeam): void;
}): JSX.Element {
  const { team, section, connected, action, pending, onRun, onStop } = props;
  const settings = section.state === 'ready' ? section.data : null;
  const view = settings === null ? null : boardControlView(team, settings.runner, connected);
  return (
    <section className="teams-board" aria-labelledby="teams-board-title">
      <h3 id="teams-board-title">Board control</h3>
      {section.state === 'loading' && <p className="panel-loading">Loading board state…</p>}
      {section.state === 'error' && <SectionError section={section} />}
      {view !== null && (
        <>
          <p className={`status-badge teams-board-status teams-tone-${view.tone}`}>
            <span className="status-dot" aria-hidden="true" />
            {view.status}
          </p>
          {view.detail !== null && <p className="panel-note">{view.detail}</p>}
          {view.runHint !== null && <p className="panel-note">{view.runHint}</p>}
          <div className="teams-board-actions">
            <button type="button" disabled={pending || !view.canRun} onClick={() => onRun(team)}>Run board</button>
            <button type="button" disabled={pending || !view.canStop} onClick={() => onStop(team)}>Stop board</button>
          </div>
        </>
      )}
      {action !== null && (
        <p className="panel-loading" role="status">{action === 'run' ? 'Starting board…' : 'Stopping board…'}</p>
      )}
    </section>
  );
}

