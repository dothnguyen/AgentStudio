import { useEffect, useId, useRef, useState, type JSX } from 'react';
import type { ManagementApi, Result, RoleCatalogItem, RoleCatalogList } from '../api';
import { Icon } from '../icons/Icon';
import { Dialog } from '../teams/Dialog';
import { RoleDialogFeedback } from './RoleDialogFeedback';
import { MAX_DESCRIPTION, validateRoleForm, type RoleFormValues } from './roleEditModel';
import { useRoleEditSave } from './useRoleEditSave';

export interface RoleOverviewDialogProps {
  role: RoleCatalogItem;
  catalog: RoleCatalogList;
  catalogSha: string | null;
  management: ManagementApi;
  workspaceId: string;
  reload(): Promise<Result<RoleCatalogList>>;
  onSaved(role: RoleCatalogItem): void;
  onCancel(): void;
  onPendingChange?(pending: boolean): void;
}

/** The role page Overview card dialog: name and description only. */
export function RoleOverviewDialog(props: RoleOverviewDialogProps): JSX.Element {
  const { role } = props;
  const uid = useId();
  const nameId = `${uid}-name`;
  const nameErrorId = `${uid}-name-error`;
  const descriptionId = `${uid}-description`;
  const descriptionErrorId = `${uid}-description-error`;
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(role.name ?? '');
  const [description, setDescription] = useState(role.description ?? '');
  const [touched, setTouched] = useState({ name: false, description: false });
  const [reloadFailure, setReloadFailure] = useState<string | null>(null);
  const [reloaded, setReloaded] = useState(false);
  const save = useRoleEditSave({
    management: props.management,
    workspaceId: props.workspaceId,
    mode: 'edit',
    role,
    catalogSha: props.catalogSha,
    reload: props.reload,
    onPendingChange: props.onPendingChange,
  });

  useEffect(() => { nameRef.current?.focus(); }, []);

  const values: RoleFormValues = {
    id: role.id,
    name,
    description,
    instructions: role.instructions.text ?? '',
    skills: role.skills.map(skill => skill.id),
  };
  const errors = validateRoleForm(values, 'edit', props.catalog);
  const dirty = name.trim() !== (role.name ?? '').trim()
    || description.trim() !== (role.description ?? '').trim();
  const saveDisabled = save.pending || !dirty || errors.name !== undefined || errors.description !== undefined;
  const showNameError = touched.name ? errors.name : undefined;
  const showDescriptionError = touched.description ? errors.description : undefined;

  const change = (patch: { name?: string; description?: string }) => {
    if (patch.name !== undefined) {
      setName(patch.name);
      setTouched(current => ({ ...current, name: true }));
    }
    if (patch.description !== undefined) {
      setDescription(patch.description);
      setTouched(current => ({ ...current, description: true }));
    }
    setReloaded(false);
    save.clearError();
  };

  const submit = async (): Promise<void> => {
    if (saveDisabled) return;
    const outcome = await save.save(values);
    if (outcome.status === 'saved') props.onSaved(outcome.role);
  };

  const reload = async (): Promise<void> => {
    setReloadFailure(null);
    setReloaded(false);
    const result = await save.reloadCurrent();
    if (result.ok) {
      save.clear();
      setReloaded(true);
    } else {
      setReloadFailure(`Reload failed: ${result.error.code}: ${result.error.message}`);
    }
  };

  return <Dialog
    title="Edit overview"
    width={560}
    busy={save.pending}
    onClose={props.onCancel}
    footerNote="Saved to roles.json"
    initialFocus={nameRef}
    className="role-overview-dialog"
    actions={[
      { label: 'Cancel', onClick: props.onCancel },
      { label: save.pending ? 'Saving…' : 'Save', variant: 'primary', disabled: saveDisabled, onClick: () => { void submit(); } },
    ]}
  >
    <div className="role-dialog-field">
      <label htmlFor={nameId}>Name</label>
      <input
        id={nameId}
        ref={nameRef}
        value={name}
        disabled={save.pending}
        aria-invalid={showNameError ? true : undefined}
        aria-describedby={showNameError ? nameErrorId : undefined}
        onChange={event => change({ name: event.target.value })}
      />
      {showNameError && <p id={nameErrorId} className="role-dialog-field-error">{showNameError}</p>}
    </div>
    <div className="role-dialog-field">
      <span className="role-dialog-label" id={`${uid}-id-label`}>Role id</span>
      <div className="role-dialog-locked-id" aria-labelledby={`${uid}-id-label`}>
        <Icon name="lock" size={13} />
        <code>{role.id}</code>
      </div>
      <p className="role-dialog-hint">Members refer to the role by this id, so it cannot change.</p>
    </div>
    <div className="role-dialog-field">
      <label htmlFor={descriptionId}>Description</label>
      <textarea
        id={descriptionId}
        rows={4}
        value={description}
        disabled={save.pending}
        aria-invalid={showDescriptionError ? true : undefined}
        aria-describedby={showDescriptionError ? descriptionErrorId : undefined}
        onChange={event => change({ description: event.target.value })}
      />
      {showDescriptionError && <p id={descriptionErrorId} className="role-dialog-field-error">{showDescriptionError}</p>}
      {!showDescriptionError && description.trim().length > MAX_DESCRIPTION * 0.9 && <p className="role-dialog-hint">{`${description.trim().length} / ${MAX_DESCRIPTION} characters`}</p>}
    </div>
    <RoleDialogFeedback
      error={save.error}
      partialNotice={save.partialNotice}
      reloadFailure={reloadFailure}
      reloaded={reloaded}
      pending={save.pending}
      onReload={() => { void reload(); }}
    />
  </Dialog>;
}
