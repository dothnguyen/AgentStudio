import { useEffect, useId, useRef, type JSX } from 'react';
import type { BoardSettings, ManagementError, Problem } from '../../shared/management';
import { Dialog } from './Dialog';
import { worktreesChanges, type WorktreesDraft } from './routingWorktreesModel';

export interface RoutingWorktreesDialogProps {
  settings: BoardSettings;
  draft: WorktreesDraft;
  problems: Problem[];
  pending: boolean;
  saved: boolean;
  editable: boolean;
  connected: boolean;
  error: ManagementError | null;
  reloadError: ManagementError | null;
  alert?: boolean;
  onDraftChange(draft: WorktreesDraft): void;
  onSave(): void;
  onClose(): void;
  onReloadLatest(): void;
  onRetryLatest(): void;
}

function problemsAt(problems: Problem[], path: string): Problem[] {
  return problems.filter(problem => problem.path === path);
}

function ProblemText({ id, problems }: { id?: string; problems: Problem[] }): JSX.Element | null {
  if (problems.length === 0) return null;
  return <span id={id} className="routing-dialog-problem">{problems.map((problem, index) => <span key={`${index}-${problem.path}`}>{problem.path}: {problem.message}</span>)}</span>;
}

function Summary({ problems, alert = true }: { problems: Problem[]; alert?: boolean }): JSX.Element | null {
  if (problems.length === 0) return null;
  return <div role={alert ? 'alert' : undefined} className="routing-dialog-summary">
    {problems.map((problem, index) => <p key={`${index}-${problem.path}`}>{problem.path}: {problem.message}</p>)}
  </div>;
}

function Failure({ error, reloadError, pending, connected, alert = true, onReloadLatest, onRetryLatest }: {
  error: ManagementError | null;
  reloadError: ManagementError | null;
  pending: boolean;
  connected: boolean;
  alert?: boolean;
  onReloadLatest(): void;
  onRetryLatest(): void;
}): JSX.Element | null {
  const conflictRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (error?.code === 'CONFIG_CHANGED') conflictRef.current?.focus();
  }, [error]);
  if (error === null && reloadError === null) return null;
  return <div className="routing-dialog-failure" role={alert ? 'alert' : undefined}>
    {error !== null && <>
      <p><strong>{error.code}: {error.message}</strong></p>
      <p>{error.remediation || (error.code === 'CONFIG_CHANGED' ? 'Reload the latest settings before saving your changes.' : 'Review your changes and try saving again; if the problem persists, check the Agent Studio connection.')}</p>
    </>}
    {reloadError !== null && <p>Reload failed: {reloadError.code}: {reloadError.message}</p>}
    {reloadError !== null && <p>{reloadError.remediation || 'Retry loading the latest settings; if it keeps failing, check the Agent Studio connection.'}</p>}
    {error?.code === 'CONFIG_CHANGED' && <button ref={conflictRef} type="button" data-focus="conflict" disabled={pending || !connected} onClick={onReloadLatest}>Reload latest</button>}
    {reloadError !== null && <button type="button" data-focus="reload-retry" disabled={pending || !connected} onClick={onRetryLatest}>Retry latest settings</button>}
  </div>;
}

/** Edits the base branch that isolated worktrees start from. */
export function RoutingWorktreesDialog(props: RoutingWorktreesDialogProps): JSX.Element {
  const { settings, draft, problems, pending, saved, editable, connected, error, reloadError, alert = true } = props;
  const uid = useId();
  const id = `${uid}-base-branch`;
  const hintId = `${uid}-base-hint`;
  const errorId = `${uid}-base-error`;
  const branchProblems = problemsAt(problems, 'baseBranch');
  const summary = problems.filter(problem => problem.path !== 'baseBranch');
  const conflict = error?.code === 'CONFIG_CHANGED';
  const changes = worktreesChanges(draft, settings);
  const canSave = editable && !pending && !saved && !conflict && problems.length === 0 && changes !== null;
  const disabled = !editable || pending || saved;
  return <Dialog
    title="Edit worktrees"
    width={480}
    busy={pending || saved}
    onClose={props.onClose}
    footerNote="Applies to every team using this board"
    actions={[
      { label: 'Cancel', onClick: props.onClose },
      { label: 'Save', variant: 'primary', disabled: !canSave, onClick: props.onSave },
    ]}
    className="routing-dialog routing-worktrees-dialog"
  >
    <Failure error={error} reloadError={reloadError} pending={pending} connected={connected} alert={alert} onReloadLatest={props.onReloadLatest} onRetryLatest={props.onRetryLatest} />
    <Summary problems={summary} alert={alert && error === null && reloadError === null} />
    <div className="routing-dialog-field">
      <label className="routing-dialog-label" htmlFor={id}>Base branch</label>
      <input
        id={id}
        type="text"
        value={draft.baseBranch}
        required
        aria-required="true"
        disabled={disabled}
        aria-invalid={branchProblems.length > 0 ? 'true' : undefined}
        aria-describedby={branchProblems.length > 0 ? `${hintId} ${errorId}` : hintId}
        className="routing-dialog-mono"
        onChange={event => props.onDraftChange({ ...draft, baseBranch: event.target.value })}
      />
      <span id={hintId} className="routing-dialog-hint">Isolated worktrees branch from here, and finished work is merged back into it.</span>
      <ProblemText id={errorId} problems={branchProblems} />
    </div>
  </Dialog>;
}
