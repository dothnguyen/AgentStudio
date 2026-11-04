import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type {
  ApiError,
  BoardRuleView,
  BoardSettings,
  BoardTicketDetail,
  ManagementApi,
  Result,
  Workspace,
} from '../api';
import { MoveToTodoDialog } from './MoveToTodoDialog';
import { SectionCard } from '../teams/SectionCard';
import type { BoardStatusInfo } from './boardLaneModel';
import {
  TICKET_CHIP_TONE_CLASS,
  ticketActivityChip,
} from './ticketCardModel';
import {
  blockedReturnLabel,
  blocksRows,
  ticketActivitySummary,
  ticketDetails,
  ticketEventRows,
  formatLocalTime,
  approvalRoute,
  ticketStatusChip,
  ticketWork,
  waitsForRows,
  type TicketDependencyRow,
} from './ticketPageModel';

export interface TicketScreenProps {
  ticketKey: string;
  workspace: Workspace;
  management: ManagementApi;
  /** Name of the board the ticket was opened from; defaults to Current Phase. */
  boardLabel?: string;
  /** Returns to the board; the breadcrumb and the not-found state both link back. */
  onOpenBoard?(): void;
  /** Opens another ticket from the Dependencies card. */
  onOpenTicket?(key: string): void;
}

export type TicketPageState = 'loading' | 'ready' | 'notfound' | 'error';

interface TicketPageValue {
  state: TicketPageState;
  detail: BoardTicketDetail | null;
  statuses: BoardStatusInfo[];
  rules: BoardRuleView[];
  error: ApiError | null;
  settings: BoardSettings | null;
}

export interface TicketPageController extends TicketPageValue {
  reload(): Promise<void>;
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

function emptyValue(state: TicketPageState, error: ApiError | null = null): TicketPageValue {
  return { state, detail: null, statuses: [], rules: [], error, settings: null };
}

/**
 * Reads one ticket and, in parallel, the board rules that supply the activity chip's round limit.
 * A failed settings read is not fatal: the page still renders the ticket without round counts.
 */
export function useBoardTicket(
  management: ManagementApi,
  workspaceId: string,
  ticketKey: string,
): TicketPageController {
  const [value, setValue] = useState<TicketPageValue>(() => emptyValue('loading'));
  const sequence = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const request = ++sequence.current;
    setValue(emptyValue('loading'));

    const [ticket, settings] = await Promise.all([
      call(() => management.boardTicket(workspaceId, { key: ticketKey })),
      call(() => management.boardSettings(workspaceId)),
    ]);
    if (request !== sequence.current) return;

    if (settings.ok === false) {
      console.warn('Could not load the board settings for the ticket page:', settings.error.code, settings.error.message);
    }

    if (!ticket.ok) {
      const state: TicketPageState = ticket.error.code === 'TICKET_NOT_FOUND' ? 'notfound' : 'error';
      setValue(emptyValue(state, ticket.error));
      return;
    }

    setValue({
      state: 'ready',
      detail: ticket.data,
      statuses: settings.ok ? settings.data.statuses : [],
      rules: settings.ok ? settings.data.rules : [],
      error: null,
      settings: settings.ok ? settings.data : null,
    });
  }, [management, ticketKey, workspaceId]);

  useEffect(() => {
    void load();
    return () => {
      sequence.current += 1;
    };
  }, [load]);

  const reload = useCallback(async (): Promise<void> => { await load(); }, [load]);
  return { ...value, reload };
}

function Breadcrumb(props: {
  ticketKey: string;
  boardLabel: string;
  onOpenBoard?: () => void;
}): JSX.Element {
  return (
    <nav className="boards-breadcrumb" aria-label="Breadcrumb">
      <span>Boards</span>
      <span aria-hidden="true">/</span>
      {props.onOpenBoard === undefined
        ? <span>{props.boardLabel}</span>
        : <button type="button" className="boards-crumb" onClick={props.onOpenBoard}>{props.boardLabel}</button>}
      <span aria-hidden="true">/</span>
      <span className="boards-breadcrumb-key" aria-current="page">{props.ticketKey}</span>
    </nav>
  );
}

function WarningIcon(): JSX.Element {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </svg>
  );
}

function BlockedBanner(props: {
  detail: BoardTicketDetail;
  statuses: readonly BoardStatusInfo[];
}): JSX.Element {
  const ticket = props.detail.ticket;
  const reason = ticket.blockedReason?.trim() ?? '';
  const returnLabel = blockedReturnLabel(ticket, props.statuses);
  return (
    <div className="boards-blocked-banner" role="status">
      <WarningIcon />
      <span>
        <strong>Blocked.</strong>
        {reason !== '' && <> {reason}</>}
        {returnLabel !== null && <> It returns to {returnLabel} when it is unblocked.</>}
      </span>
    </div>
  );
}

function TicketHeader(props: {
  detail: BoardTicketDetail;
  statuses: readonly BoardStatusInfo[];
  rules: readonly BoardRuleView[];
}): JSX.Element {
  const ticket = props.detail.ticket;
  const status = ticketStatusChip(ticket, props.statuses);
  const workflowStatus = ticketStatusChip({ workflowStatus: ticket.workflowStatus, returnStatus: null }, props.statuses);
  const activity = ticketActivityChip(ticketActivitySummary(props.detail), props.rules);
  return (
    <header className="boards-ticket-header">
      <div className="boards-ticket-heading">
        <div className="boards-ticket-chips">
          <span className="boards-ticket-key-chip">{ticket.key}</span>
          <span className="boards-ticket-chip boards-ticket-column-chip">{ticket.status}</span>
          <span className="boards-ticket-status-chip" data-status={status.id}>
            <span className={`boards-status-dot boards-status-dot-${status.tone}`} aria-hidden="true" />
            {status.label}
          </span>
          {workflowStatus.id !== status.id && <span className="boards-ticket-chip">{workflowStatus.label}</span>}
          <span
            className={`boards-ticket-chip boards-ticket-activity-chip ${TICKET_CHIP_TONE_CLASS[activity.tone]}`}
            data-chip={activity.tone}
          >
            <span className="boards-ticket-chip-dot" aria-hidden="true" />
            {activity.label}
          </span>
          {ticket.priority !== 100 && (
            <span className="boards-ticket-priority-chip">Priority {ticket.priority}</span>
          )}
        </div>
        <h1>{ticket.title}</h1>
      </div>
      {ticket.workflowStatus === 'blocked' && <BlockedBanner detail={props.detail} statuses={props.statuses} />}
    </header>
  );
}

export function ticketActions(ticket: Pick<BoardTicketDetail['ticket'], 'status' | 'assignee'>): string[] {
  if (ticket.status === 'backlog') return ['Move to Todo'];
  if (ticket.status === 'done' || ticket.status === 'closed') return ['Reopen'];
  if (ticket.assignee === null && (ticket.status === 'todo' || ticket.status === 'in-progress')) return ['Change workflow status', 'Back to Backlog', 'Close'];
  return [];
}

function TicketActions(props: { detail: BoardTicketDetail; settings: BoardSettings | null; management: ManagementApi; workspaceId: string; reload(): Promise<void> }): JSX.Element {
  const [dialog, setDialog] = useState(false);
  const [changing, setChanging] = useState(false);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ticket = props.detail.ticket;
  const actions = ticketActions(ticket);
  const options = (props.settings?.workflowStatuses ?? []).filter(status => status.kind === null && status.id !== 'blocked' && status.id !== ticket.workflowStatus && !props.settings?.rules.some(rule => rule.during === status.id));
  async function act(action: string): Promise<void> {
    setBusy(true); setError(null);
    try {
      const result = action === 'workflow'
        ? await props.management.ticketWorkflow(props.workspaceId, { key: ticket.key, to: selected })
        : await props.management.ticketMove(props.workspaceId, { key: ticket.key, to: action === 'backlog' ? 'backlog' : 'closed' });
      if (result.ok) await props.reload(); else setError(result.error.message);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <div className="boards-ticket-actions">
    {actions.map(action => <button type="button" key={action} disabled={busy || ((action === 'Move to Todo' || action === 'Reopen') && !props.settings)} onClick={() => {
      setError(null);
      if (action === 'Move to Todo' || action === 'Reopen') setDialog(true);
      else if (action === 'Change workflow status') { setSelected(options[0]?.id ?? ''); setChanging(true); }
      else void act(action === 'Back to Backlog' ? 'backlog' : 'closed');
    }}>{action}</button>)}
    {changing && <span><label>Workflow status <select value={selected} onChange={event => setSelected(event.target.value)}>{options.map(option => <option key={option.id} value={option.id}>{option.name || option.id}</option>)}</select></label> <button type="button" disabled={busy || !selected} onClick={() => { void act('workflow'); }}>Apply</button> <button type="button" disabled={busy} onClick={() => setChanging(false)}>Cancel</button></span>}
    {error && <p role="alert">{error}</p>}
    {dialog && props.settings && <MoveToTodoDialog ticketKey={ticket.key} settings={props.settings} management={props.management} workspaceId={props.workspaceId} force={ticket.status === 'done' || ticket.status === 'closed'} onClose={() => setDialog(false)} onSuccess={() => { setDialog(false); void props.reload(); }} />}
  </div>;
}

function AttentionPanel(props: { detail: BoardTicketDetail; management: ManagementApi; workspaceId: string; onSent(): void }): JSX.Element | null {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticket = props.detail.ticket;
  const approval = ticket.waitingApproval;
  const input = ticket.needsInput;
  const context = props.detail.attentionContext;
  if (!approval && !input) return null;
  async function send(approve?: boolean): Promise<void> {
    setBusy(true); setError(null);
    try {
      const result = approval
        ? await props.management.approveWorkflow(props.workspaceId, { workflowRunId: approval.workflowRunId, stage: approval.stage, approve: approve === true, note: value })
        : await props.management.answerAssignment(props.workspaceId, { assignmentId: context!.assignmentId!, answer: value });
      if (result.ok) props.onSent(); else setError(result.error.message);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <section className={`boards-attention-panel ${approval ? 'approval' : 'input'}`}>
    <header><strong>{approval ? 'Waiting for your approval' : 'The agent asked a question'}</strong>
      <div>Workflow {context?.workflow ?? ticket.activity.workflow ?? '—'} · step {approval?.stage ?? context?.stage ?? '—'}{!approval && <> · {context?.member ?? '—'} ({context?.agent ?? ticket.activity.agent ?? '—'})</>} · since {formatLocalTime(approval?.since ?? input?.since)}</div>
    </header>
    <div className="boards-attention-body">
      <p className={approval ? undefined : 'boards-attention-question'}>{approval?.ask ?? input?.question}</p>
      <label>{approval ? 'Note (optional)' : 'Your answer'}<textarea value={value} onChange={event => setValue(event.target.value)} /></label>
      {error && <p role="alert">{error}</p>}
      <div className="boards-attention-buttons">{approval ? <><button type="button" disabled={busy} onClick={() => { void send(false); }}>Reject</button><button type="button" className="boards-attention-primary" disabled={busy} onClick={() => { void send(true); }}>Approve</button></> : <button type="button" className="boards-attention-primary" disabled={busy || !value.trim() || !context?.assignmentId} onClick={() => { void send(); }}>Send answer</button>}</div>
      <p className="boards-attention-hint">{approval ? `Approve → ${approvalRoute(context, 'pass')}. Reject → ${approvalRoute(context, 'fail')}.` : 'The same session continues with your answer'}</p>
    </div>
  </section>;
}

function DescriptionCard(props: { body: string | null }): JSX.Element {
  const body = props.body ?? '';
  return (
    <SectionCard
      title="Description"
      subtitle="The ticket body. The next agent receives it as its task."
      className="boards-description-card"
    >
      {body.trim() === ''
        ? <p className="boards-ticket-body-empty">This ticket has no body.</p>
        : <pre className="boards-ticket-body">{body}</pre>}
    </SectionCard>
  );
}

function TimelineCard(props: { detail: BoardTicketDetail }): JSX.Element {
  const rows = ticketEventRows(props.detail.events);
  return (
    <SectionCard
      title="Timeline"
      subtitle="What happened to this ticket, oldest first."
      className="boards-timeline-card"
    >
      {props.detail.eventsTruncated && (
        <p className="boards-timeline-truncated" role="note">
          Showing the latest {rows.length} events
        </p>
      )}
      {rows.length === 0
        ? <p className="boards-timeline-empty">No events yet.</p>
        : (
          <ol className="boards-timeline">
            {rows.map((row) => (
              <li key={row.id} className="boards-event-row">
                <span className={`boards-event-dot boards-event-dot-${row.tone}`} aria-hidden="true" />
                <span className="boards-event-main">
                  <span className="boards-event-title">{row.title}</span>
                  {row.detail !== null && <span className="boards-event-detail">{row.detail}</span>}
                </span>
                <time className="boards-event-time" dateTime={props.detail.events.find((event) => event.id === row.id)?.at}>
                  {row.time}
                </time>
              </li>
            ))}
          </ol>
        )}
    </SectionCard>
  );
}

function WorkCard(props: {
  detail: BoardTicketDetail;
  rules: readonly BoardRuleView[];
}): JSX.Element {
  const work = ticketWork(props.detail, props.rules);
  const idle = work.owner === 'Nobody is working on this ticket';
  return (
    <SectionCard title="Work" subtitle="Who is on it now." className="boards-work-card">
      <dl className="boards-work-grid">
        <div>
          <dt>Owner</dt>
          <dd className={idle ? 'boards-work-idle' : undefined}>{work.owner}</dd>
        </div>
        <div>
          <dt>Round</dt>
          <dd>{work.round}</dd>
        </div>
        <div className="boards-work-wide">
          <dt>Branch</dt>
          <dd className="boards-work-mono">{work.branch}</dd>
        </div>
        <div className="boards-work-wide">
          <dt>Run</dt>
          <dd className="boards-work-mono" title={work.runId ?? undefined}>{work.run}</dd>
        </div>
      </dl>
    </SectionCard>
  );
}

function DependencyRow(props: {
  row: TicketDependencyRow;
  onOpenTicket?: (key: string) => void;
}): JSX.Element {
  return (
    <li className="boards-dependency-row">
      <span className={`boards-dependency-dot boards-event-dot-${props.row.statusTone === 'red' ? 'amber' : 'blue'}`} aria-hidden="true" />
      <button
        type="button"
        className="boards-dep-link"
        onClick={() => { props.onOpenTicket?.(props.row.key); }}
      >
        <span className="boards-dep-key">{props.row.key}</span>
        {props.row.title !== null && props.row.title.trim() !== '' && (
          <span className="boards-dep-title" title={props.row.title}>{props.row.title}</span>
        )}
      </button>
      <span className="boards-dep-status">{props.row.statusLabel}</span>
    </li>
  );
}

function DependenciesCard(props: {
  detail: BoardTicketDetail;
  statuses: readonly BoardStatusInfo[];
  onOpenTicket?: (key: string) => void;
}): JSX.Element {
  const waitsFor = waitsForRows(props.detail, props.statuses);
  const blocks = blocksRows(props.detail, props.statuses);
  return (
    <SectionCard
      title="Dependencies"
      subtitle="A ticket is not claimed until everything it waits for is done."
      className="boards-dependencies-card"
    >
      <div className="boards-dependency-group">
        <h2 className="boards-dependency-heading">Waits for</h2>
        {waitsFor.length === 0
          ? <p className="boards-dependency-empty">None</p>
          : (
            <ul className="boards-dependency-list">
              {waitsFor.map((row) => (
                <DependencyRow key={row.key} row={row} onOpenTicket={props.onOpenTicket} />
              ))}
            </ul>
          )}
      </div>
      <div className="boards-dependency-group">
        <h2 className="boards-dependency-heading">Blocks</h2>
        {blocks.length === 0
          ? <p className="boards-dependency-empty">None</p>
          : (
            <ul className="boards-dependency-list">
              {blocks.map((row) => (
                <DependencyRow key={row.key} row={row} onOpenTicket={props.onOpenTicket} />
              ))}
            </ul>
          )}
      </div>
    </SectionCard>
  );
}

function DetailsCard(props: { detail: BoardTicketDetail }): JSX.Element {
  const details = ticketDetails(props.detail);
  return (
    <SectionCard title="Details" className="boards-details-card">
      <dl className="boards-details-grid">
        <div><dt>Phase</dt><dd>{details.phase}</dd></div>
        <div><dt>Priority</dt><dd>{details.priority}</dd></div>
        <div><dt>Created</dt><dd>{details.created}</dd></div>
        <div><dt>Updated</dt><dd>{details.updated}</dd></div>
      </dl>
    </SectionCard>
  );
}

function LoadingState(): JSX.Element {
  return (
    <section className="boards-state-card" role="status" aria-live="polite">
      <span className="visually-hidden">Loading the ticket…</span>
      <div className="boards-skeleton-heading" aria-hidden="true">
        <span className="boards-skeleton-line boards-skeleton-title" />
        <span className="boards-skeleton-line boards-skeleton-description" />
      </div>
      <div className="boards-skeleton-panel" aria-hidden="true">
        <span className="boards-skeleton-line boards-skeleton-panel-title" />
        <span className="boards-skeleton-line boards-skeleton-panel-line" />
        <span className="boards-skeleton-line boards-skeleton-panel-line" />
      </div>
    </section>
  );
}

export function TicketScreen(props: TicketScreenProps): JSX.Element {
  const ticket = useBoardTicket(props.management, props.workspace.id, props.ticketKey);
  const [sent, setSent] = useState<string | null>(null);
  const boardLabel = props.boardLabel ?? 'Current Phase';
  const breadcrumb = <Breadcrumb ticketKey={props.ticketKey} boardLabel={boardLabel} onOpenBoard={props.onOpenBoard} />;

  if (ticket.state === 'loading') {
    return (
      <div className="boards-ticket-screen" data-section="boards/ticket">
        {breadcrumb}
        <h1 className="visually-hidden">Ticket {props.ticketKey}</h1>
        <LoadingState />
      </div>
    );
  }

  if (ticket.state === 'notfound') {
    return (
      <div className="boards-ticket-screen" data-section="boards/ticket">
        {breadcrumb}
        <section className="boards-state-card boards-ticket-not-found" aria-labelledby="boards-ticket-not-found-title">
          <h1 id="boards-ticket-not-found-title">Ticket not found</h1>
          <p>No ticket with key {props.ticketKey} exists on this board.</p>
          {props.onOpenBoard !== undefined && (
            <button type="button" onClick={props.onOpenBoard}>Back to {boardLabel}</button>
          )}
        </section>
      </div>
    );
  }

  if (ticket.state === 'error' || ticket.detail === null) {
    const error = ticket.error;
    return (
      <div className="boards-ticket-screen" data-section="boards/ticket">
        {breadcrumb}
        <section className="boards-state-card boards-state-error" role="alert">
          <h1>Could not load ticket {props.ticketKey}</h1>
          {error !== null && <p><code className="entity-id">{error.code}</code>: {error.message}</p>}
          <p>{error?.remediation ?? 'Retry; if it keeps failing, check the Agent Studio connection.'}</p>
          <div className="boards-ticket-actions">
            <button type="button" onClick={() => { void ticket.reload(); }}>Retry</button>
            {props.onOpenBoard !== undefined && (
              <button type="button" onClick={props.onOpenBoard}>Back to {boardLabel}</button>
            )}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="boards-ticket-screen" data-section="boards/ticket">
      {breadcrumb}
      <TicketHeader detail={ticket.detail} statuses={ticket.settings?.workflowStatuses.length ? ticket.settings.workflowStatuses : ticket.statuses} rules={ticket.rules} />
      {sent === `${props.workspace.id}:${props.ticketKey}:${ticket.detail.ticket.waitingApproval?.since ?? ticket.detail.ticket.needsInput?.since ?? ''}` || (sent?.startsWith(`${props.workspace.id}:${props.ticketKey}:`) && !ticket.detail.ticket.waitingApproval && !ticket.detail.ticket.needsInput)
        ? <section className="boards-attention-panel"><div className="boards-attention-body" role="status">Sent</div></section>
        : <AttentionPanel key={`attention-${ticket.detail.ticket.key}-${ticket.detail.ticket.waitingApproval?.since ?? ticket.detail.ticket.needsInput?.since ?? ''}`} detail={ticket.detail} management={props.management} workspaceId={props.workspace.id} onSent={() => { setSent(`${props.workspace.id}:${props.ticketKey}:${ticket.detail!.ticket.waitingApproval?.since ?? ticket.detail!.ticket.needsInput?.since ?? ''}`); void ticket.reload(); }} />}
      <TicketActions key={ticket.detail.ticket.key} detail={ticket.detail} settings={ticket.settings} management={props.management} workspaceId={props.workspace.id} reload={ticket.reload} />
      <div className="boards-ticket-layout">
        <div className="boards-ticket-main">
          <DescriptionCard body={ticket.detail.ticket.body} />
          <TimelineCard detail={ticket.detail} />
        </div>
        <aside className="boards-ticket-aside" aria-label="Ticket details">
          <WorkCard detail={ticket.detail} rules={ticket.rules} />
          <DependenciesCard
            detail={ticket.detail}
            statuses={ticket.statuses}
            onOpenTicket={props.onOpenTicket}
          />
          <DetailsCard detail={ticket.detail} />
        </aside>
      </div>
    </div>
  );
}
