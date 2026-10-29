import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX } from 'react';
import type { ManagementError, RoleCatalogItem, RoleCatalogList } from '../api';
import { RoleSkillEditor } from './RoleSkillEditor';
import {
  editRoleForm, emptyRoleForm, instructionBytes, MAX_DESCRIPTION, MAX_INSTRUCTION_BYTES, ROLE_FIELDS, roleErrorProblems, suggestRoleId, validateRoleForm,
  type RoleFormErrors, type RoleFormField, type RoleFormMode, type RoleFormValues,
} from './roleEditModel';

export type RoleFormPhase = 'idle' | 'saving_metadata' | 'reloading_tokens' | 'saving_instructions' | 'verifying';
export interface RoleFormConflict { server: RoleCatalogItem; changedFields: RoleFormField[]; acknowledged: boolean }
export interface RoleFormProps {
  mode: RoleFormMode;
  source: RoleCatalogItem | null;
  catalog: RoleCatalogList;
  pending: boolean;
  phase: RoleFormPhase;
  serverError: ManagementError | null;
  partialNotice: string | null;
  conflict: RoleFormConflict | null;
  mutationsBlockedReason: string | null;
  onSubmit(values: RoleFormValues): void;
  onCancel(dirty: boolean): void;
  onReloadConflict(): void;
  onKeepDraft(): void;
  onUseServer(): void;
}

export const CONFLICT_MESSAGE = 'Another edit was saved first. Reload current values and review the differences; nothing was overwritten.';
const PHASE_LABEL: Record<RoleFormPhase, string> = { idle: '', saving_metadata: 'Saving metadata…', reloading_tokens: 'Refreshing…', saving_instructions: 'Saving instructions…', verifying: 'Verifying…' };
const FIELD_LABEL: Record<RoleFormField, string> = { id: 'Role id', name: 'Name', description: 'Description', instructions: 'Shared instructions', skills: 'Skills' };
const FOCUSABLE = 'input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)';

function initialValues(props: RoleFormProps): RoleFormValues { return props.mode === 'edit' && props.source ? editRoleForm(props.source) : emptyRoleForm(); }
function sameValues(a: RoleFormValues, b: RoleFormValues): boolean {
  return a.id === b.id && a.name === b.name && a.description === b.description && a.instructions === b.instructions && a.skills.length === b.skills.length && a.skills.every((s, i) => s === b.skills[i]);
}

function compare(field: RoleFormField, server: RoleCatalogItem, draft: RoleFormValues): [string, string] {
  switch (field) {
    case 'name': return [server.name, draft.name];
    case 'description': return [server.description ?? '(none)', draft.description || '(none)'];
    case 'skills': return [server.skills.map(s => s.id).join(', ') || '(none)', draft.skills.join(', ') || '(none)'];
    case 'instructions': return [`${instructionBytes(server.instructions.text ?? '')} bytes, content differs`, `${instructionBytes(draft.instructions)} bytes`];
    default: return [server.id, draft.id];
  }
}

export function RoleForm(props: RoleFormProps): JSX.Element {
  const uid = useId();
  const [values, setValues] = useState<RoleFormValues>(() => initialValues(props));
  const [errors, setErrors] = useState<RoleFormErrors>({});
  const [idTouched, setIdTouched] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [dismissed, setDismissed] = useState<ManagementError | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const base = initialValues(props);
  const dirty = !sameValues(values, base);
  const serverError = props.serverError !== dismissed ? props.serverError : null;
  const server = serverError ? roleErrorProblems(serverError) : { fields: {} as RoleFormErrors, unmatched: [] as string[] };
  const isConflict = serverError?.code === 'CONFIG_CHANGED' || props.conflict !== null;
  const awaitingAck = props.conflict !== null && !props.conflict.acknowledged;
  const instructionState = props.mode === 'edit' ? props.source?.instructions.state : undefined;
  const unreadable = instructionState === 'truncated' || instructionState === 'invalid';
  const blocked = props.mutationsBlockedReason ?? (unreadable ? 'Shared instructions were not fully read, so this role cannot be saved here. Reload the catalog to try again.' : null);
  const saveDisabled = props.pending || !!blocked || awaitingAck || (isConflict && props.conflict === null);
  const errorOf = (f: RoleFormField) => errors[f] ?? server.fields[f];
  const attrs = (f: RoleFormField, extra?: string) => {
    const ids = [errorOf(f) ? `${uid}-${f}-error` : '', extra ?? ''].filter(Boolean).join(' ');
    return { 'data-field': f, 'aria-invalid': errorOf(f) ? true : undefined, 'aria-describedby': ids || undefined };
  };
  const fieldError = (f: RoleFormField) => errorOf(f) && <span className="roles-field-error" id={`${uid}-${f}-error`}>{errorOf(f)}</span>;
  const setField = (patch: Partial<RoleFormValues>, field: RoleFormField) => { setValues(v => ({ ...v, ...patch })); setErrors(e => ({ ...e, [field]: undefined })); setDismissed(props.serverError); };

  useEffect(() => { formRef.current?.querySelector<HTMLInputElement>('[data-field="name"]')?.focus(); }, []);
  useLayoutEffect(() => { if (props.serverError || props.partialNotice) formRef.current?.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus(); }, [props.serverError, props.partialNotice]);
  useEffect(() => { if (confirming) keepRef.current?.focus(); }, [confirming]);

  const requestClose = () => {
    if (props.pending) return;
    if (!dirty) props.onCancel(false); else { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setConfirming(true); }
  };
  const keepEditing = () => { setConfirming(false); (returnFocus.current && returnFocus.current.isConnected ? returnFocus.current : formRef.current?.querySelector<HTMLElement>('[data-field="name"]'))?.focus(); };
  const submit = () => {
    if (saveDisabled) return;
    const next = validateRoleForm(values, props.mode, props.catalog);
    setErrors(next); setDismissed(props.serverError);
    const first = ROLE_FIELDS.find(f => next[f]);
    if (first) { requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>(`[data-field="${first}"]`)?.focus()); return; }
    props.onSubmit(values);
  };

  const title = props.mode === 'create' ? 'Create role' : `Edit ${props.source?.name ?? values.name}`;
  const submitLabel = props.pending && props.phase !== 'idle' ? PHASE_LABEL[props.phase] : props.mode === 'create' ? 'Create role' : 'Save changes';
  const hasValidation = ROLE_FIELDS.some(f => errors[f]);
  const showAlert = hasValidation || serverError || props.partialNotice;
  const availableSkills = props.catalog.availableSkills.map(id => ({ id }));
  const bytes = instructionBytes(values.instructions);

  return <form ref={formRef} role="dialog" aria-modal="true" aria-labelledby={`${uid}-heading`} className="roles-form" noValidate
    onSubmit={e => { e.preventDefault(); submit(); }}
    onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (confirming) keepEditing(); else requestClose(); }
      else if (e.key === 'Tab') {
        const controls = [...(formRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
        const first = controls[0]; const last = controls[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
    <h2 id={`${uid}-heading`}>{title}</h2>
    {showAlert && <div role="alert" className="panel-error roles-form-alert">
      {hasValidation && <p>Please correct the highlighted fields.</p>}
      {props.partialNotice && <p>{props.partialNotice}</p>}
      {serverError && (serverError.code === 'CONFIG_CHANGED'
        ? <><p><code>{serverError.code}</code>: {CONFLICT_MESSAGE}</p>{serverError.remediation && <p>{serverError.remediation}</p>}</>
        : <><p><code>{serverError.code}</code>: {serverError.message}</p>{serverError.remediation && <p>{serverError.remediation}</p>}{server.unmatched.map((line, i) => <p key={i}>{line}</p>)}</>)}
    </div>}
    <div className="roles-field">
      <label htmlFor={`${uid}-id`}>Role id</label>
      <input id={`${uid}-id`} {...attrs('id', props.mode === 'edit' ? `${uid}-id-note` : undefined)} value={values.id} readOnly={props.mode === 'edit'} disabled={props.pending} spellCheck={false}
        onChange={e => { setIdTouched(true); setField({ id: e.target.value }, 'id'); }} />
      {props.mode === 'edit' && <p id={`${uid}-id-note`}>The stable id cannot be renamed. Changing Name is a safe display-label rename.</p>}
      {fieldError('id')}
    </div>
    <div className="roles-field">
      <label htmlFor={`${uid}-name`}>Name</label>
      <input id={`${uid}-name`} {...attrs('name')} value={values.name} disabled={props.pending}
        onChange={e => { const name = e.target.value; setField(props.mode === 'create' && !idTouched ? { name, id: suggestRoleId(name) } : { name }, 'name'); if (props.mode === 'create' && !idTouched) setErrors(er => ({ ...er, id: undefined })); }} />
      {fieldError('name')}
    </div>
    <div className="roles-field">
      <label htmlFor={`${uid}-description`}>Description</label>
      <textarea id={`${uid}-description`} {...attrs('description', `${uid}-desc-count`)} value={values.description} disabled={props.pending} onChange={e => setField({ description: e.target.value }, 'description')} />
      <span id={`${uid}-desc-count`}>{values.description.length} / {MAX_DESCRIPTION} characters</span>
      {fieldError('description')}
    </div>
    <div className="roles-field">
      <label htmlFor={`${uid}-instructions`}>Shared instructions</label>
      <textarea id={`${uid}-instructions`} {...attrs('instructions', `${uid}-ins-hint ${uid}-ins-count`)} className="roles-instructions-input" value={values.instructions} disabled={props.pending} onChange={e => setField({ instructions: e.target.value }, 'instructions')} />
      <span id={`${uid}-ins-count`}>{bytes} / {MAX_INSTRUCTION_BYTES} UTF-8 bytes</span>
      {fieldError('instructions')}
    </div>
    <div id={`${uid}-ins-hint`}>
      <p>Shared by all members assigned this role.</p>
      <p>Saved changes apply to new assignments; current assignments keep their frozen instructions.</p>
    </div>
    <RoleSkillEditor skills={values.skills} availableSkills={availableSkills} disabled={props.pending} error={errorOf('skills')} onChange={skills => setField({ skills }, 'skills')} />
    {props.conflict && <section className="roles-conflict" aria-labelledby={`${uid}-conflict`}>
      <h3 id={`${uid}-conflict`}>Review differences</h3>
      {props.conflict.changedFields.length === 0 ? <p>The saved version changed, but none of the fields shown here differ from your starting values.</p>
        : <dl>{props.conflict.changedFields.map(f => { const [s, d] = compare(f, props.conflict!.server, values); return <div key={f} className="roles-conflict-field"><dt>{FIELD_LABEL[f]}</dt><dd>Server: {s}</dd><dd>Your draft: {d}</dd></div>; })}</dl>}
      <div className="roles-form-actions">
        <button type="button" disabled={props.pending} onClick={props.onKeepDraft}>Keep my draft</button>
        <button type="button" disabled={props.pending} onClick={props.onUseServer}>Use server values</button>
      </div>
      {awaitingAck && <p>Choose how to continue before saving.</p>}
    </section>}
    {isConflict && props.conflict === null && <div className="roles-form-actions"><button type="button" disabled={props.pending} onClick={props.onReloadConflict}>Reload and review</button></div>}
    {blocked && <p id={`${uid}-blocked`}>{blocked}</p>}
    {confirming
      ? <div className="roles-form-actions" role="group" aria-label="Discard unsaved changes">
        <p>Discard unsaved changes?</p>
        <button type="button" ref={keepRef} onClick={keepEditing}>Keep editing</button>
        <button type="button" onClick={() => props.onCancel(true)}>Discard changes</button>
      </div>
      : <div className="roles-form-actions">
        <button type="submit" aria-busy={props.pending} aria-describedby={blocked ? `${uid}-blocked` : undefined} disabled={saveDisabled}>{submitLabel}</button>
        <button type="button" disabled={props.pending} onClick={requestClose}>Cancel</button>
      </div>}
    {props.pending && <p role="status" className="roles-form-status">{PHASE_LABEL[props.phase]}</p>}
  </form>;
}
