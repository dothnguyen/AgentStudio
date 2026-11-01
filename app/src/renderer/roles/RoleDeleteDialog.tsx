import { useId, type JSX } from 'react';
import type { RoleCatalogItem } from '../api';
import { Dialog } from '../teams/Dialog';
import { instructionDeleteDescription } from './rolesModel';

export interface RoleDeleteDialogProps {
  role: Pick<RoleCatalogItem, 'id' | 'name' | 'instructions'>;
  pending: boolean;
  blockedReason: string | null;
  shared?: boolean;
  onCancel(): void;
  onConfirm(): void;
}
export function RoleDeleteDialog({ role, pending, blockedReason, shared = false, onCancel, onConfirm }: RoleDeleteDialogProps): JSX.Element {
  const blockedId = useId();
  const bodyId = useId();
  const name = role.name?.trim() || role.id;
  return <Dialog
    title={`Delete ${name}?`}
    width={480}
    busy={pending}
    showClose={false}
    role="alertdialog"
    describedBy={bodyId}
    className="roles-delete-dialog"
    onClose={onCancel}
    actions={[
      { label: 'Cancel', onClick: onCancel },
      {
        label: 'Delete role',
        variant: 'danger',
        disabled: pending || !!blockedReason,
        busy: pending,
        descriptionId: blockedReason ? blockedId : undefined,
        onClick: onConfirm,
      },
    ]}
  >
    <p id={bodyId} className="roles-delete-copy">{instructionDeleteDescription(role, shared)} No member uses this role.</p>
    {blockedReason && <p id={blockedId} className="roles-delete-copy" role="status">{blockedReason}</p>}
  </Dialog>;
}
