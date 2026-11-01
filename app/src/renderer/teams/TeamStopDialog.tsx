import { useEffect, useId, useRef, type JSX, type KeyboardEvent, type RefObject } from 'react';
import { pausedConfirmationText, type StopMode, type StopSequenceState } from './teamStopModel';

export interface TeamStopDialogProps {
  teamName: string;
  state: StopSequenceState;
  onChooseSafe(): void;
  onStopNow(): void;
  onCancelWaiting(): void;
  onConfirmPaused(): void;
  onCancel(): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

function workLine(run: StopSequenceState['plan']['working'][number]): string {
  return `${run.memberName} · ${run.ticketKey ?? 'no ticket'} · ${run.stage ?? 'unknown stage'} · ${run.status}`;
}

function pausedLine(run: StopSequenceState['plan']['paused'][number]): string {
  return `${run.memberName} · ${run.ticketKey ?? 'no ticket'} · ${run.stage ?? 'unknown stage'} · ${run.diagnosticCode ?? 'paused'}`;
}

function commandLine(run: StopSequenceState['plan']['commands'][number]): string {
  return `${run.command} · ${run.memberName}`;
}

export function TeamStopDialog(props: TeamStopDialogProps): JSX.Element {
  const { teamName, state } = props;
  const mode: StopMode = state.mode;
  const noun = mode === 'restart' ? 'Restart' : 'Stop';
  const verb = mode === 'restart' ? 'restart' : 'stop';
  const reactId = useId().replace(/:/g, '');
  const titleId = `team-stop-${reactId}-title`;
  const bodyId = `team-stop-${reactId}-body`;
  const workingId = `team-stop-${reactId}-working`;
  const pausedId = `team-stop-${reactId}-paused`;
  const commandsId = `team-stop-${reactId}-commands`;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const waitCancelRef = useRef<HTMLButtonElement | null>(null);
  const pausedCancelRef = useRef<HTMLButtonElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const target = props.returnFocusRef?.current ?? previousFocus.current;
      if (target !== null && target.isConnected && !(target as HTMLButtonElement).disabled) target.focus();
    };
    // Focus return is intentionally only on mount/unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state.phase === 'confirm') cancelRef.current?.focus();
    else if (state.phase === 'waiting') waitCancelRef.current?.focus();
    else if (state.phase === 'confirm-paused') pausedCancelRef.current?.focus();
  }, [state.phase]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (state.phase === 'waiting') props.onCancelWaiting();
      else if (state.phase === 'confirm' || state.phase === 'confirm-paused') props.onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const plan = state.plan;
  const lists: JSX.Element[] = [];
  if (plan.working.length > 0) {
    lists.push(
      <div key="working">
        <p className="team-stop-list-title">Running work</p>
        <ul id={workingId} className="ui-confirm-details" aria-label="Running work">
          {plan.working.map((run, index) => <li key={`w-${index}-${run.ticketKey ?? ''}`}>{workLine(run)}</li>)}
        </ul>
      </div>,
    );
  }
  if (plan.paused.length > 0) {
    lists.push(
      <div key="paused">
        <p className="team-stop-list-title">Paused runs (these are cancelled and their tickets become blocked)</p>
        <ul id={pausedId} className="ui-confirm-details" aria-label="Paused runs">
          {plan.paused.map((run, index) => <li key={`p-${index}-${run.ticketKey ?? ''}`}>{pausedLine(run)}</li>)}
        </ul>
      </div>,
    );
  }
  if (plan.commands.length > 0) {
    lists.push(
      <div key="commands">
        <p className="team-stop-list-title">Pending command requests</p>
        <ul id={commandsId} className="ui-confirm-details" aria-label="Pending command requests">
          {plan.commands.map((run, index) => <li key={`c-${index}-${run.command}`}>{commandLine(run)}</li>)}
        </ul>
      </div>,
    );
  }

  const describedBy = [
    bodyId,
    plan.working.length > 0 ? workingId : null,
    plan.paused.length > 0 ? pausedId : null,
    plan.commands.length > 0 ? commandsId : null,
  ].filter((id): id is string => id !== null).join(' ');

  if (state.phase === 'confirm') {
    const idle = plan.idle;
    return (
      <div className="modal-overlay teams-live-modal" onKeyDown={onKeyDown}>
        <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={describedBy} className="ui-confirm team-stop-dialog" ref={dialogRef}>
          <h2 id={titleId}>{noun} {teamName}?</h2>
          {idle ? (
            <p id={bodyId}>No member has running work.</p>
          ) : (
            <>
              <p id={bodyId}>Stopping while members work cancels their runs; every affected ticket becomes blocked until someone unblocks it.</p>
              {lists}
            </>
          )}
          <div className="ui-confirm-actions">
            {idle ? (
              <>
                <button type="button" ref={cancelRef} onClick={props.onCancel}>Cancel</button>
                {/* An idle restart still stops a running board, so the old runtime is not left bound to it. */}
                <button type="button" className="ui-confirm-confirm" onClick={mode === 'restart' ? props.onChooseSafe : props.onStopNow}>{noun} team</button>
              </>
            ) : (
              <>
                {plan.working.length > 0 && (
                  <button type="button" className="ui-confirm-confirm" onClick={props.onChooseSafe}>
                    Stop the board and wait for running work to finish, then {verb} the team
                  </button>
                )}
                <button type="button" className="ui-confirm-confirm-danger team-stop-now" onClick={props.onStopNow}>
                  {noun} now (cancel running work)
                </button>
                <button type="button" ref={cancelRef} onClick={props.onCancel}>Cancel</button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (state.phase === 'waiting') {
    return (
      <div className="modal-overlay teams-live-modal" onKeyDown={onKeyDown}>
        <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} className="ui-confirm team-stop-dialog" ref={dialogRef}>
          <h2 id={titleId}>{mode === 'restart' ? 'Restarting' : 'Stopping'} {teamName}…</h2>
          <p id={bodyId}>
            {state.boardStopped ? 'The board is stopped.' : 'The board is not running for this team.'}{' '}
            The team will {verb} when its running work finishes.
          </p>
          <p className="team-stop-status" role="status" aria-live="polite">{state.statusText}</p>
          <div className="ui-confirm-actions">
            <button type="button" ref={waitCancelRef} onClick={props.onCancelWaiting}>Cancel waiting</button>
          </div>
        </div>
      </div>
    );
  }

  if (state.phase === 'confirm-paused') {
    return (
      <div className="modal-overlay teams-live-modal" onKeyDown={onKeyDown}>
        <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} className="ui-confirm team-stop-dialog" ref={dialogRef}>
          <h2 id={titleId}>{noun} {teamName}?</h2>
          <p id={bodyId}>{pausedConfirmationText(plan)}</p>
          <div className="ui-confirm-actions">
            <button type="button" className="ui-confirm-confirm" onClick={props.onConfirmPaused}>{noun} team</button>
            <button type="button" ref={pausedCancelRef} onClick={props.onCancel}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  const busyText = state.phase === 'stopping-board' ? 'Stopping the board…'
    : state.phase === 'stopping-team' ? 'Stopping the team…'
    : 'Starting the team…';
  return (
    <div className="modal-overlay teams-live-modal" onKeyDown={onKeyDown}>
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} className="ui-confirm team-stop-dialog" ref={dialogRef}>
        <h2 id={titleId}>{mode === 'restart' ? 'Restarting' : 'Stopping'} {teamName}…</h2>
        <p id={bodyId} className="team-stop-status" role="status" aria-live="polite">{busyText}</p>
      </div>
    </div>
  );
}
