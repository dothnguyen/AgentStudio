import { useEffect, useRef, useState, type JSX } from 'react';
import type { BoardSettings, BoardStatuses, BoardWorkflows, BoardWorkflowDetail, ConnectionStatus, ManagementApi, ManagementError, Workspace } from '../api';
import { useDashboardSection } from '../dashboard/useDashboardSection';
import { SectionError } from '../teams/SectionError';
import { RoutingWorktreesDialog } from '../teams/RoutingWorktreesDialog';
import { boardSettingsChanges, createRoutingDraft, errorProblems, validateRoutingDraft, type RoutingDraft } from '../teams/routingSettingsModel';
import type { TeamsNavigationController } from '../teams/useTeamsNavigationController';
import { buildRoutingCards, filterRoutingCards, type RoutingCard, type RoutingGroup } from '../workflow/routingCardsModel';
import './routingCards.css';

export interface RoutingScreenProps {
  workspace: Workspace; management: ManagementApi; connection?: ConnectionStatus;
  navigation?: TeamsNavigationController; onViewRole?(roleId: string): void; onOpenTeam?(teamId: string | null): void; onOpenTeams?(): void;
  onStatuses?(): void; onAdd?(): void; onEdit?(name: string): void;
}

function readCollapsed(workspaceId: string): Set<string> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(`routing-collapsed:${workspaceId}`) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  } catch { return new Set(); }
}

export function RoutingScreen({ workspace, management, connection, onStatuses, onAdd, onEdit }: RoutingScreenProps): JSX.Element {
  const board = useDashboardSection<BoardSettings>(management.boardSettings, workspace.id);
  const workflows = useDashboardSection<BoardWorkflows>(management.boardWorkflows, workspace.id);
  const statuses = useDashboardSection<BoardStatuses>(management.boardStatuses, workspace.id);
  const [details, setDetails] = useState<BoardWorkflowDetail[]>([]);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed(workspace.id));
  useEffect(() => { setCollapsed(readCollapsed(workspace.id)); }, [workspace.id]);
  function updateCollapsed(value: Set<string>): void {
    setCollapsed(value);
    try { sessionStorage.setItem(`routing-collapsed:${workspace.id}`, JSON.stringify([...value])); } catch { /* Storage may be unavailable. */ }
  }
  const [draft, setDraft] = useState<RoutingDraft | null>(null);
  const [snapshot, setSnapshot] = useState<BoardSettings | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState('');
  const worktreesButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => { if (!draft && restoreFocus.current) { restoreFocus.current = false; worktreesButton.current?.focus(); } }, [draft]);
  const [error, setError] = useState<ManagementError | null>(null);
  const [reloadError, setReloadError] = useState<ManagementError | null>(null);
  useEffect(() => {
    let active = true;
    setDetails([]);
    if (workflows.data) void Promise.all(workflows.data.workflows.map(w => management.boardWorkflow(workspace.id, w.name).catch(() => null))).then(results => {
      if (active) setDetails(results.flatMap(result => result?.ok ? [result.data] : []));
    });
    return () => { active = false; };
  }, [management, workspace.id, workflows.data]);
  const settings = board.data;
  const model = workflows.data && statuses.data && settings ? buildRoutingCards(workflows.data, statuses.data, settings, details) : null;
  const cards = model ? filterRoutingCards(model.cards, query) : [];
  const connected = connection === undefined || connection.state === 'connected';
  const editable = connected && !!snapshot?.board.sha256 && snapshot.board.state === 'ok';
  const problems = snapshot && draft ? [...validateRoutingDraft(draft, snapshot), ...(error?.code === 'BOARD_CONFIG_INVALID' ? errorProblems(error) : [])] : [];
  async function reload(): Promise<void> {
    const result = await board.reloadFresh?.();
    if (result && !result.ok) { setReloadError(result.error); return; }
    if (saved) setNotice('Saved base branch.');
    restoreFocus.current = true; setDraft(null); setSnapshot(null); setSaved(false); setError(null); setReloadError(null);
  }
  async function save(): Promise<void> {
    if (!snapshot || !draft || !editable || pending || problems.length) return;
    const changes = boardSettingsChanges(draft, snapshot);
    if (!changes) return;
    setPending(true); setError(null);
    try {
      const result = await management.updateBoardSettings(workspace.id, changes, snapshot.board.sha256!);
      if (!result.ok) setError(result.error);
      else { setSaved(true); const refreshed = await board.reloadFresh?.(); if (refreshed && !refreshed.ok) setReloadError(refreshed.error); else { restoreFocus.current = true; setDraft(null); setSnapshot(null); setSaved(false); setNotice('Saved base branch.'); } }
    } catch (reason) { setError({ code: 'INTERNAL', message: String(reason), retryable: false }); }
    finally { setPending(false); }
  }
  const groups: Array<[RoutingGroup, string]> = [['main', 'Main path'], ['detour', 'Detours'], ['unreachable', 'Not reachable']];
  return <div className="routing-cards-screen" data-section="routing" role="region" aria-label="Workspace board routing">
    <header className="routing-cards-header"><div><h1>Routing</h1><p>Each workflow starts when a ticket reaches its status. A free member with the workflow's role picks the ticket up, works through the steps, and the result sets the ticket's next status, where the next workflow takes over.</p></div><div className="routing-actions">
      {workflows.data?.workflows.some(w => w.workspace === 'worktree') && <button ref={worktreesButton} type="button" onClick={() => { if (settings) { setNotice(''); setSnapshot(settings); setDraft(createRoutingDraft(settings)); } }} disabled={!settings || !connected}>Worktrees: {settings?.worktree.baseBranch ?? 'main'}</button>}
      <button type="button" className="routing-primary" onClick={onAdd} disabled={!onAdd}>+ Add workflow</button></div></header>
    <div role="status">{notice}</div><SectionError section={board} label="Board settings" /><SectionError section={workflows} label="Workflows" /><SectionError section={statuses} label="Statuses" />
    {(board.loading || workflows.loading || statuses.loading) && <p role="status">Loading routing…</p>}
    {model && <>
      <div className="routing-toolbar"><div className="routing-actions"><input aria-label="Filter workflows" placeholder="Filter by workflow, status, role or prompt" value={query} onChange={e => setQuery(e.target.value)} /><button type="button" onClick={() => updateCollapsed(new Set())}>Expand all</button><button type="button" onClick={() => updateCollapsed(new Set(model.cards.map(c => c.name)))}>Collapse all</button></div><span>{model.cards.length} workflows · {model.problems.length ? `${model.problems.length} problems` : 'no problems'}</span></div>
      <div className="routing-every"><strong>In every workflow:</strong> a paused run (usage limit, crash) or a cancelled run goes back to its start status and is not counted as a fail; a question from the agent waits for an answer and then the same session continues.</div>
      {model.problems.length > 0 && <div className="routing-problems" role="alert"><strong>{model.problems.length} {model.problems.length === 1 ? 'problem' : 'problems'}:</strong> {model.problems.map(p => p.message).join(' ')}</div>}
      {model.cards.length === 0 ? <div className="routing-empty"><strong>A new board with no workflows yet</strong><p>Tickets go from Backlog to Done only by hand. Add a workflow to have a role work tickets automatically: pick the status that starts it, add its steps, and say which status it sets when it passes or fails.</p><button type="button" className="routing-primary" onClick={onAdd} disabled={!onAdd}>+ Add the first workflow</button></div> : groups.map(([group, title]) => {
        const items = cards.filter(c => c.group === group); return items.length ? <section key={group} className="routing-group"><h2>{title}</h2>{items.map(card => <Card key={card.name} card={card} collapsed={collapsed.has(card.name)} onEdit={onEdit} toggle={() => { const next = new Set(collapsed); if (next.has(card.name)) next.delete(card.name); else next.add(card.name); updateCollapsed(next); }} />)}</section> : null;
      })}
      {model.cards.length > 0 && cards.length === 0 && <p>No workflows match the filter.</p>}
      <div className="routing-start-end"><div><strong>Start and end</strong><p>New tickets wait in {statuses.data?.statuses.find(s => s.id === settings?.todoDefault)?.name ?? settings?.todoDefault ?? 'Backlog'}. Workflows finish tickets in a done status.</p></div><button type="button" onClick={onStatuses} disabled={!onStatuses}>Manage statuses ({statuses.data?.statuses.length ?? 0}) →</button></div>
    </>}
    {draft && snapshot && <RoutingWorktreesDialog settings={snapshot} draft={draft} problems={problems} pending={pending} saved={saved} editable={editable} connected={connected} error={error} reloadError={reloadError} onDraftChange={d => { setDraft(d); if (error?.code !== 'CONFIG_CHANGED') setError(null); }} onSave={() => void save()} onClose={() => { restoreFocus.current = true; setDraft(null); setSnapshot(null); setError(null); setReloadError(null); }} onReloadLatest={() => void reload()} onRetryLatest={() => void reload()} />}
  </div>;
}
function Card({ card, collapsed, toggle, onEdit }: { card: RoutingCard; collapsed: boolean; toggle(): void; onEdit?: (name: string) => void }): JSX.Element {
  return <article className={`routing-card ${card.group}`}><div className="routing-card-header"><button type="button" className="routing-card-toggle" aria-expanded={!collapsed} onClick={toggle}><span className={`routing-dot ${card.colour}`} /><strong>{card.title}</strong><code>{card.file}</code>{card.startTag && <span className="routing-tag">{card.startTag}</span>}{card.group === 'unreachable' && <span className="routing-tag warning">NOT REACHABLE</span>}</button><button type="button" onClick={() => onEdit?.(card.name)} disabled={!onEdit} aria-label={`Edit ${card.title}`}>Edit</button></div>
    {collapsed ? <p className="routing-summary">{card.summary}</p> : <div className="routing-columns"><div><h3>Picks up</h3><dl><dt>Starts at</dt><dd>{card.startsAt}</dd><dt>While running</dt><dd>{card.whileRunning}</dd><dt>Role</dt><dd>{card.role}</dd><dt>Works in</dt><dd>{card.worksIn}</dd></dl></div><div><h3>Steps</h3>{card.steps.map(step => <div className="routing-step" key={step.n}><span>{step.n}</span><div><b>{step.kind}</b> <code>{step.id}</code> {step.detail}<div><em>✓ pass</em> → {step.pass}　<i>× fail</i> → {step.fail}</div></div></div>)}</div><div><h3>Ends</h3><dl><dt className="pass">Pass</dt><dd>{card.pass}{card.release && <small>{card.release}</small>}</dd><dt className="fail">Fail</dt><dd>{card.fail}</dd>{card.blocked && <><dt>Blocked</dt><dd>{card.blocked}</dd></>}</dl><h3>Limits</h3>{card.limits.length ? card.limits.map(l => <p key={l}>{l}</p>) : <p>No limits</p>}{card.createdTickets && <p>{card.createdTickets}</p>}</div></div>}
  </article>;
}
