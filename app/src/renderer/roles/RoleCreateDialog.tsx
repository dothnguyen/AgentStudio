import { useEffect, useId, useRef, useState, type JSX } from 'react';
import type { ManagementApi, Result, RoleCatalogItem, RoleCatalogList } from '../api';
import { Dialog } from '../teams/Dialog';
import { RoleDialogFeedback } from './RoleDialogFeedback';
import { suggestRoleId, validateRoleForm, type RoleFormValues } from './roleEditModel';
import { useRoleEditSave } from './useRoleEditSave';

export interface RoleCreateDialogProps {
  catalog: RoleCatalogList;
  catalogSha: string | null;
  management: ManagementApi;
  workspaceId: string;
  reload(): Promise<Result<RoleCatalogList>>;
  onCreated(role: RoleCatalogItem): void;
  onCancel(): void;
  onPendingChange?(pending: boolean): void;
}

/**
 * The New role dialog. The role id follows the name until it is edited, and
 * only roles.json metadata is created here: instructions and skills are added
 * from the new role page, so this dialog deliberately sends neither.
 */
export function RoleCreateDialog(props: RoleCreateDialogProps): JSX.Element {
  const uid = useId();
  const nameId = `${uid}-name`;
  const idId = `${uid}-id`;
  const descriptionId = `${uid}-description`;
  const nameErrorId = `${uid}-name-error`;
  const idErrorId = `${uid}-id-error`;
  const descriptionErrorId = `${uid}-description-error`;
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [description, setDescription] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [touched, setTouched] = useState({ name: false, description: false });
  const [catalogNow, setCatalogNow] = useState(props.catalog);
  const [created, setCreated] = useState(false);
  const [reloadFailure, setReloadFailure] = useState<string | null>(null);
  const [reloaded, setReloaded] = useState(false);
  const save = useRoleEditSave({
    management: props.management,
    workspaceId: props.workspaceId,
    mode: 'create',
    role: null,
    catalogSha: props.catalogSha,
    reload: props.reload,
    onPendingChange: props.onPendingChange,
  });

  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => { setCatalogNow(props.catalog); }, [props.catalog]);

  const values: RoleFormValues = { id, name, description, instructions: '', skills: [] };
  // Once the role exists but verification failed, a retry edits the created
  // role (the shared save sequence has already promoted it), so validate as an
  // edit: the locked id must not be reported as a duplicate of itself.
  const errors = validateRoleForm(values, created ? 'edit' : 'create', catalogNow);
  const saveDisabled = save.pending
    || name.trim() === ''
    || id.trim() === ''
    || errors.name !== undefined
    || errors.id !== undefined
    || errors.description !== undefined;
  const showNameError = touched.name ? errors.name : undefined;
  const showIdError = !created && (idTouched || name.trim() !== '') ? errors.id : undefined;
  const showDescriptionError = touched.description ? errors.description : undefined;

  const submit = async (): Promise<void> => {
    if (saveDisabled) return;
    const outcome = await save.save(values);
    if (outcome.status === 'saved') props.onCreated(outcome.role);
    else if (outcome.status === 'failed' && outcome.session.mode === 'edit') setCreated(true);
  };

  const reload = async (): Promise<void> => {
    setReloadFailure(null);
    setReloaded(false);
    const result = await save.reloadCurrent();
    if (result.ok) {
      setCatalogNow(result.data);
      save.clear();
      setReloaded(true);
    } else {
      setReloadFailure(`Reload failed: ${result.error.code}: ${result.error.message}`);
    }
  };

  const path = `roles/${id || '<id>'}.md`;
  return <Dialog
    title="New role"
    width={560}
    busy={save.pending}
    onClose={props.onCancel}
    footerNote="Add the instructions after creating it"
    initialFocus={nameRef}
    className="role-create-dialog"
    actions={[
      { label: 'Cancel', onClick: props.onCancel },
      { label: save.pending ? 'Creating…' : created ? 'Retry' : 'Create role', variant: 'primary', disabled: saveDisabled, onClick: () => { void submit(); } },
    ]}
  >
    <div className="role-dialog-field">
      <label htmlFor={nameId}>Name</label>
      <input
        id={nameId}
        ref={nameRef}
        value={name}
        placeholder="For example Architect"
        disabled={save.pending}
        aria-invalid={showNameError ? true : undefined}
        aria-describedby={showNameError ? nameErrorId : undefined}
        onChange={event => {
          const next = event.target.value;
          setName(next);
          setTouched(current => ({ ...current, name: true }));
          if (!idTouched) setId(suggestRoleId(next));
          setReloaded(false);
          save.clearError();
        }}
      />
      {showNameError && <p id={nameErrorId} className="role-dialog-field-error">{showNameError}</p>}
    </div>
    <div className="role-dialog-field">
      <label htmlFor={idId}>Role id</label>
      <input
        id={idId}
        value={id}
        spellCheck={false}
        disabled={save.pending || created}
        aria-invalid={showIdError ? true : undefined}
        aria-describedby={showIdError ? `${idErrorId} ${uid}-id-hint` : `${uid}-id-hint`}
        onChange={event => {
          setIdTouched(true);
          setId(event.target.value);
          setReloaded(false);
          save.clearError();
        }}
      />
      <p className="role-dialog-hint" id={`${uid}-id-hint`}>
        Letters, numbers and dashes. It cannot be changed later. The instructions file will be <code>{path}</code>.
      </p>
      {showIdError && <p id={idErrorId} className="role-dialog-field-error">{showIdError}</p>}
    </div>
    <div className="role-dialog-field">
      <label htmlFor={descriptionId}>Description <span className="role-dialog-optional">(optional)</span></label>
      <textarea
        id={descriptionId}
        rows={3}
        value={description}
        disabled={save.pending}
        aria-invalid={showDescriptionError ? true : undefined}
        aria-describedby={showDescriptionError ? descriptionErrorId : undefined}
        onChange={event => {
          setDescription(event.target.value);
          setTouched(current => ({ ...current, description: true }));
          setReloaded(false);
          save.clearError();
        }}
      />
      {showDescriptionError && <p id={descriptionErrorId} className="role-dialog-field-error">{showDescriptionError}</p>}
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
