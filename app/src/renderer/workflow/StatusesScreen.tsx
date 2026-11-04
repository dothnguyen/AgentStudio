import { useState, type JSX } from 'react';
import type { BoardStatuses, ManagementApi, Workspace } from '../api';
import { useDashboardSection } from '../dashboard/useDashboardSection';
import { SectionError } from '../teams/SectionError';
import { filterStatuses, statusCounts, statusPresentation } from './statusesModel';

export function StatusesScreen({ workspace, management }: { workspace: Workspace; management: ManagementApi }): JSX.Element {
  const section = useDashboardSection<BoardStatuses>(management.boardStatuses, workspace.id);
  const [query, setQuery] = useState('');
  const [unusedOnly, setUnusedOnly] = useState(false);
  const statuses = section.data?.statuses;
  const counts = statuses ? statusCounts(statuses) : null;
  const filtered = statuses ? filterStatuses(statuses, query, unusedOnly) : [];
  return <div className="statuses-screen" data-section="workflow/statuses">
    <header className="statuses-header"><div><h1>Statuses</h1><p>Every status a ticket can be in on this board. Each workflow in Routing picks two: the status that starts it, and the status while it runs.</p></div><button type="button" className="statuses-add">+ Add status</button></header>
    {section.loading && <p className="panel-loading" role="status">Loading statuses…</p>}
    <SectionError section={section} label="Statuses" />
    {statuses && counts && <>
      <div className="statuses-summary">
        {([['Starts a workflow', counts.starts, 'A ticket waits here to be picked up', 'blue'], ['While running', counts.running, 'A workflow is working the ticket', 'amber'], ['Start, Done, Closed', counts.protected, 'Always exist; rename only', 'green'], ['Not used', counts.unused, 'No workflow uses it; set by hand', 'muted']] as const).map(([label, count, description, tone]) => <div className="statuses-card" key={label}><div><span className={`statuses-dot ${tone}`} />{label}</div><strong>{count}</strong><small>{description}</small></div>)}
      </div>
      <section className="statuses-panel" aria-label="Statuses table">
        <div className="statuses-toolbar"><h2>Statuses</h2><div><input aria-label="Filter by name or id" placeholder="Filter by name or id" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="Status usage" value={unusedOnly ? 'unused' : 'all'} onChange={e => setUnusedOnly(e.target.value === 'unused')}><option value="all">All statuses</option><option value="unused">Not used by any workflow</option></select></div></div>
        {filtered.length === 0 ? <p className="statuses-empty">{statuses.length === 0 ? 'No statuses found.' : 'No statuses match your filters.'}</p> : <div className="statuses-table-scroll"><table><thead><tr><th>Name</th><th>ID</th><th>Type</th><th>Used by</th><th>Board column</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{filtered.map(status => {
          const presentation = statusPresentation[status.type];
          const blocked = status.kind !== null || status.usedBy.length > 0 || status.ticketCount > 0;
          const users = [...new Set(status.usedBy.map(use => use.title || use.workflow))];
          return <tr key={status.id}><td><span className={`statuses-dot ${presentation.tone}`} /><strong>{status.name || status.id}</strong>{(status.hasName === false || !status.name) && <span className="statuses-name-tag">needs a name</span>}</td><td className="statuses-id">{status.id}</td><td><span className={`statuses-chip ${presentation.tone}`}>{presentation.label}</span></td><td>{users.length ? users.join(', ') : status.type === 'start' ? 'Where new tickets wait' : status.type === 'closed' ? 'Set by a person' : '—'}</td><td>{presentation.column}</td><td className="statuses-actions"><button type="button">Rename</button><span title={blocked ? 'A status used by a workflow or ticket, or a protected status, cannot be removed.' : undefined}><button type="button" disabled={blocked}>Remove</button></span></td></tr>;
        })}</tbody></table></div>}
        <p className="statuses-footer">A status used by a workflow, or by any ticket, cannot be removed. Start, Done and Closed always exist; rename them instead.</p>
      </section>
    </>}
  </div>;
}
