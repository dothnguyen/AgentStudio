import type { JSX } from 'react';
import type { ManagementApi, Result, RoleCatalogItem, RoleCatalogList } from '../api';
import { RoleInstructionsDialog, roleInstructionsValues } from './RoleInstructionsDialog';
import { useRoleEditSave } from './useRoleEditSave';

export interface RolePageInstructionsDialogProps {
  role: RoleCatalogItem;
  catalogSha: string | null;
  management: ManagementApi;
  workspaceId: string;
  reload(): Promise<Result<RoleCatalogList>>;
  onSaved(role: RoleCatalogItem): void;
  onCancel(): void;
  onPendingChange?(pending: boolean): void;
}

/**
 * The role page's Shared instructions dialog. It reuses the member page dialog
 * but edits only the prompt file, so description changes stay in Overview.
 */
export function RolePageInstructionsDialog(props: RolePageInstructionsDialogProps): JSX.Element {
  const save = useRoleEditSave({
    management: props.management,
    workspaceId: props.workspaceId,
    mode: 'edit',
    role: props.role,
    catalogSha: props.catalogSha,
    reload: props.reload,
    onPendingChange: props.onPendingChange,
  });
  return <RoleInstructionsDialog
    role={props.role}
    pending={save.pending}
    error={save.error}
    partialNotice={save.partialNotice}
    showDescription={false}
    countMode="bytes"
    promptLabel="Instructions"
    promptRows={16}
    className="roles-instructions-dialog"
    onSave={(_description, prompt) => save.save(roleInstructionsValues(props.role, props.role.description ?? '', prompt))}
    onReload={save.reloadCurrent}
    onClearError={save.clear}
    onSaved={props.onSaved}
    onCancel={props.onCancel}
  />;
}
