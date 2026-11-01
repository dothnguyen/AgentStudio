import { useId, type JSX } from 'react';
import type { ManagementError, Problem } from '../../shared/management';
import { Dialog } from './Dialog';
import { RoutingDialogSummary, RoutingDialogFailure } from './RoutingDialogParts';

export interface RoutingRemoveRuleDialogProps {
  statusName: string;
  problems: Problem[];
  pending: boolean;
  saved: boolean;
  editable: boolean;
  connected: boolean;
  error: ManagementError | null;
  reloadError: ManagementError | null;
  alert?: boolean;
  onConfirm(): void;
  onClose(): void;
  onReloadLatest(): void;
  onRetryLatest(): void;
}

/** Confirmation for removing a rule; a removal that would break routing stays in the dialog with its problems. */
export function RoutingRemoveRuleDialog(props: RoutingRemoveRuleDialogProps): JSX.Element {
  const { statusName, problems, pending, saved, editable, connected, error, reloadError, alert = true } = props;
  const uid = useId();
  const describedBy = `${uid}-copy`;
  return <Dialog
    title={`Remove the rule for ${statusName}?`}
    width={480}
    busy={pending || saved}
    showClose={false}
    role="alertdialog"
    describedBy={describedBy}
    onClose={props.onClose}
    actions={[
      { label: 'Cancel', onClick: props.onClose },
      { label: 'Remove rule', variant: 'danger', disabled: pending || saved || !editable || error?.code === 'CONFIG_CHANGED', onClick: props.onConfirm },
    ]}
    className="roles-delete-dialog routing-dialog routing-remove-rule-dialog"
  >
    <RoutingDialogFailure error={error} reloadError={reloadError} pending={pending} connected={connected} alert={alert} onReloadLatest={props.onReloadLatest} onRetryLatest={props.onRetryLatest} />
    <RoutingDialogSummary problems={problems} alert={alert && error === null && reloadError === null} />
    <p id={describedBy} className="roles-delete-copy">Tickets in this status will no longer be worked automatically. You can still move them by hand. This applies to every team using this board.</p>
  </Dialog>;
}
