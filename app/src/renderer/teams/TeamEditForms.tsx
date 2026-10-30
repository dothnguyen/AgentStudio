import { createContext, useContext, useEffect, useId, useRef, useState, type FormEvent, type JSX, type KeyboardEvent } from 'react';
import type { AgentDef, ResolvedAgentOption, RoleCatalogItem } from '../api';
import {
  addAgentOption, removeAgentOption, moveAgentOption, TICKET_PERMISSION_HINT, TICKET_PERMISSION_UNKNOWN,
  memberChanges,
  memberRoleChoices,
  validateMemberForm,
  type MemberFormValues,
  type WriteFeedback,
} from './teamEditModel';
import { providerModelText } from './teamsModel';

function escapeCancel(onCancel: () => void) {
  return (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };
}

/** Lets a form report that it holds the single active role=alert, so independent section errors stay visible without a second alert. */
export const FormAlertContext = createContext<(active: boolean) => void>(() => undefined);

function FieldError(props: { id: string; message: string | undefined }): JSX.Element | null {
  if (props.message === undefined) return null;
  return <p className="teams-field-error" id={props.id}>{props.message}</p>;
}

export function TeamNameForm(props: {
  heading: string;
  submitLabel: string;
  initialName: string;
  pending: boolean;
  readOnly?: boolean;
  onSubmit(name: string): void;
  onCancel(): void;
}): JSX.Element {
  const { heading, submitLabel, initialName, pending, onSubmit, onCancel } = props;
  const uid = useId();
  const inputId = `${uid}-name`;
  const errorId = `${uid}-name-error`;
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  function submit(e: FormEvent): void {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') {
      setError('Enter a team name.');
      inputRef.current?.focus();
      return;
    }
    if (initialName !== '' && trimmed === initialName) {
      setError('Enter a different name.');
      inputRef.current?.focus();
      return;
    }
    setError(undefined);
    onSubmit(trimmed);
  }

  return (
    <form aria-label={heading} className="teams-edit-form" onSubmit={submit} onKeyDown={escapeCancel(onCancel)}>
      <h3>{heading}</h3>
      <label htmlFor={inputId}>Team name</label>
      <input
        id={inputId}
        ref={inputRef}
        type="text"
        autoFocus
        value={name}
        aria-invalid={error !== undefined ? 'true' : undefined}
        aria-describedby={error !== undefined ? errorId : undefined}
        onChange={(e) => setName(e.target.value)}
      />
      <FieldError id={errorId} message={error} />
      <div className="teams-team-actions">
        <button type="submit" disabled={pending || props.readOnly === true}>{pending ? 'Saving…' : submitLabel}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function MemberForm(props: {
  mode: 'add' | 'edit';
  heading: string;
  initial: MemberFormValues;
  originalOptions: ResolvedAgentOption[];
  inlineContext: { provider: string | null; model: string | null; reasoning: string | null } | null;
  agents: AgentDef[] | null;
  roles: readonly RoleCatalogItem[] | null;
  roleCatalogMessage: string | null;
  pending: boolean;
  readOnly?: boolean;
  onSubmit(values: MemberFormValues): void;
  onCancel(): void;
}): JSX.Element {
  const { mode, heading, initial, originalOptions, inlineContext, agents, roles, roleCatalogMessage, pending, onSubmit, onCancel } = props;
  const uid = useId();
  const [values, setValues] = useState<MemberFormValues>(initial);
  const [errors, setErrors] = useState<Partial<Record<keyof MemberFormValues, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const submitted = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [invalidSubmit, setInvalidSubmit] = useState(0);
  const reportAlert = useContext(FormAlertContext);
  const localAlert = errors.agents !== undefined || formError !== null;
  useEffect(() => { reportAlert(localAlert); return () => reportAlert(false); }, [localAlert, reportAlert]);
  useEffect(() => { if (invalidSubmit > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(); }, [invalidSubmit]);
  const wasPending = useRef(pending);
  useEffect(() => { headingRef.current?.focus(); }, []);
  useEffect(() => { if (wasPending.current && !pending && submitted.current && submitRef.current?.isConnected) { submitted.current = false; submitRef.current.focus(); } wasPending.current = pending; }, [pending]);

  const available = (agents ?? []).filter((a) => !values.agents.includes(a.id));
  const changes = mode === 'edit' ? memberChanges(initial, values) : null;
  const catalogBlocked = mode === 'add'
    ? roles === null || (values.useCatalogAgents && agents === null)
    : (changes?.role !== undefined && roles === null) || (changes?.agents !== undefined && agents === null);
  const missing = new Set(values.agents.filter((id) => agents === null
    ? originalOptions.some((o) => o.id === id && o.state === 'missing')
    : !agents.some((a) => a.id === id)));

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (pending || props.readOnly || catalogBlocked) return;
    const found = validateMemberForm(values, mode, missing);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) { setInvalidSubmit(n => n + 1); return; }
    if (mode === 'edit' && memberChanges(initial, values) === null) {
      setFormError('No changes to save.');
      return;
    }
    submitted.current = true;
    onSubmit(values);
  }

  function field(key: keyof MemberFormValues): { id: string; err: string; invalid: 'true' | undefined; described: string | undefined } {
    const id = `${uid}-${key}`;
    const err = `${id}-error`;
    return {
      id,
      err,
      invalid: errors[key] !== undefined ? 'true' : undefined,
      described: errors[key] !== undefined ? err : undefined,
    };
  }
  const agentF = field('agents');
  const roleF = field('role');
  const nameF = field('name');
  const roleChoices = roles === null ? [] : memberRoleChoices(roles, values.role);
  const roleHintId = `${uid}-role-hint`;
  const set = (key: 'name' | 'role', value: string) => setValues((v) => ({ ...v, [key]: value }));

  return (
    <form ref={formRef} aria-label={heading} className="teams-edit-form" onSubmit={submit} onKeyDown={escapeCancel(onCancel)}>
      <h3 ref={headingRef} tabIndex={-1}>{heading}</h3>
      {!values.useCatalogAgents && inlineContext !== null && (
        <>
          <p>Inline — {providerModelText(inlineContext.provider, inlineContext.model)}{inlineContext.reasoning ? ` · Reasoning: ${inlineContext.reasoning}` : ''}</p>
          <button type="button" onClick={() => setValues((v) => ({ ...v, useCatalogAgents: true }))}>Use catalog agents</button>
        </>
      )}
      {values.useCatalogAgents && (
        <div className="teams-options" aria-describedby={agentF.described}>
          {agents === null && <p className="panel-note">Agent catalog unavailable; adding options is unavailable.</p>}
          <ol className="teams-option-list">
            {values.agents.map((id, index) => {
              const option = agents?.find((a) => a.id === id);
              const original = originalOptions.find((o) => o.id === id);
              const name = option?.name ?? (agents === null ? original?.name : null) ?? id;
              const provider = option?.provider ?? original?.provider ?? null;
              const model = option?.model ?? original?.model ?? null;
              const reasoning = option?.reasoning ?? original?.reasoning;
              return <li className="teams-option-row" key={`${id}-${index}`}>
                <div className="teams-option-meta"><strong>{name}</strong> <span>{providerModelText(provider, model)}</span>
                  {reasoning && <span>Reasoning: {reasoning}</span>}
                  {index === 0 && <span className="teams-option-default">Default</span>}
                  {missing.has(id) && <span className="teams-option-missing">Missing from catalog</span>}
                </div>
                <div className="teams-option-actions">
                  <button type="button" aria-label={`Move ${name} up`} disabled={pending || index === 0} onClick={() => setValues((v) => ({ ...v, agents: moveAgentOption(v.agents, index, -1) }))}>Up</button>
                  <button type="button" aria-label={`Move ${name} down`} disabled={pending || index === values.agents.length - 1} onClick={() => setValues((v) => ({ ...v, agents: moveAgentOption(v.agents, index, 1) }))}>Down</button>
                  <button type="button" aria-label={`Remove ${name}`} disabled={pending} onClick={() => setValues((v) => ({ ...v, agents: removeAgentOption(v.agents, index) }))}>Remove</button>
                </div>
              </li>;
            })}
          </ol>
          <label htmlFor={agentF.id}>Add agent option</label>
          <select id={agentF.id} value="" disabled={pending || agents === null || available.length === 0} aria-invalid={agentF.invalid} aria-describedby={agentF.described} onChange={(e) => setValues((v) => ({ ...v, agents: addAgentOption(v.agents, e.target.value) }))}>
            <option value="">Choose an agent</option>
            {available.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}
          </select>
          {agents !== null && available.length === 0 && <p>All catalog agents are already options.</p>}
          {errors.agents && <p className="teams-field-error" id={agentF.err} role="alert">{errors.agents}</p>}
        </div>
      )}
      <label htmlFor={roleF.id}>Role</label>
      {roles !== null ? (
        <select
          id={roleF.id}
          value={values.role}
          disabled={pending}
          aria-invalid={roleF.invalid}
          aria-describedby={[roleF.described, roleHintId].filter(Boolean).join(' ')}
          onChange={(e) => set('role', e.target.value)}
        >
          {mode === 'add' && <option value="">Choose a role</option>}
          {roleChoices.map((c) => <option key={`${c.state}:${c.id}`} value={c.id}>{c.label}</option>)}
        </select>
      ) : (
        <select id={roleF.id} value={values.role} disabled aria-describedby={roleHintId}>
          {values.role === '' ? <option value="">No role available</option> : <option value={values.role}>{values.role}</option>}
        </select>
      )}
      {roles === null && roleCatalogMessage !== null && <p className="panel-note">{roleCatalogMessage}</p>}
      {roles !== null && roles.length === 0 && <p className="panel-note">No roles are configured.</p>}
      <p id={roleHintId} className="panel-note">Role metadata and instructions are shared. Ticket permission and saved agent options remain settings of this member.</p>
      <FieldError id={roleF.err} message={errors.role} />
      <label htmlFor={nameF.id}>{mode === 'add' ? 'Member name (optional)' : 'Member name'}</label>
      <input
        id={nameF.id}
        type="text"
        value={values.name}
        aria-invalid={nameF.invalid}
        aria-describedby={nameF.described}
        onChange={(e) => set('name', e.target.value)}
      />
      <FieldError id={nameF.err} message={errors.name} />
      <div className="teams-permission-field"><input id={`${uid}-canAddTickets`} type="checkbox" checked={values.canAddTickets === true} disabled={pending || (mode === 'edit' && values.canAddTickets === undefined)} aria-describedby={`${uid}-canAddTickets-hint`} onChange={e => setValues(v => ({ ...v, canAddTickets: e.target.checked }))} /><label htmlFor={`${uid}-canAddTickets`}>Can add tickets</label></div>
      <p id={`${uid}-canAddTickets-hint`} className="panel-note">{mode === 'edit' && values.canAddTickets === undefined ? TICKET_PERMISSION_UNKNOWN : TICKET_PERMISSION_HINT}</p>
      {formError !== null && <p className="teams-field-error" role={errors.agents ? undefined : 'alert'}>{formError}</p>}
      <div className="teams-team-actions">
        <button ref={submitRef} type="submit" disabled={pending || props.readOnly === true || catalogBlocked}>
          {pending ? 'Saving…' : mode === 'add' ? 'Add member' : 'Save member'}
        </button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function WriteFeedbackView(props: { feedback: WriteFeedback | null; alert?: boolean; announce?: boolean; onDismiss(): void }): JSX.Element | null {
  const { feedback, onDismiss } = props;
  if (feedback === null) return null;
  if (feedback.kind === 'success') {
    return <p className="teams-feedback teams-feedback-success" role={props.announce === false ? undefined : 'status'}>{feedback.text}</p>;
  }
  return (
    <div className="panel-error teams-feedback" role={props.alert === false ? undefined : 'alert'}>
      <p><strong>{feedback.title}</strong></p>
      <p><code className="entity-id">{feedback.code}</code>: {feedback.message}</p>
      {feedback.remediation !== null && <p>{feedback.remediation}</p>}
      {feedback.dataText && <p><code>{feedback.dataText}</code></p>}
      {feedback.hint !== null && <p>{feedback.hint}</p>}
      {feedback.problems.length > 0 && (
        <ul aria-label="Validation problems">
          {feedback.problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}
      <button type="button" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}
