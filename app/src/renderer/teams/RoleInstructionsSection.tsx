import { useRef, useState, type JSX } from 'react';
import type { ManagementApi, OverviewMember, Result, RoleCatalogItem, RoleCatalogList } from '../api';
import { Icon } from '../icons/Icon';
import { useRoleSave } from '../roles/useRoleSave';
import { INSTRUCTION_MESSAGES } from '../roles/rolesModel';
import { findCatalogRole } from './teamEditModel';
import { roleNote } from './teamsModel';
import { SectionCard } from './SectionCard';
import { promptCountText, RoleInstructionsDialog, roleInstructionsValues } from '../roles/RoleInstructionsDialog';

export interface RoleInstructionsSectionProps {
  workspaceId: string;
  management: ManagementApi;
  member: OverviewMember;
  roles: readonly RoleCatalogItem[] | null;
  catalogSha: string | null;
  roleCatalogMessage: string | null;
  pending: boolean;
  readOnly: boolean;
  reloadRoles(): Promise<Result<RoleCatalogList>>;
  onViewRole?(roleId: string): void;
}

/**
 * Read-only Role instructions card on a member page. Everything it shows is
 * derived from the current member role and catalog item, so changing the
 * member's role replaces the description and prompt without keeping old text.
 */
export function RoleInstructionsSection(props: RoleInstructionsSectionProps): JSX.Element {
  const { member, roles } = props;
  const catalogRole = roles === null ? null : findCatalogRole(roles, member.role);
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const editRef = useRef<HTMLButtonElement>(null);
  const save = useRoleSave({ management: props.management, workspaceId: props.workspaceId, reload: props.reloadRoles });

  const roleLabel = catalogRole?.name ?? (member.role !== null && member.role.trim() !== '' ? member.role : null);
  const subtitle = roleLabel === null
    ? "Description and prompt for this member's role, shared by every member with this role."
    : `Description and prompt for the ${roleLabel} role, shared by every member with this role.`;
  const description = catalogRole
    ? (catalogRole.description?.trim() ? catalogRole.description : 'No description')
    : (member.roleDescription?.trim() ? member.roleDescription : 'No description');
  const readable = catalogRole !== null
    && (catalogRole.instructions.state === 'ok' || catalogRole.instructions.state === 'truncated')
    && catalogRole.instructions.text !== null;
  const promptText = readable && catalogRole !== null ? catalogRole.instructions.text ?? '' : '';
  const explanation = catalogRole === null
    ? (roles === null
      ? props.roleCatalogMessage ?? 'The role catalog is unavailable. Retry loading it to see role instructions.'
      : roleNote(member) ?? 'Role not defined in roles.json')
    : INSTRUCTION_MESSAGES[catalogRole.instructions.state] ?? 'Shared instructions are unavailable.';
  const instructionPath = catalogRole?.instructions.path ?? null;
  const canEdit = catalogRole !== null;
  const editDisabled = props.pending || props.readOnly || save.pending;
  const action = canEdit
    ? {
      label: 'Edit',
      ariaLabel: 'Edit role instructions',
      disabled: editDisabled,
      buttonRef: editRef,
      onClick: () => { setAnnouncement(''); save.clear(); setOpen(true); },
    }
    : undefined;
  const openSave = async (nextDescription: string, prompt: string) => {
    if (catalogRole === null) {
      return { status: 'failed' as const, error: { code: 'INTERNAL', message: 'The role catalog is unavailable.', retryable: false }, partialNotice: null, metadataSaved: false, session: { mode: 'edit' as const, base: null, catalogSha: null, metadataSaved: false } };
    }
    return save.save(
      { mode: 'edit', base: catalogRole, catalogSha: props.catalogSha, metadataSaved: false },
      roleInstructionsValues(catalogRole, nextDescription, prompt),
    );
  };

  return <>
    <SectionCard
      title="Role instructions"
      subtitle={subtitle}
      className="role-instructions-card"
      action={action}
    >
      <div className="role-instructions-description">
        <span className="role-instructions-label">Description</span>
        <p>{description}</p>
      </div>
      <div className="role-instructions-prompt">
        <div className="role-instructions-prompt-head">
          <span className="role-instructions-label">Prompt</span>
          {readable && <span className="role-instructions-count">{promptCountText(promptText)}</span>}
        </div>
        {readable
          ? <div className="role-instructions-preview">
            <pre>{promptText}</pre>
            <div className="role-instructions-fade" aria-hidden="true" />
          </div>
          : <p className="role-instructions-empty">{explanation}</p>}
        {readable && catalogRole?.instructions.state === 'truncated' && <p className="role-instructions-empty">Instruction content is truncated.</p>}
      </div>
      {instructionPath !== null && <p className="role-instructions-footer"><Icon name="document" size={13} /><span>Saved to <code>{instructionPath}</code></span></p>}
      {(catalogRole !== null && props.onViewRole !== undefined) && <div className="role-instructions-links">
        <button type="button" className="role-instructions-role-link" onClick={() => props.onViewRole?.(catalogRole.id)}>{`View ${catalogRole.name} in Roles`}</button>
      </div>}
      {catalogRole !== null && catalogRole.warnings.length > 0 && <ul className="role-instructions-warnings" aria-label="Role warnings">{catalogRole.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>}
    </SectionCard>
    {announcement !== '' && <p className="role-instructions-announcement" role="status">{announcement}</p>}
    {open && catalogRole !== null && <RoleInstructionsDialog
      key={catalogRole.id}
      role={catalogRole}
      pending={save.pending || props.pending}
      error={save.error}
      partialNotice={save.partialNotice}
      readOnly={props.readOnly}
      onSave={openSave}
      onReload={props.reloadRoles}
      onClearError={save.clear}
      onSaved={saved => {
        setOpen(false);
        save.clear();
        setAnnouncement(`Saved role ${saved.name}. Saved changes apply to new assignments; current assignments are unchanged.`);
      }}
      onCancel={() => { setOpen(false); save.clear(); }}
    />}
  </>;
}
