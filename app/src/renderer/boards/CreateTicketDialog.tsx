import { useId, useRef, useState, type JSX } from 'react';
import type {
  BoardColumn,
  BoardSettings,
  BoardTicketCreateResult,
  ManagementApi,
  BoardTicketSummary,
} from '../api';
import { Dialog } from '../teams/Dialog';
import {
  buildCreateDestinations,
  createdTicketSummary,
  createTicketRequestFor,
  defaultCreateDestination,
  defaultCreatePhase,
  hasCreateErrors,
  openPhaseOptions,
  validateCreateTicket,
  type CreatePhaseOption,
  type CreateTicketFormValues,
  type CreateTicketValidation,
} from './createTicketModel';

export interface CreateTicketDialogProps {
  workspaceId: string;
  management: ManagementApi;
  settings: BoardSettings;
  phases: readonly CreatePhaseOption[];
  /** The phase selected when the dialog opens; defaults to the current or first open phase. */
  defaultPhase?: string | null;
  onClose(): void;
  onCreated(ticket: BoardTicketSummary, result: BoardTicketCreateResult): void;
}

interface CreateError {
  message: string;
  remediation?: string;
}

/**
 * The one ticket creation form used by Current Phase and Backlog. It offers only the phase,
 * column and workflow statuses the active board configuration accepts, keeps entered values on
 * a backend failure, blocks duplicate submissions and leaves focus restoration to Dialog.
 */
export function CreateTicketDialog(props: CreateTicketDialogProps): JSX.Element {
  const destinations = buildCreateDestinations(props.settings);
  const initialDestination = defaultCreateDestination(destinations);
  const phaseOptions = openPhaseOptions(props.phases);
  const initialPhase = defaultCreatePhase(props.phases, props.defaultPhase);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState('100');
  const [phase, setPhase] = useState(initialPhase);
  const [column, setColumn] = useState<BoardColumn | null>(initialDestination?.column ?? null);
  const [workflowStatus, setWorkflowStatus] = useState(initialDestination?.defaultStatus ?? '');
  const [errors, setErrors] = useState<CreateTicketValidation>({});
  const [error, setError] = useState<CreateError | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const ids = {
    title: useId(),
    body: useId(),
    priority: useId(),
    phase: useId(),
    column: useId(),
    status: useId(),
    titleError: useId(),
    priorityError: useId(),
    phaseError: useId(),
    destinationError: useId(),
  };

  const destination = destinations.find((candidate) => candidate.column === column) ?? null;
  const values: CreateTicketFormValues = { title, body, priority, phase, column, workflowStatus };
  const unavailable = destination === null || destination.disabled || initialPhase === '';

  function chooseColumn(value: string): void {
    const next = destinations.find((candidate) => candidate.column === value) ?? null;
    setColumn(next?.column ?? null);
    setWorkflowStatus(next?.defaultStatus ?? '');
    setErrors((current) => ({ ...current, destination: undefined }));
    setError(null);
  }

  async function submit(): Promise<void> {
    if (inFlight.current) return;
    const nextErrors = validateCreateTicket(values, destination);
    setErrors(nextErrors);
    if (hasCreateErrors(nextErrors) || destination === null || destination.disabled) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    let created = false;
    try {
      const result = await props.management.createTicket(props.workspaceId, createTicketRequestFor(values, destination));
      if (result.ok) {
        created = true;
        props.onCreated(createdTicketSummary(result.data.ticket), result.data);
      } else {
        setError({
          message: result.error.message,
          ...(result.error.remediation === undefined ? {} : { remediation: result.error.remediation }),
        });
      }
    } catch (reason) {
      setError({ message: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      inFlight.current = false;
      if (!created) setBusy(false);
    }
  }

  const fieldError = (message: string | undefined, id: string): JSX.Element | null => (
    message === undefined ? null : <p id={id} className="boards-form-error" role="alert">{message}</p>
  );

  return (
    <Dialog
      title="New ticket"
      subtitle="Add a ticket to a phase on this board."
      onClose={props.onClose}
      busy={busy}
      initialFocus={titleRef}
      width={560}
      actions={[
        { label: 'Cancel', onClick: props.onClose },
        {
          label: 'Create ticket',
          variant: 'primary',
          busy,
          disabled: unavailable,
          onClick: () => { void submit(); },
        },
      ]}
    >
      <div className="boards-create-form">
        <div className="boards-form-field">
          <label htmlFor={ids.title}>Title</label>
          <input
            ref={titleRef}
            id={ids.title}
            value={title}
            disabled={busy}
            aria-invalid={errors.title !== undefined || undefined}
            aria-describedby={errors.title === undefined ? undefined : ids.titleError}
            onChange={(event) => { setTitle(event.target.value); setErrors((current) => ({ ...current, title: undefined })); }}
          />
          {fieldError(errors.title, ids.titleError)}
        </div>

        <div className="boards-form-field">
          <label htmlFor={ids.body}>Description</label>
          <textarea
            id={ids.body}
            rows={4}
            value={body}
            disabled={busy}
            onChange={(event) => { setBody(event.target.value); }}
          />
        </div>

        <div className="boards-form-field">
          <label htmlFor={ids.priority}>Priority</label>
          <input
            id={ids.priority}
            type="number"
            min={0}
            max={1000}
            step={1}
            value={priority}
            disabled={busy}
            aria-invalid={errors.priority !== undefined || undefined}
            aria-describedby={errors.priority === undefined ? undefined : ids.priorityError}
            onChange={(event) => { setPriority(event.target.value); setErrors((current) => ({ ...current, priority: undefined })); }}
          />
          {fieldError(errors.priority, ids.priorityError)}
        </div>

        <div className="boards-form-field">
          <label htmlFor={ids.phase}>Phase</label>
          <select
            id={ids.phase}
            value={phase}
            disabled={busy || phaseOptions.length === 0}
            aria-invalid={errors.phase !== undefined || undefined}
            aria-describedby={errors.phase === undefined ? undefined : ids.phaseError}
            onChange={(event) => { setPhase(event.target.value); setErrors((current) => ({ ...current, phase: undefined })); }}
          >
            {phaseOptions.length === 0 && <option value="">No open phase</option>}
            {phaseOptions.map((option) => (
              <option key={option.slug} value={option.slug}>{option.name}</option>
            ))}
          </select>
          {fieldError(errors.phase, ids.phaseError)}
        </div>

        <div className="boards-form-field">
          <label htmlFor={ids.column}>Column</label>
          <select
            id={ids.column}
            value={column ?? ''}
            disabled={busy}
            aria-invalid={errors.destination !== undefined || undefined}
            aria-describedby={errors.destination === undefined ? undefined : ids.destinationError}
            onChange={(event) => { chooseColumn(event.target.value); }}
          >
            {destinations.map((option) => (
              <option
                key={option.column}
                value={option.column}
                disabled={option.disabled}
                title={option.reason ?? undefined}
              >
                {option.disabled && option.reason !== null ? `${option.label}: ${option.reason}` : option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="boards-form-field">
          <label htmlFor={ids.status}>Workflow status</label>
          <select
            id={ids.status}
            value={workflowStatus}
            disabled={busy || destination === null || destination.disabled || destination.statuses.length === 0}
            onChange={(event) => { setWorkflowStatus(event.target.value); setErrors((current) => ({ ...current, destination: undefined })); }}
          >
            {destination?.statuses.map((option) => (
              <option key={option.id} value={option.id}>{option.name}</option>
            ))}
          </select>
          {destination?.disabled === true && destination.reason !== null && (
            <p className="boards-form-hint" role="note">{destination.reason}</p>
          )}
          {fieldError(errors.destination, ids.destinationError)}
        </div>

        {error !== null && (
          <p className="boards-form-error" role="alert">
            {error.message}
            {error.remediation !== undefined && <> {error.remediation}</>}
          </p>
        )}
      </div>
    </Dialog>
  );
}
