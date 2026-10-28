import { useEffect, useRef, useState, type JSX } from 'react';
import type { AgentCatalogList, AgentDef, ManagementApi, ManagementError, TeamOverview, Workspace } from '../api';
import { useDashboardSection, type DashboardSectionController } from '../dashboard/useDashboardSection';
import { AgentForm } from './AgentForm';
import type { AgentFormMode, AgentFormRequest } from './agentFormModel';
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
  const lastCatalog = useRef<AgentCatalogList | null>(null);
  if (catalog.data) lastCatalog.current = catalog.data;
  const displayedCatalog = catalog.data ?? lastCatalog.current;
  const overview = useDashboardSection<TeamOverview>(props.management.overview, props.workspace.id);
  const [query, setQuery] = useState(''); const [provider, setProvider] = useState(''); const [reasoning, setReasoning] = useState(''); const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [form, setForm] = useState<{ mode: AgentFormMode; source: AgentDef | null; key: number } | null>(null);
  const [pending, setPending] = useState(false); const [serverError, setServerError] = useState<ManagementError | null>(null); const [success, setSuccess] = useState('');
  const writeLock = useRef(false); const mounted = useRef(true); const opener = useRef<HTMLElement | null>(null); const formKey = useRef(0);
  const savedSelection = useRef<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const blocked = displayedCatalog?.problems.length ? 'Saved agent changes are unavailable because agents.json has validation problems. Repair it on disk and refresh.' : null;
  const unavailable = !catalog.data ? 'Saved agent changes are unavailable until the catalog has refreshed successfully.' : null;
  const mutationBlock = blocked ?? unavailable;
  const openForm = (mode: AgentFormMode, source: AgentDef | null) => { if (writeLock.current || blocked) return; opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setServerError(null); setForm({ mode, source, key: ++formKey.current }); };
  const cancel = () => { if (writeLock.current) return; const mode = form?.mode; setForm(null); requestAnimationFrame(() => { if (opener.current?.isConnected) opener.current.focus(); else { const label = mode === 'edit' ? 'Edit' : mode === 'duplicate' ? 'Duplicate' : 'New agent'; const button = [...document.querySelectorAll<HTMLButtonElement>('.agents-screen button')].find(item => item.textContent === label); button?.focus(); } }); };
  const submit = async (request: AgentFormRequest) => {
    if (writeLock.current || mutationBlock || !form) return;
    writeLock.current = true; setPending(true); setServerError(null);
    let result;
    try { result = request.kind === 'create' ? await props.management.createAgent(props.workspace.id, request.input) : await props.management.updateAgent(props.workspace.id, request.agentId, request.changes); }
    catch (reason) { result = { ok: false as const, error: { code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false } }; }
    writeLock.current = false; if (!mounted.current) return; setPending(false);
    if (!result.ok) { setServerError(result.error); return; }
    const agent = result.data.agent; savedSelection.current = agent.id; setForm(null);
    const verb = form.mode === 'create' ? 'Created saved agent' : form.mode === 'edit' ? 'Saved agent' : 'Created saved duplicate';
    setSuccess(`${verb} "${agent.name}" (${agent.id}). Saved configuration applies on the next team start; running agents are unchanged. Live switching remains in Teams.`);
    await catalog.reloadFresh?.();
  };
  const rows = catalogRows(displayedCatalog?.agents ?? []);
  const options = agentFilterOptions(rows);
  const visible = filterAgentRows(rows, query, provider, reasoning);
  const keys = visible.map(row => row.key).join(',');
  useEffect(() => { setSelectedKey(current => selectedAgentKey(visible, current)); }, [keys]);
  useEffect(() => {
    if (!catalog.data || savedSelection.current === null) return;
    const match = filterAgentRows(catalogRows(catalog.data.agents), query, provider, reasoning).find(row => row.agent.id === savedSelection.current);
    setSelectedKey(match?.key ?? null);
    savedSelection.current = null;
  }, [catalog.data]);
  const selected = visible.find(row => row.key === selectedAgentKey(visible, selectedKey));
  const usage = (id: string | null) => overview.loading ? 'Loading usage…' : agentUsage(overview.data, id).summary;
  const detailsUsage = selected ? agentUsage(overview.data, selected.agent.id) : null;
  return <div className="agents-screen" data-section="agents">
    <header className="dashboard-header agents-header"><div><nav aria-label="Breadcrumb" className="breadcrumb"><ol><li>Workspace</li><li aria-current="page">Agents</li></ol></nav><h1>Agents</h1><p>Browse reusable agent configurations saved in this workspace.</p></div><button type="button" disabled={!!blocked || pending || !catalog.data} aria-describedby={blocked ? "agents-blocked" : undefined} onClick={() => openForm('create', null)}>New agent</button></header>
    {blocked && <p id="agents-blocked" className="panel-note">{blocked}</p>}
    {success && <div role="status" className="panel-note">{success} <button type="button" onClick={() => setSuccess('')}>Dismiss</button></div>}
    {catalog.loading && <p role="status">Loading agent catalog…</p>}
    <ErrorNote section={catalog} label="catalog" />
    <ErrorNote section={overview} label="usage" />
    {displayedCatalog && <>
      {displayedCatalog.problems.length > 0 && <div className="panel-note agents-problems"><p>agents.json has problems:</p><ul>{displayedCatalog.problems.slice(0, 5).map((p, i) => <li key={i}>{p.path}: {p.message}</li>)}</ul>{displayedCatalog.problems.length > 5 && <p>…and {displayedCatalog.problems.length - 5} more {displayedCatalog.problems.length - 5 === 1 ? 'problem' : 'problems'}</p>}</div>}
      <div className="agents-filters"><input type="search" aria-label="Search agents" placeholder="Search agents…" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="Provider" value={provider} onChange={e => setProvider(e.target.value)}><option value="">All providers</option>{options.providers.map(p => <option key={p}>{p}</option>)}</select><select aria-label="Reasoning" value={reasoning} onChange={e => setReasoning(e.target.value)}><option value="">All reasoning</option>{options.reasoningLevels.map(r => <option key={r}>{r}</option>)}</select></div>
      <p className="agents-count">{visible.length} {visible.length === 1 ? 'agent' : 'agents'}</p>
      {rows.length === 0 && <p>No reusable agents are defined in this workspace.</p>}{rows.length > 0 && visible.length === 0 && <p>No agents match the current search and filters.</p>}<div className="agents-layout">
        <ul className="agents-list" aria-label="Saved agents">{visible.map(row => <li key={row.key}><button type="button" className="agents-row" aria-pressed={selected?.key === row.key} onClick={() => setSelectedKey(row.key)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedKey(row.key); } }}><strong>{value(row.agent.name) ?? 'Unnamed agent'}</strong><span>{value(row.agent.provider) ?? 'Provider unavailable'}</span><span>{value(row.agent.model) ?? 'Model not set'}</span><span>{value(row.agent.reasoning) ?? 'Reasoning not set'}</span><span>{usage(row.agent.id)}</span></button></li>)}</ul>
        {form ? <section className="dashboard-panel agents-details"><AgentForm key={form.key} mode={form.mode} source={form.source} existingIds={displayedCatalog.agents.map(a => a.id)} providers={displayedCatalog.editorOptions?.providers ?? []} pending={pending} serverError={serverError} mutationsBlockedReason={mutationBlock} onSubmit={request => void submit(request)} onCancel={cancel} /></section> : selected && detailsUsage && <section className="dashboard-panel agents-details"><h2>Agent details</h2><div className="agent-form-actions"><button type="button" disabled={!!mutationBlock || pending} aria-describedby={blocked ? 'agents-blocked' : undefined} onClick={() => openForm('edit', selected.agent)}>Edit</button><button type="button" disabled={!!mutationBlock || pending} aria-describedby={blocked ? 'agents-blocked' : undefined} onClick={() => openForm('duplicate', selected.agent)}>Duplicate</button></div><h3>{value(selected.agent.name) ?? 'Unnamed agent'}</h3><p>{value(selected.agent.id) ?? 'ID unavailable'}</p><p>{value(selected.agent.description) ?? 'No description'}</p><p>{value(selected.agent.provider) ?? 'Provider unavailable'} · {value(selected.agent.model) ?? 'Model not set'} · {value(selected.agent.reasoning) ?? 'Reasoning not set'}</p><h3>Used by</h3><p>{usage(selected.agent.id)}</p>{detailsUsage.references.length > 0 && <ul className="agents-references">{detailsUsage.references.map((ref, i) => <li key={i}>{ref.teamLabel} — {ref.memberLabel}{ref.role ? ` (${ref.role})` : ''}</li>)}</ul>}<p>Saved configuration only. Changes do not switch a running team member; live agent controls remain in Teams.</p></section>}
      </div>
    </>}
  </div>;
}
