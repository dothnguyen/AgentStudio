import { useState, type JSX } from 'react';
import type { BoardStatuses, BoardWorkflows, ManagementApi, Workspace } from '../api';
import { useDashboardSection } from '../dashboard/useDashboardSection';
import { SectionError } from '../teams/SectionError';

export interface WorkflowDraft {
  key: string;
  mode: 'add-workflow' | 'edit-workflow';
  name: string;
  definition: Record<string, unknown>;
  sha256: string | null;
}

export function WorkflowList({ workspace, management, onAdd, onEdit }: { workspace: Workspace; management: ManagementApi; onAdd(): void; onEdit(name: string): void }): JSX.Element {
  const section = useDashboardSection<BoardWorkflows>(management.boardWorkflows, workspace.id);
  return <section className="statuses-panel" aria-label="Workflows"><h2>Workflows</h2>
    <button type="button" onClick={onAdd}>+ Add workflow</button>
    <SectionError section={section} label="Workflows" />
    {section.loading && <p role="status">Loading workflows…</p>}
    {section.data?.workflows.map(workflow => <div key={workflow.name}>{workflow.title || workflow.name} <button type="button" onClick={() => onEdit(workflow.name)}>Edit {workflow.title || workflow.name}</button></div>)}
  </section>;
}

export function WorkflowEditor({ workspace, management, draft, onChange, onStatuses, onClose }: { workspace: Workspace; management: ManagementApi; draft: WorkflowDraft; onChange(draft: WorkflowDraft): void; onStatuses(): void; onClose(): void }): JSX.Element {
  const statuses = useDashboardSection<BoardStatuses>(management.boardStatuses, workspace.id);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  function field(key: string, value: string) { onChange({ ...draft, definition: { ...draft.definition, [key]: value } }); }
  const end = typeof draft.definition.end === 'object' && draft.definition.end !== null && !Array.isArray(draft.definition.end) ? draft.definition.end as Record<string, unknown> : {};
  function endStatus(key: 'pass' | 'fail'): string {
    const value = end[key];
    return typeof value === 'string' ? value : typeof value === 'object' && value !== null && 'status' in value ? String(value.status) : '';
  }
  function setEndStatus(key: 'pass' | 'fail', value: string) {
    const previous = end[key];
    const next = typeof previous === 'object' && previous !== null && !Array.isArray(previous) ? { ...previous, status: value } : value;
    onChange({ ...draft, definition: { ...draft.definition, end: { ...end, [key]: next } } });
  }
  async function save() {
    setPending(true); setError('');
    try {
      const result = await management.saveBoardWorkflow(workspace.id, { name: draft.name.trim(), definition: draft.definition, expectedSha256: draft.sha256 });
      if (result.ok) onClose(); else setError(result.error.message);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPending(false); }
  }
  return <div className="statuses-screen" data-section="workflow/editor">
    <h1>{draft.mode === 'add-workflow' ? 'Add workflow' : 'Edit workflow'}</h1>
    <div className="status-dialog-fields">
      <label>Workflow ID<input value={draft.name} disabled={draft.mode === 'edit-workflow'} onChange={e => onChange({ ...draft, name: e.target.value })} /></label>
      <label>Name<input value={String(draft.definition.title ?? '')} onChange={e => field('title', e.target.value)} /></label>
      <SectionError section={statuses} label="Statuses" />
      {(['startsAt', 'whileRunning'] as const).map((key, index) => <label key={key}>{index === 0 ? 'Starts at' : 'While running'}<select value={String(draft.definition[key] ?? '')} onChange={e => field(key, e.target.value)}><option value="">Choose a status</option>{statuses.data?.statuses.map(status => <option key={status.id} value={status.id}>{status.name || status.id}</option>)}</select></label>)}
      {(['pass', 'fail'] as const).map(key => <label key={key}>{key === 'pass' ? 'On pass' : 'On fail'}<select value={endStatus(key)} onChange={e => setEndStatus(key, e.target.value)}><option value="">Choose a status</option>{statuses.data?.statuses.map(status => <option key={status.id} value={status.id}>{status.name || status.id}</option>)}</select></label>)}
      <button type="button" onClick={onStatuses}>Manage statuses</button>
      <label>Role<input value={String(draft.definition.role ?? '')} onChange={e => field('role', e.target.value)} /></label>
      {error && <p role="alert">{error}</p>}
      <div><button type="button" disabled={pending} onClick={onClose}>Cancel</button> <button type="button" disabled={pending || !draft.name.trim()} onClick={() => void save()}>Save workflow</button></div>
    </div>
  </div>;
}
