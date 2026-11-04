import { useState, type JSX } from 'react';
import type { BoardStatuses, ManagementApi, Workspace, ApiError } from '../api';
import { useDashboardSection } from '../dashboard/useDashboardSection';
import { SectionError } from '../teams/SectionError';
import { filterStatuses, statusCounts, statusPresentation, statusIdFromName, statusErrorMessage, validStatusId, type Status } from './statusesModel';
import { Dialog } from '../teams/Dialog';
import type { WorkflowNavigationState } from '../shell/navModel';

export function StatusesScreen({ workspace, management, routeState, onReturn }: { workspace: Workspace; management: ManagementApi; routeState?: WorkflowNavigationState | null; onReturn?: (state: WorkflowNavigationState) => void }): JSX.Element {
  const section = useDashboardSection<BoardStatuses>(management.boardStatuses, workspace.id);
  const [query, setQuery] = useState('');
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [dialog, setDialog] = useState<{ kind: 'add' | 'rename' | 'remove'; status?: Status } | null>(null);
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [kind, setKind] = useState<'none' | 'done'>('none');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [dragged, setDragged] = useState<string | null>(null);
  const statuses = section.data?.statuses;
  function openDialog(kind: 'add' | 'rename' | 'remove', status?: Status) {
    setDialog({ kind, status }); setName(status?.name || status?.id || ''); setId(''); setIdEdited(false); setKind('none'); setError(null); setNotice('');
  }
  async function write(call: () => ReturnType<ManagementApi['removeStatus']>) {
    setPending(true); setError(null);
    try {
      const result = await call();
      if (result.ok) { setDialog(null); await section.reload(); }
      else if (result.error.code === 'CONFIG_CHANGED') { setDialog(null); setNotice('Statuses changed elsewhere - reload'); await section.reload(); }
      else setError(result.error);
    } catch (reason) { setError({ code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false }); }
    finally { setPending(false); }
  }
  function submit() {
    if (!dialog || !section.data) return;
    const expectedSha256 = section.data.sha256;
    if (dialog.kind === 'add') void write(() => management.addStatus(workspace.id, { id: id.trim(), name: name.trim(), kind, expectedSha256 }));
    else if (dialog.status && dialog.kind === 'rename') void write(() => management.renameStatus(workspace.id, { id: dialog.status!.id, name: name.trim(), expectedSha256 }));
    else if (dialog.status) void write(() => management.removeStatus(workspace.id, { id: dialog.status!.id, expectedSha256 }));
  }
  function reorder(target: string) {
    if (!dragged || dragged === target || !statuses || !section.data || pending) return;
    const ids = statuses.map(status => status.id); const from = ids.indexOf(dragged); const to = ids.indexOf(target);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1); ids.splice(to, 0, dragged);
    void write(() => management.reorderStatuses(workspace.id, { ids, expectedSha256: section.data!.sha256 }));
    setDragged(null);
  }
  const counts = statuses ? statusCounts(statuses) : null;
  const filtered = statuses ? filterStatuses(statuses, query, unusedOnly) : [];
  return <div className="statuses-screen" data-section="workflow/statuses">
    {routeState && <div className="statuses-return">You came here from {routeState.returnTo === 'add-workflow' ? 'Add workflow' : 'Edit workflow'}. Your unsaved workflow is kept; new statuses appear in its lists when you go back.<button type="button" className="statuses-add" onClick={() => onReturn?.(routeState)}>← Back to {routeState.returnTo === 'add-workflow' ? 'Add workflow' : 'Edit workflow'}</button></div>}
    {notice && <p role="alert">{notice}</p>}
    {!dialog && error && <p role="alert">{statusErrorMessage(error)}</p>}
    <header className="statuses-header"><div><h1>Statuses</h1><p>Every status a ticket can be in on this board. Each workflow in Routing picks two: the status that starts it, and the status while it runs.</p></div><button type="button" className="statuses-add" disabled={!section.data || pending} onClick={() => openDialog('add')}>+ Add status</button></header>
    {section.loading && <p className="panel-loading" role="status">Loading statuses…</p>}
    <SectionError section={section} label="Statuses" />
    {statuses && counts && <>
      <div className="statuses-summary">
        {([['Starts a workflow', counts.starts, 'A ticket waits here to be picked up', 'blue'], ['While running', counts.running, 'A workflow is working the ticket', 'amber'], ['Start, Done, Closed', counts.protected, 'Always exist; rename only', 'green'], ['Not used', counts.unused, 'No workflow uses it; set by hand', 'muted']] as const).map(([label, count, description, tone]) => <div className="statuses-card" key={label}><div><span className={`statuses-dot ${tone}`} />{label}</div><strong>{count}</strong><small>{description}</small></div>)}
      </div>
      <section className="statuses-panel" aria-label="Statuses table">
        <div className="statuses-toolbar"><h2>Statuses</h2><div><input aria-label="Filter by name or id" placeholder="Filter by name or id" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="Status usage" value={unusedOnly ? 'unused' : 'all'} onChange={e => setUnusedOnly(e.target.value === 'unused')}><option value="all">All statuses</option><option value="unused">Not used by any workflow</option></select></div></div>
        {filtered.length === 0 ? <p className="statuses-empty">{statuses.length === 0 ? 'No statuses found.' : 'No statuses match your filters.'}</p> : <div className="statuses-table-scroll"><table><thead><tr><th><span className="sr-only">Reorder</span></th><th>Name</th><th>ID</th><th>Type</th><th>Used by</th><th>Board column</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{filtered.map(status => {
          const presentation = statusPresentation[status.type];
          const blocked = (status.kind === 'initial' || status.kind === 'closed') || status.usedBy.length > 0 || status.ticketCount > 0;
          const users = [...new Set(status.usedBy.map(use => use.title || use.workflow))];
          return <tr key={status.id} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); reorder(status.id); }}><td><button type="button" className="statuses-drag" aria-label={`Drag ${status.name || status.id} to reorder`} draggable={!pending} onDragStart={e => { e.dataTransfer?.setData('text/plain', status.id); setDragged(status.id); }} onDragEnd={() => setDragged(null)}>⠿</button></td><td><span className={`statuses-dot ${presentation.tone}`} /><strong>{status.name || status.id}</strong>{(status.hasName === false || !status.name) && <span className="statuses-name-tag">needs a name</span>}</td><td className="statuses-id">{status.id}</td><td><span className={`statuses-chip ${presentation.tone}`}>{presentation.label}</span></td><td>{users.length ? users.join(', ') : status.type === 'start' ? 'Where new tickets wait' : status.type === 'closed' ? 'Set by a person' : '—'}</td><td>{presentation.column}</td><td className="statuses-actions"><button type="button" disabled={pending} onClick={() => openDialog('rename', status)}>Rename</button><span title={blocked ? 'A status used by a workflow or ticket, or a protected status, cannot be removed.' : undefined}><button type="button" disabled={blocked || pending} onClick={() => openDialog('remove', status)}>Remove</button></span></td></tr>;
        })}</tbody></table></div>}
        <p className="statuses-footer">A status used by a workflow, or by any ticket, cannot be removed. Start and Closed always exist; rename them instead.</p>
      </section>
    </>}
    {dialog && <Dialog title={dialog.kind === 'add' ? 'Add status' : dialog.kind === 'rename' ? 'Rename status' : 'Remove status'} subtitle={dialog.kind === 'add' ? 'Stages pick their waiting and working statuses from this list.' : undefined} onClose={() => setDialog(null)} busy={pending} actions={[{ label: 'Cancel', onClick: () => setDialog(null), disabled: pending }, { label: dialog.kind === 'add' ? 'Add status' : dialog.kind === 'rename' ? 'Save' : 'Remove status', variant: dialog.kind === 'remove' ? 'danger' : 'primary', disabled: pending || (dialog.kind !== 'remove' && (!name.trim() || (dialog.kind === 'add' && (!validStatusId(id.trim()) || statuses?.some(s => s.id === id.trim()))))), onClick: submit }]}>
      {dialog.kind !== 'remove' ? <div className="status-dialog-fields"><label>Name<input value={name} onChange={e => { setName(e.target.value); if (dialog.kind === 'add' && !idEdited) setId(statusIdFromName(e.target.value)); }} /></label>{dialog.kind === 'add' && <><label>ID<input value={id} onChange={e => { setId(e.target.value); setIdEdited(true); }} /></label><small>Made from the name. Used in the CLI and in board.json; it cannot change after the status is created.</small><fieldset><legend>Type</legend>{([['none', 'Normal', 'A stage can use it as its waiting or working status, or you set it on tickets by hand.'], ['done', 'Done', 'Another way to finish, e.g. Published or Shipped. The ticket goes to the Done column.']] as const).map(([value, label, description]) => <label className={`status-type ${kind === value ? 'selected' : ''}`} key={value}><input type="radio" name="status-kind" checked={kind === value} onChange={() => setKind(value)} /><span>{label}<small>{description}</small></span></label>)}</fieldset><small>The board already has its start status and its closed status; there is only one of each.</small></>}</div> : <p>Remove {dialog.status?.name || dialog.status?.id}?</p>}
      {error && <p role="alert">{statusErrorMessage(error)}</p>}
      {dialog.kind === 'add' && id.trim() && !validStatusId(id.trim()) && <p role="alert">ID must start with a lowercase letter or number and contain only lowercase letters, numbers and hyphens (up to 64 characters); blocked is reserved.</p>}
      {dialog.kind === 'add' && validStatusId(id.trim()) && statuses?.some(s => s.id === id.trim()) && <p role="alert">A status with this ID already exists.</p>}
    </Dialog>}
  </div>;
}
