import { memo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { BoardRuleView, BoardTicketSummary } from '../api';
import { statusLabel, statusTone, type BoardStatusInfo } from './boardLaneModel';
import { agentInitials, ticketActivityChip, TICKET_CHIP_TONE_CLASS } from './ticketCardModel';
import type { BoardPhase, BoardSettings, ManagementApi } from '../api';
import { MoveTicketDialog } from './MoveTicketDialog';
import { Dialog } from '../teams/Dialog';
import { ActionMenu } from '../ui/ActionMenu';
import type { MenuItem } from '../ui/actionMenuModel';

interface Props {
  ticket: BoardTicketSummary;
  status: BoardStatusInfo;
  workflowStatus: BoardStatusInfo;
  rules: readonly BoardRuleView[];
  onOpenTicket?: (key: string) => void;
  phases: BoardPhase[];
  settings: BoardSettings;
  management: ManagementApi;
  workspaceId: string;
  onChanged(ticket: BoardTicketSummary, changes: Partial<BoardTicketSummary>): void;
}

function relativeTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function Row({ ticket, status, workflowStatus, rules, onOpenTicket, phases, settings, management, workspaceId, onChanged }: Props): JSX.Element {
  const trigger = useRef<HTMLButtonElement>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [phaseOpen, setPhaseOpen] = useState(false);
  const [phase, setPhase] = useState(ticket.phase ?? phases.find(item => item.current)?.slug ?? phases[0]?.slug ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const phaseInFlight = useRef(false);
  async function changePhase(): Promise<void> {
    if (phaseInFlight.current || !phase || phase === ticket.phase) return;
    phaseInFlight.current = true; setBusy(true); setError('');
    try {
      const result = await management.ticketPhase(workspaceId, { key: ticket.key, phase });
      if (result.ok) { setPhaseOpen(false); onChanged(ticket, { phase }); }
      else setError(`${result.error.message}${result.error.remediation ? ` ${result.error.remediation}` : ''}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { phaseInFlight.current = false; setBusy(false); }
  }
  const chip = ticketActivityChip(ticket, rules);
  const agent = ticket.activity.agent?.trim() ?? '';
  const date = new Date(ticket.updatedAt);
  const open = (): void => { onOpenTicket?.(ticket.key); };
  const menuItems: MenuItem[] = [
    {
      kind: 'action', id: 'change-phase', label: 'Change phase', onSelect: () => {
        setError('');
        setPhase(phases.some(item => item.slug === ticket.phase && item.status === 'open') ? ticket.phase! : '');
        setPhaseOpen(true);
      },
    },
    {
      kind: 'action', id: 'change-status', label: 'Change column or workflow status', onSelect: () => { setMoveOpen(true); },
    },
  ];
  return <div className="boards-backlog-row-wrap"><button type="button" className="boards-backlog-row" aria-label={`Open ${ticket.key}: ${ticket.title}`} onClick={open}>
    <span className="boards-ticket-key boards-backlog-key">{ticket.key}</span>
    <span className="boards-backlog-title" title={ticket.title}>{ticket.title}</span>
    <span className="boards-backlog-status"><span className={`boards-status-dot boards-status-dot-${statusTone(status)}`} aria-hidden="true" />{statusLabel(status)} · {statusLabel(workflowStatus)}</span>
    <span className={`boards-ticket-chip ${TICKET_CHIP_TONE_CLASS[chip.tone]}`}><span className="boards-ticket-chip-dot" aria-hidden="true" />{chip.label}</span>
    {ticket.priority !== 100 && <span className="boards-ticket-priority">Priority {ticket.priority}</span>}
    {agent && <span className="boards-ticket-owner"><span className="boards-ticket-avatar" aria-hidden="true">{agentInitials(agent)}</span><span className="boards-ticket-owner-name">{agent}</span></span>}
    <time className="boards-backlog-time" dateTime={ticket.updatedAt} title={Number.isNaN(date.getTime()) ? '' : date.toLocaleString()}>{relativeTime(ticket.updatedAt)}</time>
  </button><div className="boards-backlog-actions">
    <ActionMenu
      label={`${ticket.key} actions`}
      trigger={{ label: 'Actions', ariaLabel: `Actions for ${ticket.key}` }}
      triggerClassName="boards-backlog-actions-trigger"
      triggerRef={trigger}
      items={menuItems}
    />
  </div>
  {moveOpen && <MoveTicketDialog ticket={ticket} settings={settings} management={management} workspaceId={workspaceId} onClose={() => { setMoveOpen(false); trigger.current?.focus(); }} onMoved={(target) => { setMoveOpen(false); onChanged(ticket, { status: target.column, workflowStatus: target.workflowStatus }); }} />}
  {phaseOpen && <Dialog title={`Change phase for ${ticket.key}`} subtitle={ticket.title} onClose={() => { if (!busy) { setPhaseOpen(false); trigger.current?.focus(); } }} busy={busy} actions={[{label:'Cancel',onClick:()=>{ setPhaseOpen(false); trigger.current?.focus(); }},{label:'Move ticket',variant:'primary',disabled:!phase || phase === ticket.phase || busy,onClick:()=>{ void changePhase(); }}]}>
    <label>Phase<select aria-label="Phase" value={phase} disabled={busy} onChange={e=>setPhase(e.target.value)}><option value="" disabled>Select a phase</option>{phases.filter(item=>item.status==='open').map(item=><option key={item.slug} value={item.slug}>{item.name}</option>)}</select></label>
    {error && <div role="alert">{error} <button type="button" disabled={busy} onClick={()=>{ void changePhase(); }}>Retry</button></div>}
  </Dialog>}
  </div>;
}

// Polling creates new objects; compare their contents so unchanged rows can be reused.
export const BacklogRow = memo(Row, (a, b) => a.onOpenTicket === b.onOpenTicket
  && a.ticket.key === b.ticket.key && a.ticket.updatedAt === b.ticket.updatedAt && a.phases === b.phases && a.settings === b.settings && a.management === b.management && a.workspaceId === b.workspaceId && a.onChanged === b.onChanged
  && JSON.stringify([a.ticket, a.status, a.workflowStatus, a.rules]) === JSON.stringify([b.ticket, b.status, b.workflowStatus, b.rules]));
