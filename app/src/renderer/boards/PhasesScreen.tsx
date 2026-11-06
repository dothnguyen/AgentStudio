import { useId, useRef, useState, type JSX } from 'react';
import type { ManagementApi, Workspace } from '../api';
import { BoardErrorCard, LoadingSkeleton } from './CurrentPhaseScreen';
import { usePhasesData } from './usePhasesData';
import { PhaseCard } from './PhaseCard';
import { Dialog } from '../teams/Dialog';

function phaseSlug(name: string): string { return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64).replace(/-$/, ''); }

export function PhasesScreen({ workspace, management, refreshMs, onViewTickets = () => {}, onOpenBoard = () => {} }: { workspace: Workspace; management: ManagementApi; refreshMs?: number; onViewTickets?: (slug: string) => void; onOpenBoard?: () => void }): JSX.Element {
  const board = usePhasesData(management, workspace.id, refreshMs);
  const [creating, setCreating] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const [makingCurrent, setMakingCurrent] = useState<import('../api').BoardPhase | null>(null);
  const [currentError, setCurrentError] = useState('');
  const [currentBusy, setCurrentBusy] = useState(false);
  const currentFlight = useRef(false);
  const currentTrigger = useRef<HTMLButtonElement | null>(null);
  async function confirmCurrent(): Promise<void> {
    if (!makingCurrent || currentFlight.current) return;
    currentFlight.current = true; setCurrentBusy(true); setCurrentError('');
    try {
      const result = await management.setCurrentPhase(workspace.id, { phase: makingCurrent.slug });
      if (result.ok) { board.reconcileCurrent(makingCurrent.slug); setMakingCurrent(null); requestAnimationFrame(() => currentTrigger.current?.focus()); }
      else setCurrentError(`${result.error.message}${result.error.remediation ? ` ${result.error.remediation}` : ''}`);
    } catch (reason) { setCurrentError(reason instanceof Error ? reason.message : String(reason)); }
    finally { currentFlight.current = false; setCurrentBusy(false); }
  }
  return (
    <div className="boards-current-screen" data-section="boards/phases">
      <nav className="boards-breadcrumb" aria-label="Breadcrumb">
        <span>Boards</span><span aria-hidden="true">/</span><span aria-current="page">Phases</span>
      </nav>
      <header className="boards-phase-header">
        <div className="boards-phase-summary">
          <div className="boards-phase-title"><h1>Phases</h1></div>
          <p className="boards-phase-description">Progress of each phase, by ticket counts.</p>
        </div>
        <button ref={addButton} type="button" className="primary" onClick={() => setCreating(true)}>New phase</button>
      </header>
      {board.state === 'loading' ? <LoadingSkeleton label="Loading phases…" /> :
        board.state === 'error' ? <BoardErrorCard title="Could not load phases" error={board.error} onRetry={() => { void board.reload(); }} /> :
          <>{board.error && <div role="alert" className="boards-inline-error">Could not refresh phases: {board.error.message} <button type="button" onClick={() => { void board.refresh(); }}>Retry</button></div>}
          {board.data?.phases.phases.length === 0 ? <section className="boards-state-card"><h2>No phases yet</h2></section> :
            <div className="boards-milestone-list">{board.data && [...board.data.phases.phases]
              .sort((a, b) => Number(b.current) - Number(a.current) || Number(a.status === 'closed') - Number(b.status === 'closed') || a.position - b.position)
              .map(phase => <PhaseCard key={phase.slug} phase={phase} statuses={board.data!.settings.statuses} onViewTickets={onViewTickets} onOpenBoard={onOpenBoard} onMakeCurrent={(target, trigger) => { currentTrigger.current = trigger; setCurrentError(''); setMakingCurrent(target); }} />)}</div>}</>}
      {makingCurrent && <Dialog role="alertdialog" title="Make phase current?" subtitle={`${makingCurrent.name} (${makingCurrent.slug})`} onClose={() => { if (!currentBusy) setMakingCurrent(null); }} busy={currentBusy} actions={[{ label: 'Cancel', onClick: () => setMakingCurrent(null) }, { label: currentBusy ? 'Making current…' : 'Make current', variant: 'primary', disabled: currentBusy, onClick: () => { void confirmCurrent(); } }]}>
        <p>Tickets in {makingCurrent.name} will become eligible for automatic board workflow routing. Tickets in other phases will wait. This changes which phase workflows consider; it does not move tickets between phases.</p>
        {currentError && <div role="alert">Could not make this phase current: {currentError} <button type="button" disabled={currentBusy} onClick={() => { void confirmCurrent(); }}>Retry</button></div>}
      </Dialog>}
      {creating && board.data && <NewPhaseDialog workspaceId={workspace.id} management={management} phases={board.data.phases.phases} onClose={() => { setCreating(false); requestAnimationFrame(() => addButton.current?.focus()); }} onCreated={phase => { board.reconcileCreated(phase); setCreating(false); requestAnimationFrame(() => addButton.current?.focus()); void board.refresh(); }} />}
    </div>
  );
}

function NewPhaseDialog({ workspaceId, management, phases, onClose, onCreated }: { workspaceId: string; management: ManagementApi; phases: import('../api').BoardPhase[]; onClose(): void; onCreated(phase: import('../api').BoardPhase): void }): JSX.Element {
  const [name, setName] = useState(''); const [slug, setSlug] = useState(''); const [editedSlug, setEditedSlug] = useState(false);
  const [description, setDescription] = useState(''); const [before, setBefore] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState(''); const [slugError, setSlugError] = useState(''); const flight = useRef(false); const nameRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  async function submit(): Promise<void> {
    if (flight.current) return;
    const cleanName = name.trim(); const cleanSlug = slug.trim();
    setNameError(cleanName ? '' : 'Phase name is required.');
    setSlugError(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(cleanSlug) ? 'Use a lowercase slug with letters, digits, or hyphens (up to 64 characters).' : phases.some(p => p.slug === cleanSlug) ? 'This phase ID already exists.' : '');
    if (!cleanName || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(cleanSlug) || phases.some(p => p.slug === cleanSlug)) return;
    flight.current = true; setBusy(true); setError('');
    try {
      const result = await management.createPhase(workspaceId, { id: cleanSlug, name: cleanName, ...(description.trim() ? { description: description.trim() } : {}), ...(before ? { before } : {}) });
      if (result.ok) {
        const phase = normalizeCreatedPhase(result.data?.phase, cleanSlug, cleanName, description.trim(), phases, before);
        if (!phase) { setError('The phase was created, but its response could not be reconciled. Retry to refresh the phase list.'); return; }
        onCreated(phase);
      } else setError(`${result.error.message}${result.error.remediation ? ` ${result.error.remediation}` : ''}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { flight.current = false; setBusy(false); }
  }
  const existing = [...phases].sort((a,b) => a.position-b.position);
  return <Dialog title="New phase" subtitle="Add a phase to this board." onClose={onClose} busy={busy} initialFocus={nameRef} className="phase-create-dialog" actions={[{ label: 'Cancel', onClick: onClose }, { label: busy ? 'Creating…' : 'Create phase', variant: 'primary', disabled: busy, onClick: () => { void submit(); } }]}>
    <div className="phase-dialog-fields">
      <div className="phase-dialog-row">
        <div className="role-dialog-field"><label htmlFor={`${uid}-name`}>Phase name</label><input id={`${uid}-name`} ref={nameRef} value={name} maxLength={80} disabled={busy} aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? `${uid}-name-error` : undefined} onChange={e => { const value=e.target.value; setName(value); if (!editedSlug) setSlug(phaseSlug(value)); }} />{nameError && <p className="role-dialog-field-error" id={`${uid}-name-error`} role="alert">{nameError}</p>}</div>
        <div className="role-dialog-field"><label htmlFor={`${uid}-slug`}>Phase ID / slug</label><input id={`${uid}-slug`} value={slug} maxLength={64} disabled={busy} aria-invalid={slugError ? true : undefined} aria-describedby={`${uid}-slug-hint${slugError ? ` ${uid}-slug-error` : ''}`} onChange={e => { setEditedSlug(true); setSlug(e.target.value); }} /><p className="role-dialog-hint" id={`${uid}-slug-hint`}>Stable ID used by CLI and configuration.</p>{slugError && <p className="role-dialog-field-error" id={`${uid}-slug-error`} role="alert">{slugError}</p>}</div>
      </div>
      <div className="role-dialog-field"><label htmlFor={`${uid}-description`}>Description <span className="role-dialog-optional">(optional)</span></label><textarea id={`${uid}-description`} rows={4} value={description} maxLength={2000} disabled={busy} onChange={e => setDescription(e.target.value)} /></div>
      <div className="role-dialog-field"><label htmlFor={`${uid}-before`}>Place before</label><select id={`${uid}-before`} value={before} disabled={busy} onChange={e => setBefore(e.target.value)}><option value="">At end</option>{existing.map(p => <option key={p.slug} value={p.slug}>{p.name}</option>)}</select><p className="role-dialog-hint">Choose where this phase appears in the board.</p></div>
    </div>
    {error && <div className="role-dialog-error" role="alert">{error} <button type="button" disabled={busy} onClick={() => { void submit(); }}>Retry</button></div>}
  </Dialog>;
}

function normalizeCreatedPhase(value: unknown, slug: string, name: string, description: string, phases: import('../api').BoardPhase[], before: string): import('../api').BoardPhase | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.slug === 'string' && raw.slug !== slug) return null;
  const counts = raw.counts && typeof raw.counts === 'object' && !Array.isArray(raw.counts)
    ? Object.fromEntries(Object.entries(raw.counts).filter(([, count]) => typeof count === 'number' && Number.isFinite(count))) as Record<string, number>
    : {};
  return {
    id: typeof raw.id === 'string' ? raw.id : null, slug, name: typeof raw.name === 'string' ? raw.name : name,
    description: typeof raw.description === 'string' ? raw.description : description || null,
    position: Number.isInteger(raw.position) ? raw.position as number : before ? phases.find(phase => phase.slug === before)?.position ?? phases.length : phases.length,
    status: raw.status === 'closed' ? 'closed' : 'open', current: false,
    ticketCount: typeof raw.ticketCount === 'number' && Number.isFinite(raw.ticketCount) ? raw.ticketCount : 0,
    counts,
  };
}
