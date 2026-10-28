import { useEffect, useState, type JSX } from 'react';
import type { AgentCatalogList, ManagementApi, TeamOverview, Workspace } from '../api';
import { useDashboardSection, type DashboardSectionController } from '../dashboard/useDashboardSection';
import { agentFilterOptions, agentUsage, catalogRows, filterAgentRows, selectedAgentKey, value } from './agentsModel';

export interface AgentsScreenProps { workspace: Workspace; management: ManagementApi }
export function AgentsScreen(props: AgentsScreenProps): JSX.Element { return <AgentsBrowser key={props.workspace.id} {...props} />; }

function ErrorNote(props: { section: DashboardSectionController<unknown>; label: string }): JSX.Element | null {
  const error = props.section.error;
  if (!error) return null;
  return <div className="panel-error agents-error" role="alert"><p><code>{error.code}</code>: {error.message}</p>{error.remediation && <p>{error.remediation}</p>}<button type="button" onClick={() => void props.section.reload()}>Retry {props.label}</button></div>;
}
function AgentsBrowser(props: AgentsScreenProps): JSX.Element {
  const catalog = useDashboardSection<AgentCatalogList>(props.management.agents, props.workspace.id);
  const overview = useDashboardSection<TeamOverview>(props.management.overview, props.workspace.id);
  const [query, setQuery] = useState(''); const [provider, setProvider] = useState(''); const [reasoning, setReasoning] = useState(''); const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const rows = catalogRows(catalog.data?.agents ?? []);
  const options = agentFilterOptions(rows);
  const visible = filterAgentRows(rows, query, provider, reasoning);
  const keys = visible.map(row => row.key).join(',');
  useEffect(() => { setSelectedKey(current => selectedAgentKey(visible, current)); }, [keys]);
  const selected = visible.find(row => row.key === selectedAgentKey(visible, selectedKey));
  const usage = (id: string | null) => overview.loading ? 'Loading usage…' : agentUsage(overview.data, id).summary;
  const detailsUsage = selected ? agentUsage(overview.data, selected.agent.id) : null;
  return <div className="agents-screen" data-section="agents">
    <header className="dashboard-header agents-header"><div><nav aria-label="Breadcrumb" className="breadcrumb"><ol><li>Workspace</li><li aria-current="page">Agents</li></ol></nav><h1>Agents</h1><p>Browse reusable agent configurations saved in this workspace.</p></div></header>
    {catalog.loading && <p role="status">Loading agent catalog…</p>}
    <ErrorNote section={catalog} label="catalog" />
    <ErrorNote section={overview} label="usage" />
    {catalog.state === 'ready' && catalog.data && <>
      {catalog.data.problems.length > 0 && <div className="panel-note agents-problems"><p>agents.json has problems:</p><ul>{catalog.data.problems.slice(0, 5).map((p, i) => <li key={i}>{p.path}: {p.message}</li>)}</ul>{catalog.data.problems.length > 5 && <p>…and {catalog.data.problems.length - 5} more {catalog.data.problems.length - 5 === 1 ? 'problem' : 'problems'}</p>}</div>}
      <div className="agents-filters"><input type="search" aria-label="Search agents" placeholder="Search agents…" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="Provider" value={provider} onChange={e => setProvider(e.target.value)}><option value="">All providers</option>{options.providers.map(p => <option key={p}>{p}</option>)}</select><select aria-label="Reasoning" value={reasoning} onChange={e => setReasoning(e.target.value)}><option value="">All reasoning</option>{options.reasoningLevels.map(r => <option key={r}>{r}</option>)}</select></div>
      <p className="agents-count">{visible.length} {visible.length === 1 ? 'agent' : 'agents'}</p>
      {rows.length === 0 ? <p>No reusable agents are defined in this workspace.</p> : visible.length === 0 ? <p>No agents match the current search and filters.</p> : <div className="agents-layout">
        <ul className="agents-list" aria-label="Saved agents">{visible.map(row => <li key={row.key}><button type="button" className="agents-row" aria-pressed={selected?.key === row.key} onClick={() => setSelectedKey(row.key)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedKey(row.key); } }}><strong>{value(row.agent.name) ?? 'Unnamed agent'}</strong><span>{value(row.agent.provider) ?? 'Provider unavailable'}</span><span>{value(row.agent.model) ?? 'Model not set'}</span><span>{value(row.agent.reasoning) ?? 'Reasoning not set'}</span><span>{usage(row.agent.id)}</span></button></li>)}</ul>
        {selected && detailsUsage && <section className="dashboard-panel agents-details"><h2>Agent details</h2><h3>{value(selected.agent.name) ?? 'Unnamed agent'}</h3><p>{value(selected.agent.id) ?? 'ID unavailable'}</p><p>{value(selected.agent.description) ?? 'No description'}</p><p>{value(selected.agent.provider) ?? 'Provider unavailable'} · {value(selected.agent.model) ?? 'Model not set'} · {value(selected.agent.reasoning) ?? 'Reasoning not set'}</p><h3>Used by</h3><p>{usage(selected.agent.id)}</p>{detailsUsage.references.length > 0 && <ul className="agents-references">{detailsUsage.references.map((ref, i) => <li key={i}>{ref.teamLabel} — {ref.memberLabel}{ref.role ? ` (${ref.role})` : ''}</li>)}</ul>}<p>Saved configuration only. Changes do not switch a running team member; live agent controls remain in Teams.</p></section>}
      </div>}
    </>}
  </div>;
}
