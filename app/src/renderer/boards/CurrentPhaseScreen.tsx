import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type {
  ApiError,
  BoardPhases,
  BoardSettings,
  BoardTicketList,
  ManagementApi,
  Result,
  Workspace,
} from '../api';
import { currentPhaseOf, phaseProgress } from './currentPhaseModel';
import { BoardLanes } from './BoardLanes';
import { BoardToolbar } from './BoardToolbar';
import {
  DEFAULT_BOARD_FILTERS,
  filterBoardTickets,
  matchesBoardFilters,
  type BoardFilters,
} from './boardFilters';

/** The board has no pushed change event today; a poll keeps the header and lanes current. */
export const BOARD_CHANGED_EVENT = 'board-changed';
export const CURRENT_PHASE_REFRESH_MS = 5000;

export interface CurrentPhaseData {
  phases: BoardPhases;
  settings: BoardSettings;
  tickets: BoardTicketList | null;
}

export type CurrentPhaseState = 'loading' | 'ready' | 'error';

export interface CurrentPhaseBoardController {
  state: CurrentPhaseState;
  data: CurrentPhaseData | null;
  error: ApiError | null;
  reload(): Promise<void>;
}

interface CurrentPhaseOptions {
  /** Poll interval; 0 disables it. */
  refreshMs?: number;
  /** Listen for the window-level board-changed event; defaults to true. */
  refreshOnEvent?: boolean;
}

interface ControllerValue {
  state: CurrentPhaseState;
  data: CurrentPhaseData | null;
  error: ApiError | null;
}

function internalError(reason: unknown): ApiError {
  return {
    code: 'INTERNAL',
    message: reason instanceof Error ? reason.message : String(reason),
    retryable: false,
  };
}

async function call<T>(load: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await load();
  } catch (reason) {
    return { ok: false, error: internalError(reason) };
  }
}

function emptyTicketList(workspaceId: string): BoardTicketList {
  return { workspace: workspaceId, statuses: [], status: null, phase: null, tickets: [] };
}

/** Loads the phases, the current phase's tickets and the board rules, then refreshes in place. */
export function useCurrentPhaseBoard(
  management: ManagementApi,
  workspaceId: string,
  options: CurrentPhaseOptions = {},
): CurrentPhaseBoardController {
  const refreshMs = options.refreshMs ?? CURRENT_PHASE_REFRESH_MS;
  const refreshOnEvent = options.refreshOnEvent ?? true;
  const [value, setValue] = useState<ControllerValue>({ state: 'loading', data: null, error: null });
  const sequence = useRef(0);
  const hasData = useRef(false);

  const load = useCallback(async (silent: boolean): Promise<void> => {
    const request = ++sequence.current;
    if (!silent || !hasData.current) {
      setValue({ state: 'loading', data: null, error: null });
    }

    const phases = await call(() => management.boardPhases(workspaceId));
    if (request !== sequence.current) return;
    if (!phases.ok) {
      hasData.current = false;
      setValue({ state: 'error', data: null, error: phases.error });
      return;
    }

    const phase = currentPhaseOf(phases.data);
    const [settings, tickets] = await Promise.all([
      call(() => management.boardSettings(workspaceId)),
      phase === null
        ? Promise.resolve({ ok: true as const, data: emptyTicketList(workspaceId) })
        : call(() => management.boardTickets(workspaceId, { phase: phase.slug })),
    ]);
    if (request !== sequence.current) return;
    if (!settings.ok) {
      hasData.current = false;
      setValue({ state: 'error', data: null, error: settings.error });
      return;
    }
    if (!tickets.ok) {
      hasData.current = false;
      setValue({ state: 'error', data: null, error: tickets.error });
      return;
    }

    hasData.current = true;
    setValue({
      state: 'ready',
      data: { phases: phases.data, settings: settings.data, tickets: tickets.data },
      error: null,
    });
  }, [management, workspaceId]);

  useEffect(() => {
    hasData.current = false;
    void load(false);

    const timer = refreshMs > 0 ? setInterval(() => { void load(true); }, refreshMs) : null;
    const onBoardChanged = (): void => { void load(true); };
    if (refreshOnEvent && typeof window !== 'undefined') {
      window.addEventListener(BOARD_CHANGED_EVENT, onBoardChanged);
    }
    return () => {
      sequence.current += 1;
      if (timer !== null) clearInterval(timer);
      if (refreshOnEvent && typeof window !== 'undefined') {
        window.removeEventListener(BOARD_CHANGED_EVENT, onBoardChanged);
      }
    };
  }, [load, refreshMs, refreshOnEvent]);

  const reload = useCallback(async (): Promise<void> => { await load(false); }, [load]);

  return { ...value, reload };
}

export interface CurrentPhaseScreenProps {
  workspace: Workspace;
  management: ManagementApi;
  /** Opens the Phases screen from the "no current phase" state. */
  onOpenPhases?(): void;
  /** Initial state of the Hide empty columns chip; defaults to on. */
  hideEmpty?: boolean;
  /** Opens the ticket page; omitted until the ticket-page story wires it in. */
  onOpenTicket?(key: string): void;
  /** Test seam for the refresh interval; the app uses 5 seconds. */
  refreshMs?: number;
}

function Breadcrumb(): JSX.Element {
  return (
    <nav className="boards-breadcrumb" aria-label="Breadcrumb">
      <span>Boards</span>
      <span aria-hidden="true">/</span>
      <span aria-current="page">Current Phase</span>
    </nav>
  );
}

function InfoIcon(): JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  );
}

function Notice(): JSX.Element {
  return (
    <div className="boards-notice">
      <InfoIcon />
      <span>While a team is running, tickets in this phase are worked automatically by the routing rules. Tickets in other phases wait until their phase is current.</span>
    </div>
  );
}

function LoadingSkeleton(): JSX.Element {
  return (
    <div className="boards-skeleton" role="status" aria-live="polite">
      <span className="visually-hidden">Loading the current phase…</span>
      <div className="boards-skeleton-heading" aria-hidden="true">
        <span className="boards-skeleton-line boards-skeleton-title" />
        <span className="boards-skeleton-line boards-skeleton-description" />
      </div>
      <span className="boards-skeleton-line boards-skeleton-progress" aria-hidden="true" />
      <div className="boards-skeleton-panel" aria-hidden="true">
        <span className="boards-skeleton-line boards-skeleton-panel-title" />
        <span className="boards-skeleton-line boards-skeleton-panel-line" />
      </div>
    </div>
  );
}

export function CurrentPhaseScreen(props: CurrentPhaseScreenProps): JSX.Element {
  const board = useCurrentPhaseBoard(props.management, props.workspace.id, { refreshMs: props.refreshMs });
  const [filters, setFilters] = useState<BoardFilters>(() => ({
    ...DEFAULT_BOARD_FILTERS,
    hideEmpty: props.hideEmpty ?? DEFAULT_BOARD_FILTERS.hideEmpty,
  }));
  const phase = board.data === null ? null : currentPhaseOf(board.data.phases);
  const tickets = board.data?.tickets?.tickets ?? [];
  const filteredTickets = filterBoardTickets(tickets, filters);
  const progress = phaseProgress(tickets);
  const settingsStatuses = board.data?.settings.statuses ?? [];
  const statuses = settingsStatuses.length > 0
    ? settingsStatuses
    : (board.data?.tickets?.statuses ?? []).map((id) => ({ id, name: null, kind: null }));
  const matches = (ticket: (typeof tickets)[number]): boolean => matchesBoardFilters(ticket, filters);

  if (board.state === 'loading') {
    return (
      <div className="boards-current-screen" data-section="boards/current">
        <Breadcrumb />
        <h1 className="visually-hidden">Current Phase</h1>
        <LoadingSkeleton />
      </div>
    );
  }

  if (board.state === 'error' || board.error !== null) {
    const error = board.error;
    return (
      <div className="boards-current-screen" data-section="boards/current">
        <Breadcrumb />
        <h1 className="visually-hidden">Current Phase</h1>
        <section className="boards-state-card boards-state-error" role="alert">
          <h2>Could not load the current phase</h2>
          {error !== null && <p><code className="entity-id">{error.code}</code>: {error.message}</p>}
          <p>{error?.remediation ?? 'Retry; if it keeps failing, check the Agent Studio connection.'}</p>
          <button type="button" onClick={() => { void board.reload(); }}>Retry</button>
        </section>
      </div>
    );
  }

  if (phase === null) {
    return (
      <div className="boards-current-screen" data-section="boards/current">
        <Breadcrumb />
        <section className="boards-state-card" aria-labelledby="boards-no-current-title">
          <h1 id="boards-no-current-title">No current phase</h1>
          <p>Set a current phase in Phases to see its board here.</p>
          {props.onOpenPhases !== undefined && (
            <button type="button" onClick={props.onOpenPhases}>Open Phases</button>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="boards-current-screen" data-section="boards/current">
      <Breadcrumb />
      <header className="boards-phase-header">
        <div className="boards-phase-summary">
          <div className="boards-phase-title">
            <h1>{phase.name}</h1>
            {phase.current && <span className="boards-phase-pill">Current</span>}
          </div>
          {phase.description !== null && phase.description !== '' && (
            <p className="boards-phase-description">{phase.description}</p>
          )}
        </div>
        <div className="boards-phase-progress" role="group" aria-label="Phase progress">
          <div className="boards-phase-progress-text">
            <span>{progress.done} of {progress.total} tickets done</span>
            <span>{progress.percent}%</span>
          </div>
          <div
            className="boards-phase-progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
            aria-valuetext={`${progress.done} of ${progress.total} tickets done`}
            aria-label="Phase progress"
          >
            <span className="boards-phase-progress-fill" style={{ width: `${progress.percent}%` }} />
          </div>
        </div>
      </header>
      <Notice />
      {tickets.length > 0 && (
        <>
          <BoardToolbar filters={filters} resultCount={filteredTickets.length} onChange={setFilters} />
          {filteredTickets.length > 0 && (
            <BoardLanes
              statuses={statuses}
              rules={board.data?.settings.rules ?? []}
              tickets={tickets}
              hideEmpty={filters.hideEmpty}
              matches={matches}
              onOpenTicket={props.onOpenTicket}
            />
          )}
          {filteredTickets.length === 0 && (
            <section className="boards-no-match" role="status">
              <p>No tickets match these filters</p>
              <button type="button" onClick={() => { setFilters({ ...DEFAULT_BOARD_FILTERS }); }}>
                Clear filters
              </button>
            </section>
          )}
        </>
      )}
      {tickets.length === 0 && (
        <section className="boards-state-card boards-empty-phase" aria-labelledby="boards-empty-title">
          <h2 id="boards-empty-title">No tickets in this phase yet</h2>
          <p>Tickets moved into {phase.name} will appear here.</p>
        </section>
      )}
    </div>
  );
}
