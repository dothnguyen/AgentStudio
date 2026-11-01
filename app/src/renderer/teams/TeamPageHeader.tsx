import { useEffect, useRef, useState, type JSX, type RefObject } from 'react';
import type { AttentionCommandRequest, AttentionRun, BlockedTicket, BoardSettings, OverviewTeam } from '../api';
import { Icon } from '../icons/Icon';
import { ActionMenu } from '../ui/ActionMenu';
import type { MenuItem } from '../ui/actionMenuModel';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { TeamStopDialog } from './TeamStopDialog';
import type { StopSequenceState } from './teamStopModel';
import { useCopyStatus } from '../ui/useCopyStatus';
import { TeamNameForm } from './TeamEditForms';
import { canEditTeam, type TeamActions, type TeamWrites } from './teamEditModel';
import { buildTeamMenu } from './teamActionsModel';
import { RUNTIME_LABELS, definitionMetaText, runtimeTone, shortRuntimeId, teamLabel } from './teamsModel';

export interface TeamPageHeaderProps {
  team: OverviewTeam | null;
  busy: boolean;
  refreshRef: RefObject<HTMLButtonElement | null>;
  onRefresh(): void;
  writes: Pick<TeamWrites, 'rename' | 'deleteTeam'>;
  teamActions: TeamActions;
  blockedTickets: readonly BlockedTicket[];
  blockedTicketsTruncated: boolean;
  boardStatuses: BoardSettings['statuses'] | null;
  connected: boolean;
  pending: boolean;
  readOnly: boolean;
  stopDialog?: {
    state: StopSequenceState;
    chooseSafe(): void;
    stopNow(): void;
    cancelWaiting(): void;
    confirmPaused(): void;
    cancel(): void;
  } | null;
}

type HeaderConfirm =
  | { kind: 'retry'; runs: AttentionRun[] }
  | { kind: 'reject'; request: AttentionCommandRequest }
  | { kind: 'cancel'; request: AttentionCommandRequest };

function svgProps(size: number): Record<string, string | number> {
  return { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' };
}

function runLine(run: AttentionRun): string {
  return `${run.ticketKey ?? run.workflowRunId} · ${run.stage === null ? 'unknown stage' : `stage ${run.stage}`} · ${run.diagnosticCode ?? run.status}`;
}

function commandLine(request: AttentionCommandRequest): string {
  return request.command;
}

export function TeamPageHeader(props: TeamPageHeaderProps): JSX.Element {
  const { team, writes, pending, teamActions } = props;
  const writeBlocked = pending || props.readOnly;
  const [teamForm, setTeamForm] = useState<'rename' | 'delete' | null>(null);
  const [confirm, setConfirm] = useState<HeaderConfirm | null>(null);
  const { status: copyStatus, copy } = useCopyStatus();
  const renameRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const confirmed = useRef(false);
  const wasPending = useRef(pending);
  const restoreFocus = useRef<'rename' | 'menu' | null>(null);
  const restoreMenuFocus = useRef(false);

  const cancelForm = (invoker: 'rename' | 'menu'): void => {
    restoreFocus.current = invoker;
    setTeamForm(null);
  };
  useEffect(() => {
    if (teamForm !== null || restoreFocus.current === null) return;
    (restoreFocus.current === 'rename' ? renameRef : menuButtonRef).current?.focus();
    restoreFocus.current = null;
  }, [teamForm]);
  // A failed delete leaves the confirmation open: return focus to the Confirm button that pending disabled.
  useEffect(() => {
    if (wasPending.current && !pending && confirmed.current && confirmRef.current?.isConnected) {
      confirmed.current = false;
      confirmRef.current.focus();
    }
    wasPending.current = pending;
  }, [pending]);
  // A confirmed menu action focuses the trigger once the write lock is released.
  useEffect(() => {
    if (confirm !== null || pending || !restoreMenuFocus.current) return;
    restoreMenuFocus.current = false;
    menuButtonRef.current?.focus();
  }, [confirm, pending]);

  function chooseDelete(): void {
    if (team === null || !canEditTeam(team)) return;
    setTeamForm('delete');
  }

  async function resetAllProviders(target: OverviewTeam, providers: string[]): Promise<void> {
    // One reset per provider with holds, one after another. A failure for one
    // provider must not stop the remaining providers from being reset/reported.
    for (const provider of providers) {
      await teamActions.resetUsage(target, provider);
    }
  }

  const globalReason = writeBlocked
    ? (pending ? 'Another change is in progress.' : 'Team data is not current.')
    : !props.connected ? 'The app is disconnected.' : null;

  const menuItems: MenuItem[] = team === null ? [] : buildTeamMenu({
    team,
    blockedTickets: props.blockedTickets,
    blockedTicketsTruncated: props.blockedTicketsTruncated,
    statuses: props.boardStatuses,
    disabledReason: globalReason,
    actions: {
      resetUsage: (provider) => { void teamActions.resetUsage(team, provider); },
      resetUsageAll: (providers) => { void resetAllProviders(team, providers); },
      unblockTicket: (key, to) => { void teamActions.unblockTicket(key, to); },
      retryPausedRuns: (runs) => setConfirm({ kind: 'retry', runs }),
      approveCommand: (id) => { void teamActions.approveCommand(id); },
      rejectCommand: (id) => {
        const request = team.attention.commandRequests.find((entry) => entry.id === id);
        if (request === undefined) { void teamActions.rejectCommand(id); return; }
        setConfirm({ kind: 'reject', request });
      },
      cancelCommand: (id) => {
        const request = team.attention.commandRequests.find((entry) => entry.id === id);
        if (request === undefined) { void teamActions.cancelCommand(id); return; }
        setConfirm({ kind: 'cancel', request });
      },
      // Route menu copies through the screen so the status is announced even
      // when the header's runtime meta row (and its local status) is absent.
      copy: (text, label) => teamActions.copy(text, label),
      attach: (kind) => { void teamActions.attachCommand(team, kind); },
      startTeam: () => { void teamActions.startTeam(team); },
      stopTeam: () => { void teamActions.stopTeam(team, 'stop'); },
      restartTeam: () => { void teamActions.restartTeam(team, 'restart'); },
      deleteTeam: chooseDelete,
    },
  });

  const runtimeId = team?.runtime.teamId ?? null;
  const definition = team === null ? null : definitionMetaText(team);
  const editable = team !== null && canEditTeam(team);
  const metaItems: JSX.Element[] = [];
  if (team !== null && definition !== null) {
    if (team.id !== null) {
      metaItems.push(
        <span key="id" className="teams-page-meta-item">
          <span className="teams-page-meta-label">Team id</span>
          <code className="teams-page-chip">{team.id}</code>
        </span>,
      );
    }
    if (runtimeId !== null) {
      metaItems.push(
        <span key="runtime" className="teams-page-meta-item">
          <span className="teams-page-meta-label">Runtime</span>
          <code className="teams-page-mono" title={runtimeId}>{shortRuntimeId(runtimeId)}</code>
          <button type="button" className="teams-page-copy" aria-label="Copy runtime id" onClick={() => copy(runtimeId, 'Runtime id')}>
            <svg {...svgProps(13)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V5a1 1 0 0 1 1-1h10" />
            </svg>
          </button>
          {copyStatus !== null && <span role="status" className="teams-page-copy-status">{copyStatus}</span>}
        </span>,
      );
    }
    metaItems.push(
      <span key="definition" className="teams-page-meta-item">
        {definition.tone === 'ok' ? (
          <svg {...svgProps(13)} className="teams-page-check" fill="none" stroke="#6fd38b" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l5 5L20 7" />
          </svg>
        ) : <Icon name="warning" size={13} className="teams-page-warning-icon" />}
        {definition.text}
      </span>,
    );
  }

  return (
    <header className="teams-page-header">
      <nav className="breadcrumb teams-page-breadcrumb" aria-label="Breadcrumb">
        <ol>
          <li>Workspace</li>
          {team === null ? <li aria-current="page">Teams</li> : (
            <>
              <li>Teams</li>
              <li aria-current="page">{teamLabel(team)}</li>
            </>
          )}
        </ol>
      </nav>
      <div className="teams-page-heading-row">
        <div className="teams-page-identity">
          <div className="teams-page-title-row">
            {team === null ? <h1>Teams</h1> : <h1 id="teams-detail-title" tabIndex={-1}>{teamLabel(team)}</h1>}
            {team !== null && (
              <span className={`teams-page-pill teams-page-pill-${runtimeTone(team.runtime.state)}`}>
                <span className="status-dot" aria-hidden="true" />
                {RUNTIME_LABELS[team.runtime.state] ?? team.runtime.state}
              </span>
            )}
          </div>
          {team !== null && (
            <div className="teams-page-meta">
              {metaItems.flatMap((item, i) => (i === 0 ? [item] : [<span key={`d${i}`} className="teams-page-meta-divider" aria-hidden="true" />, item]))}
            </div>
          )}
        </div>
        <div className="teams-page-actions">
          <button type="button" className="teams-page-icon-button" aria-label="Refresh" aria-busy={props.busy} ref={props.refreshRef} onClick={props.onRefresh}>
            <svg {...svgProps(15)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 11a8 8 0 1 0-2.3 5.7" />
              <path d="M20 4v7h-7" />
            </svg>
          </button>
          {team !== null && editable && (
            <button type="button" className="teams-page-button" aria-label="Rename team" ref={renameRef} disabled={writeBlocked} onClick={() => setTeamForm('rename')}>Rename</button>
          )}
          {team !== null && (
            <ActionMenu
              label="Team actions"
              trigger={{ icon: 'more', ariaLabel: 'More team actions' }}
              triggerClassName="teams-page-icon-button"
              triggerRef={menuButtonRef}
              items={menuItems}
              disabled={writeBlocked}
            />
          )}
        </div>
      </div>
      {team !== null && teamForm === 'rename' && (
        <TeamNameForm
          headingLevel={2}
          heading="Rename team"
          submitLabel="Save name"
          initialName={team.name ?? ''}
          pending={pending}
          readOnly={props.readOnly}
          onSubmit={(name) => { void writes.rename(team, name).then((ok) => { if (ok) setTeamForm(null); }); }}
          onCancel={() => cancelForm('rename')}
        />
      )}
      {team !== null && teamForm === 'delete' && (
        <div className="teams-confirm" role="group" aria-label="Confirm team deletion">
          <p>{`Delete team "${teamLabel(team)}"? Its definition file is removed.`}</p>
          <button
            type="button"
            ref={confirmRef}
            disabled={writeBlocked}
            onClick={() => { confirmed.current = true; void writes.deleteTeam(team).then((ok) => { if (ok) setTeamForm(null); }); }}
          >
            Confirm delete
          </button>
          <button type="button" onClick={() => cancelForm('menu')}>Cancel</button>
        </div>
      )}
      {confirm?.kind === 'retry' && (
        <ConfirmDialog
          title="Retry paused runs?"
          body={`Retry ${confirm.runs.length === 1 ? 'this paused run' : `these ${confirm.runs.length} paused runs`}? Each run is retried in order and reports through the Teams feedback line.`}
          details={confirm.runs.map(runLine)}
          confirmLabel="Retry runs"
          busy={pending}
          returnFocusRef={menuButtonRef}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { const runs = confirm.runs; restoreMenuFocus.current = true; setConfirm(null); void teamActions.retryPausedRuns(runs); }}
        />
      )}
      {confirm?.kind === 'reject' && (
        <ConfirmDialog
          title="Reject command?"
          body={`Reject "${commandLine(confirm.request)}"? The requesting member is told why.`}
          details={confirm.request.reason === null ? undefined : [confirm.request.reason]}
          confirmLabel="Reject command"
          danger
          reasonLabel="Reason (optional)"
          busy={pending}
          returnFocusRef={menuButtonRef}
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => { const request = confirm.request; restoreMenuFocus.current = true; setConfirm(null); void teamActions.rejectCommand(request.id, reason); }}
        />
      )}
      {confirm?.kind === 'cancel' && (
        <ConfirmDialog
          title="Cancel running command?"
          body={`Cancel "${commandLine(confirm.request)}"? The command stops and the run keeps going without its result.`}
          confirmLabel="Cancel command"
          danger
          reasonLabel="Reason (optional)"
          busy={pending}
          returnFocusRef={menuButtonRef}
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => { const request = confirm.request; restoreMenuFocus.current = true; setConfirm(null); void teamActions.cancelCommand(request.id, reason); }}
        />
      )}
      {props.stopDialog !== null && props.stopDialog !== undefined && (
        <TeamStopDialog
          teamName={props.stopDialog.state.teamName}
          state={props.stopDialog.state}
          returnFocusRef={menuButtonRef}
          onChooseSafe={props.stopDialog.chooseSafe}
          onStopNow={props.stopDialog.stopNow}
          onCancelWaiting={props.stopDialog.cancelWaiting}
          onConfirmPaused={props.stopDialog.confirmPaused}
          onCancel={props.stopDialog.cancel}
        />
      )}
    </header>
  );
}
