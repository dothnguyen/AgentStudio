import { useRef, useState, type JSX } from 'react';
import type { BoardColumn, BoardSettings, BoardTicketSummary, ManagementApi } from '../api';
import { Dialog } from '../teams/Dialog';
import {
  buildMoveDestinations,
  defaultDestination,
  moveRequestFor,
} from './moveTicketModel';

export interface MoveTicketDialogProps {
  ticket: Pick<BoardTicketSummary, 'key' | 'title' | 'status' | 'workflowStatus'>;
  settings: BoardSettings;
  management: ManagementApi;
  workspaceId: string;
  onClose(): void;
  onMoved(target: { column: BoardColumn; workflowStatus: string }): void;
}

interface MoveError {
  message: string;
  remediation?: string;
}

/**
 * Moves one ticket to a board column and workflow status allowed by the active board
 * settings. The request is guarded against duplicate submissions, and a backend failure
 * leaves the ticket untouched while keeping the dialog open for another try.
 */
export function MoveTicketDialog(props: MoveTicketDialogProps): JSX.Element {
  const destinations = buildMoveDestinations(props.ticket, props.settings);
  const initial = defaultDestination(destinations);
  const [column, setColumn] = useState<BoardColumn | null>(initial?.column ?? null);
  const [status, setStatus] = useState(initial?.defaultStatus ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MoveError | null>(null);
  const inFlight = useRef(false);
  const destination = destinations.find((candidate) => candidate.column === column) ?? null;
  const canMove = destination !== null
    && !destination.disabled
    && destination.statuses.some((option) => option.id === status);

  function chooseColumn(value: string): void {
    const next = destinations.find((candidate) => candidate.column === value) ?? null;
    setColumn(next?.column ?? null);
    setStatus(next?.defaultStatus ?? '');
    setError(null);
  }

  async function move(): Promise<void> {
    if (inFlight.current || !canMove || destination === null) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await props.management.ticketMove(
        props.workspaceId,
        moveRequestFor(props.ticket, destination, status),
      );
      if (result.ok) {
        props.onMoved({ column: destination.column, workflowStatus: status });
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
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Move ${props.ticket.key}`}
      subtitle={props.ticket.title}
      onClose={props.onClose}
      busy={busy}
      actions={[
        { label: 'Cancel', onClick: props.onClose },
        {
          label: 'Move ticket',
          variant: 'primary',
          disabled: !canMove,
          onClick: () => { void move(); },
        },
      ]}
    >
      <div className="boards-move-form">
        <label>
          Column
          <select aria-label="Column" value={column ?? ''} onChange={(event) => { chooseColumn(event.target.value); }} disabled={busy}>
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
        </label>
        {destination !== null && (
          <label>
            Workflow status
            <select
              aria-label="Workflow status"
              value={status}
              onChange={(event) => { setStatus(event.target.value); setError(null); }}
              disabled={busy || destination.disabled || destination.statuses.length === 0}
            >
              {destination.statuses.map((option) => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </select>
          </label>
        )}
        {destination?.disabled === true && destination.reason !== null && (
          <p className="boards-move-hint" role="note">{destination.reason}</p>
        )}
        {destination?.force === true && (
          <p className="boards-move-hint" role="note">Moving a finished ticket reopens it.</p>
        )}
        {error !== null && (
          <p role="alert">
            {error.message}
            {error.remediation !== undefined && <> {error.remediation}</>}
          </p>
        )}
      </div>
    </Dialog>
  );
}
