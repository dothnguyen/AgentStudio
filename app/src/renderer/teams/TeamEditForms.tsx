import { useId, useState, type FormEvent, type JSX, type KeyboardEvent } from 'react';
import type { AgentDef } from '../api';
import {
  memberChanges,
  validateMemberForm,
  type MemberFormValues,
  type WriteFeedback,
} from './teamEditModel';
import { text } from './teamsModel';

function escapeCancel(onCancel: () => void) {
  return (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };
}

function FieldError(props: { id: string; message: string | undefined }): JSX.Element | null {
  if (props.message === undefined) return null;
  return <p className="teams-field-error" id={props.id}>{props.message}</p>;
}

export function TeamNameForm(props: {
  heading: string;
  submitLabel: string;
  initialName: string;
  pending: boolean;
  onSubmit(name: string): void;
  onCancel(): void;
}): JSX.Element {
  const { heading, submitLabel, initialName, pending, onSubmit, onCancel } = props;
  const uid = useId();
  const inputId = `${uid}-name`;
  const errorId = `${uid}-name-error`;
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | undefined>(undefined);

  function submit(e: FormEvent): void {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') {
      setError('Enter a team name.');
      return;
    }
    if (initialName !== '' && trimmed === initialName) {
      setError('Enter a different name.');
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
        type="text"
        autoFocus
        value={name}
        aria-invalid={error !== undefined ? 'true' : undefined}
        aria-describedby={error !== undefined ? errorId : undefined}
        onChange={(e) => setName(e.target.value)}
      />
      <FieldError id={errorId} message={error} />
      <div className="teams-team-actions">
        <button type="submit" disabled={pending}>{pending ? 'Saving…' : submitLabel}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function MemberForm(props: {
  mode: 'add' | 'edit';
  heading: string;
  initial: MemberFormValues;
  inlineProvider: string | null;
  agents: AgentDef[] | null;
  roles: string[];
  pending: boolean;
  onSubmit(values: MemberFormValues): void;
  onCancel(): void;
}): JSX.Element {
  const { mode, heading, initial, inlineProvider, agents, roles, pending, onSubmit, onCancel } = props;
  const uid = useId();
  const [values, setValues] = useState<MemberFormValues>(initial);
  const [errors, setErrors] = useState<Partial<Record<keyof MemberFormValues, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const options: Array<{ id: string; label: string }> = [];
  for (const a of agents ?? []) {
    const id = text(a.id);
    if (id !== null) options.push({ id, label: `${text(a.name) ?? id} (${id})` });
  }
  if (initial.agent !== '' && !options.some((o) => o.id === initial.agent)) {
    options.push({ id: initial.agent, label: `${initial.agent} (not in catalog)` });
  }
  const noAgents = mode === 'add' && options.length === 0;

  function submit(e: FormEvent): void {
    e.preventDefault();
    const found = validateMemberForm(values, mode);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;
    if (mode === 'edit' && memberChanges(initial, values) === null) {
      setFormError('No changes to save.');
      return;
    }
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
  const agentF = field('agent');
  const roleF = field('role');
  const nameF = field('name');
  const listId = `${uid}-roles`;
  const set = (key: keyof MemberFormValues, value: string) => setValues((v) => ({ ...v, [key]: value }));

  return (
    <form aria-label={heading} className="teams-edit-form" onSubmit={submit} onKeyDown={escapeCancel(onCancel)}>
      <h3>{heading}</h3>
      {agents === null && mode === 'edit' && (
        <p className="panel-note">Agent catalog unavailable; the agent cannot be changed.</p>
      )}
      {noAgents && <p className="panel-note">No reusable agents available. Add an agent to the catalog first.</p>}
      <label htmlFor={agentF.id}>Agent</label>
      <select
        id={agentF.id}
        autoFocus
        value={values.agent}
        aria-invalid={agentF.invalid}
        aria-describedby={agentF.described}
        onChange={(e) => set('agent', e.target.value)}
      >
        {mode === 'add' && <option value="">Choose an agent</option>}
        {mode === 'edit' && inlineProvider !== null && (
          <option value="">{`Keep inline provider (${inlineProvider})`}</option>
        )}
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <FieldError id={agentF.err} message={errors.agent} />
      <label htmlFor={roleF.id}>Role</label>
      <input
        id={roleF.id}
        type="text"
        list={listId}
        value={values.role}
        aria-invalid={roleF.invalid}
        aria-describedby={roleF.described}
        onChange={(e) => set('role', e.target.value)}
      />
      <datalist id={listId}>
        {roles.map((r) => <option key={r} value={r} />)}
      </datalist>
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
      {formError !== null && <p className="teams-field-error" role="alert">{formError}</p>}
      <div className="teams-team-actions">
        <button type="submit" disabled={pending || noAgents}>
          {pending ? 'Saving…' : mode === 'add' ? 'Add member' : 'Save member'}
        </button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function WriteFeedbackView(props: { feedback: WriteFeedback | null; onDismiss(): void }): JSX.Element | null {
  const { feedback, onDismiss } = props;
  if (feedback === null) return null;
  if (feedback.kind === 'success') {
    return <p className="teams-feedback teams-feedback-success" role="status">{feedback.text}</p>;
  }
  return (
    <div className="panel-error teams-feedback" role="alert">
      <p><strong>{feedback.title}</strong></p>
      <p><code className="entity-id">{feedback.code}</code>: {feedback.message}</p>
      {feedback.remediation !== null && <p>{feedback.remediation}</p>}
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
