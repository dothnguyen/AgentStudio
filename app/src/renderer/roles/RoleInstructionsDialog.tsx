import { useEffect, useId, useRef, useState, type JSX } from 'react';
import type { ManagementError, Result, RoleCatalogItem, RoleCatalogList } from '../api';
import { Icon } from '../icons/Icon';
import { Dialog } from '../teams/Dialog';
import { instructionBytes, MAX_DESCRIPTION, MAX_INSTRUCTION_BYTES, type RoleFormValues } from './roleEditModel';
import { CONFLICT_MESSAGE, type RoleSaveOutcome } from './roleSave';

export interface RoleInstructionsDialogProps {
  role: RoleCatalogItem;
  pending: boolean;
  error: ManagementError | null;
  partialNotice: string | null;
  readOnly?: boolean;
  /** The member page edits the description with the prompt; the role page does not. */
  showDescription?: boolean;
  /**
   * The member page shows the prompt size in characters; the role page shows
   * UTF-8 bytes against the 16 KiB file limit (design/roles-catalog-v2).
   */
  countMode?: 'characters' | 'bytes';
  promptLabel?: string;
  promptRows?: number;
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
export function promptByteCountText(text: string): string {
  const bytes = instructionBytes(text).toLocaleString('en-US');
  const limit = MAX_INSTRUCTION_BYTES.toLocaleString('en-US');
  return `${promptLines(text)} lines · ${bytes} / ${limit} bytes`;
}

function stateExplanation(role: RoleCatalogItem): string | null {
  switch (role.instructions.state) {
    case 'none': return 'No shared instruction file is configured. Saving instructions creates one.';
    case 'missing': return 'The configured instruction file is missing. Saving instructions creates it again.';
    case 'invalid': return 'Shared instructions were not fully read, so this role cannot be saved here. Reload the catalog to try again.';
    case 'truncated': return 'Shared instructions were not fully read, so this role cannot be saved here. Reload the catalog to try again.';
    default: return null;
  }
}

/** Dialog that edits a role's shared prompt file, and optionally its description (member page). */
export function RoleInstructionsDialog(props: RoleInstructionsDialogProps): JSX.Element {
  const { role } = props;
  const uid = useId();
  const showDescription = props.showDescription !== false;
  const promptLabel = props.promptLabel ?? 'Prompt';
  const [description, setDescription] = useState(() => role.description ?? '');
  const [prompt, setPrompt] = useState(() => role.instructions.text ?? '');
  const [reloadFailure, setReloadFailure] = useState<string | null>(null);
  const [reloaded, setReloaded] = useState(false);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const blocked = unreadable(role);
  const explanation = stateExplanation(role);
  const bytes = instructionBytes(prompt);
  const overLimit = bytes > MAX_INSTRUCTION_BYTES;
  const descriptionTooLong = showDescription && description.trim().length > MAX_DESCRIPTION;
  const dirty = (showDescription && description.trim() !== (role.description ?? '').trim())
    || prompt !== (role.instructions.text ?? '');
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

  const countText = props.countMode === 'bytes'
    ? overLimit
      ? `Too long: ${bytes.toLocaleString('en-US')} / ${MAX_INSTRUCTION_BYTES.toLocaleString('en-US')} bytes.`
      : promptByteCountText(prompt)
    : overLimit
      ? `Too long: ${bytes} / ${MAX_INSTRUCTION_BYTES} UTF-8 bytes.`
      : promptCountText(prompt);
  return <Dialog
    title={`Edit ${role.name} instructions`}
    subtitle={role.instructions.path !== null ? <>Saved to <code>{role.instructions.path}</code></> : undefined}
    width={780}
    busy={props.pending}
    onClose={props.onCancel}
    footerNote="Takes effect on the next assignment"
    initialFocus={showDescription ? descriptionRef : promptRef}
    className="role-instructions-dialog"
    actions={[
      { label: 'Cancel', onClick: props.onCancel },
      { label: props.pending ? 'Saving...' : 'Save to file', variant: 'primary', disabled: saveDisabled, onClick: () => { void save(); } },
    ]}
  >
    {showDescription && <div className="role-instructions-field">
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
    </div>}
    <div className="role-instructions-field">
      <div className="role-instructions-field-head">
        <label htmlFor={`${uid}-prompt`}>{promptLabel}</label>
        <span id={`${uid}-prompt-count`} className={`role-instructions-count${overLimit ? ' is-error' : ''}`} aria-live="polite">{countText}</span>
      </div>
      <textarea
        id={`${uid}-prompt`}
        ref={promptRef}
        className="role-instructions-prompt-input"
        rows={props.promptRows ?? 14}
        value={prompt}
        disabled={props.pending || props.readOnly === true || blocked}
        aria-describedby={`${uid}-prompt-count${explanation !== null ? ` ${uid}-state` : ''}`}
        onChange={event => setPrompt(event.target.value)}
      />
      {explanation !== null && <p id={`${uid}-state`} className="role-instructions-error-text">{explanation}</p>}
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
