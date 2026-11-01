import { useId, type JSX } from 'react';
import type { BoardSettings, ManagementError, Problem } from '../../shared/management';
import { Dialog } from './Dialog';
import { boardSettingsChanges, type RoutingDraft } from './routingSettingsModel';
import {
  problemsAt,
  RoutingDialogFailure,
  RoutingDialogProblemText,
  RoutingDialogSummary,
} from './RoutingDialogParts';

export interface RoutingWorktreesDialogProps {
  settings: BoardSettings;
  draft: RoutingDraft;
  problems: Problem[];
  pending: boolean;
  saved: boolean;
  editable: boolean;
  connected: boolean;
  error: ManagementError | null;
  reloadError: ManagementError | null;
  alert?: boolean;
  onDraftChange(draft: RoutingDraft): void;
  onSave(): void;
  onClose(): void;
  onReloadLatest(): void;
  onRetryLatest(): void;
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
  const changes = boardSettingsChanges(draft, settings);
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
    <RoutingDialogFailure error={error} reloadError={reloadError} pending={pending} connected={connected} alert={alert} onReloadLatest={props.onReloadLatest} onRetryLatest={props.onRetryLatest} />
    <RoutingDialogSummary problems={summary} alert={alert && error === null && reloadError === null} />
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
      <RoutingDialogProblemText id={errorId} problems={branchProblems} />
    </div>
  </Dialog>;
}
