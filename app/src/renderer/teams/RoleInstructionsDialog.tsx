import { useEffect, useId, useRef, useState, type JSX } from 'react';
import type { ManagementError, Result, RoleCatalogItem, RoleCatalogList } from '../api';
import { Icon } from '../icons/Icon';
import { CONFLICT_MESSAGE } from '../roles/RoleForm';
import { instructionBytes, MAX_DESCRIPTION, MAX_INSTRUCTION_BYTES, type RoleFormValues } from '../roles/roleEditModel';
import type { RoleSaveOutcome } from '../roles/roleSave';
import { Dialog } from './Dialog';

export interface RoleInstructionsDialogProps {
  role: RoleCatalogItem;
  pending: boolean;
  error: ManagementError | null;
  partialNotice: string | null;
  readOnly?: boolean;
  onSave(description: string, prompt: string): Promise<RoleSaveOutcome>;
  onReload(): Promise<Result<RoleCatalogList>>;
  onClearError(): void;
  onSaved(role: RoleCatalogItem): void;
  onCancel(): void;
}

const unreadable = (role: RoleCatalogItem): boolean => role.instructions.state === 'invalid' || role.instructions.state === 'truncated';
export function promptLines(text: string): number { return text === '' ? 0 : text.split('\n').length; }
export function promptCharacters(text: string): number { return Array.from(text).length; }
export function promptCountText(text: string): string {
  return `${promptLines(text)} lines · ${promptCharacters(text)} characters`;
}

/** Dialog that edits a role's description and shared prompt file from a member page. */
export function RoleInstructionsDialog(props: RoleInstructionsDialogProps): JSX.Element {
  const { role } = props;
  const uid = useId();
  const [description, setDescription] = useState(() => role.description ?? '');
  const [prompt, setPrompt] = useState(() => role.instructions.text ?? '');
  const [reloadFailure, setReloadFailure] = useState<string | null>(null);
  const [reloaded, setReloaded] = useState(false);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const blocked = unreadable(role);
  const bytes = instructionBytes(prompt);
  const overLimit = bytes > MAX_INSTRUCTION_BYTES;
  const descriptionTooLong = description.trim().length > MAX_DESCRIPTION;
  const dirty = description.trim() !== (role.description ?? '').trim() || prompt !== (role.instructions.text ?? '');
  const saveDisabled = props.pending || props.readOnly === true || blocked || overLimit || descriptionTooLong || !dirty;
  const conflict = props.error?.code === 'CONFIG_CHANGED';

  useEffect(() => {
    if (props.error !== null || props.partialNotice !== null) alertRef.current?.focus();
  }, [props.error, props.partialNotice]);

  async function save(): Promise<void> {
    if (saveDisabled) return;
    setReloadFailure(null);
    setReloaded(false);
    const outcome = await props.onSave(description, prompt);
    if (outcome.status === 'saved') props.onSaved(outcome.role);
  }

  async function reload(): Promise<void> {
    setReloadFailure(null);
    const result = await props.onReload();
    if (result.ok) {
      props.onClearError();
      setReloaded(true);
    } else {
      setReloadFailure(`Reload failed: ${result.error.code}: ${result.error.message}`);
    }
  }

  const countText = overLimit ? `Too long: ${bytes} / ${MAX_INSTRUCTION_BYTES} UTF-8 bytes.` : promptCountText(prompt);
  return <Dialog
    title={`Edit ${role.name} instructions`}
    subtitle={role.instructions.path !== null ? <>Saved to <code>{role.instructions.path}</code></> : undefined}
    width={780}
    busy={props.pending}
    onClose={props.onCancel}
    footerNote="Takes effect on the next assignment"
    initialFocus={descriptionRef}
    className="role-instructions-dialog"
    actions={[
      { label: 'Cancel', onClick: props.onCancel },
      { label: props.pending ? 'Saving...' : 'Save to file', variant: 'primary', disabled: saveDisabled, onClick: () => { void save(); } },
    ]}
  >
    <div className="role-instructions-field">
      <label htmlFor={`${uid}-description`}>Description</label>
      <textarea
        id={`${uid}-description`}
        ref={descriptionRef}
        rows={3}
        value={description}
        disabled={props.pending || props.readOnly === true}
        onChange={event => setDescription(event.target.value)}
      />
      <p className="role-instructions-hint">A short summary shown in Roles and on member pages.</p>
      {descriptionTooLong && <p className="role-instructions-error-text" role="alert">{`Use ${MAX_DESCRIPTION} characters or fewer.`}</p>}
    </div>
    <div className="role-instructions-field">
      <div className="role-instructions-field-head">
        <label htmlFor={`${uid}-prompt`}>Prompt</label>
        <span id={`${uid}-prompt-count`} className={`role-instructions-count${overLimit ? ' is-error' : ''}`} aria-live="polite">{countText}</span>
      </div>
      <textarea
        id={`${uid}-prompt`}
        className="role-instructions-prompt-input"
        rows={14}
        value={prompt}
        disabled={props.pending || props.readOnly === true || blocked}
        aria-describedby={`${uid}-prompt-count${blocked ? ` ${uid}-blocked` : ''}`}
        onChange={event => setPrompt(event.target.value)}
      />
      {blocked && <p id={`${uid}-blocked`} className="role-instructions-error-text">Shared instructions were not fully read, so this role cannot be saved here. Reload the catalog to try again.</p>}
    </div>
    <div className="role-instructions-note">
      <Icon name="warning" size={14} />
      <span>{`Every member with the ${role.name} role uses this file. Assignments already running keep the instructions they started with.`}</span>
    </div>
    {(props.error !== null || props.partialNotice !== null || reloadFailure !== null) && <div ref={alertRef} className="role-instructions-save-error" role="alert" tabIndex={-1}>
      {props.partialNotice !== null && <p>{props.partialNotice}</p>}
      {props.error !== null && (conflict
        ? <><p><code>{props.error.code}</code>: {CONFLICT_MESSAGE}</p>{props.error.remediation !== undefined && <p>{props.error.remediation}</p>}</>
        : <><p><code>{props.error.code}</code>: {props.error.message}</p>{props.error.remediation !== undefined && <p>{props.error.remediation}</p>}</>)}
      {conflict && <button type="button" disabled={props.pending} onClick={() => void reload()}>Reload and review</button>}
      {reloadFailure !== null && <p>{reloadFailure}</p>}
    </div>}
    {reloaded && <p className="role-instructions-reloaded" role="status">Current role values were reloaded. Review the draft, then save again.</p>}
  </Dialog>;
}

/** Form values that change only the description and prompt; name and skills keep the catalog values. */
export function roleInstructionsValues(role: RoleCatalogItem, description: string, prompt: string): RoleFormValues {
  return {
    id: role.id,
    name: role.name,
    description,
    instructions: prompt,
    skills: role.skills.map(skill => skill.id),
  };
}
