import { useRef, useState, type JSX } from 'react';
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
          board.data?.phases.phases.length === 0 ? <section className="boards-state-card"><h2>No phases yet</h2></section> :
            <div className="boards-milestone-list">{board.data && [...board.data.phases.phases]
              .sort((a, b) => Number(b.current) - Number(a.current) || Number(a.status === 'closed') - Number(b.status === 'closed') || a.position - b.position)
              .map(phase => <PhaseCard key={phase.slug} phase={phase} statuses={board.data!.settings.statuses} onViewTickets={onViewTickets} onOpenBoard={onOpenBoard} />)}</div>}
      {creating && board.data && <NewPhaseDialog workspaceId={workspace.id} management={management} phases={board.data.phases.phases} onClose={() => { setCreating(false); requestAnimationFrame(() => addButton.current?.focus()); }} onCreated={phase => { board.reconcileCreated(phase); setCreating(false); requestAnimationFrame(() => addButton.current?.focus()); }} />}
    </div>
  );
}

function NewPhaseDialog({ workspaceId, management, phases, onClose, onCreated }: { workspaceId: string; management: ManagementApi; phases: import('../api').BoardPhase[]; onClose(): void; onCreated(phase: import('../api').BoardPhase): void }): JSX.Element {
  const [name, setName] = useState(''); const [slug, setSlug] = useState(''); const [editedSlug, setEditedSlug] = useState(false);
  const [description, setDescription] = useState(''); const [before, setBefore] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState(''); const [slugError, setSlugError] = useState(''); const flight = useRef(false); const nameRef = useRef<HTMLInputElement>(null);
  async function submit(): Promise<void> {
    if (flight.current) return;
    const cleanName = name.trim(); const cleanSlug = slug.trim();
    setNameError(cleanName ? '' : 'Phase name is required.');
    setSlugError(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(cleanSlug) ? 'Use a lowercase slug with letters, digits, or hyphens (up to 64 characters).' : phases.some(p => p.slug === cleanSlug) ? 'This phase ID already exists.' : '');
    if (!cleanName || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(cleanSlug) || phases.some(p => p.slug === cleanSlug)) return;
    flight.current = true; setBusy(true); setError('');
    try {
      const result = await management.createPhase(workspaceId, { id: cleanSlug, name: cleanName, ...(description.trim() ? { description: description.trim() } : {}), ...(before ? { before } : {}) });
      if (result.ok) onCreated(result.data.phase); else setError(`${result.error.message}${result.error.remediation ? ` ${result.error.remediation}` : ''}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { flight.current = false; setBusy(false); }
  }
  const existing = [...phases].sort((a,b) => a.position-b.position);
  return <Dialog title="New phase" subtitle="Add a phase to this board." onClose={onClose} busy={busy} initialFocus={nameRef} actions={[{ label: 'Cancel', onClick: onClose }, { label: 'Create phase', variant: 'primary', disabled: busy, onClick: () => { void submit(); } }]}>
    <label>Phase name<input ref={nameRef} value={name} maxLength={80} onChange={e => { const value=e.target.value; setName(value); if (!editedSlug) setSlug(phaseSlug(value)); }} aria-invalid={Boolean(nameError)} /></label>{nameError && <p role="alert">{nameError}</p>}
    <label>Phase ID / slug <span>(stable CLI/config ID)</span><input value={slug} maxLength={64} onChange={e => { setEditedSlug(true); setSlug(e.target.value); }} aria-invalid={Boolean(slugError)} /></label>{slugError && <p role="alert">{slugError}</p>}
    <label>Description (optional)<textarea value={description} maxLength={2000} onChange={e => setDescription(e.target.value)} /></label>
    <label>Place before<select value={before} onChange={e => setBefore(e.target.value)}><option value="">At end</option>{existing.map(p => <option key={p.slug} value={p.slug}>{p.name}</option>)}</select></label>
    {error && <div role="alert">{error} <button type="button" disabled={busy} onClick={() => { void submit(); }}>Retry</button></div>}
  </Dialog>;
}
