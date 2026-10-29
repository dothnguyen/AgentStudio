import { useEffect, useRef, useState, type JSX } from 'react';
import { flushSync } from 'react-dom';
import type { AgentCatalogList, AgentDef, ConnectionStatus, ManagementApi, ManagementError, TeamOverview, Workspace } from '../api';
import { useDashboardSection, type DashboardSectionController } from '../dashboard/useDashboardSection';
import { AgentDeleteDialog } from './AgentDeleteDialog';
import { AgentForm } from './AgentForm';
import type { AgentFormMode, AgentFormRequest } from './agentFormModel';
import { agentFilterOptions, agentUsage, agentInUseTeamIds, savedAgentUsage, selectionAfterRemoval, catalogRows, filterAgentRows, selectedAgentKey, value } from './agentsModel';

export interface AgentsScreenProps { workspace: Workspace; management: ManagementApi; connection?: ConnectionStatus }
export function AgentsScreen(props: AgentsScreenProps): JSX.Element { return <AgentsBrowser key={props.workspace.id} {...props} />; }

function ErrorNote(props: { section: DashboardSectionController<unknown>; label: string; onRetry(): void }): JSX.Element | null {
  const error = props.section.error;
  if (!error) return null;
  return <div className="panel-error agents-error" role="alert"><p><code>{error.code}</code>: {error.message}</p>{error.remediation && <p>{error.remediation}</p>}<button type="button" onClick={props.onRetry}>Retry loading {props.label}</button></div>;
}
function AgentsBrowser(props: AgentsScreenProps): JSX.Element {
  const catalog = useDashboardSection<AgentCatalogList>(props.management.agents, props.workspace.id);
  const displayedCatalog = catalog.data;
  const overview = useDashboardSection<TeamOverview>(props.management.overview, props.workspace.id);
  const connected = !props.connection || props.connection.state === 'connected';
  const previousConnection = useRef(props.connection?.state);
  const refreshLock = useRef(0);
  const [refreshingConnection, setRefreshingConnection] = useState(false);
  useEffect(() => {
    const previous = previousConnection.current;
    previousConnection.current = props.connection?.state;
    if ((previous === 'lost' || previous === 'connecting') && props.connection?.state === 'connected') {
      refreshLock.current += 1;
      setRefreshingConnection(true);
      void Promise.all([catalog.reload(), overview.reload()]).finally(() => { refreshLock.current -= 1; if (refreshLock.current === 0) setRefreshingConnection(false); });
    }
  }, [props.connection?.state, catalog.reload, overview.reload]);
  useEffect(() => { if (catalog.state === 'error') setForm(null); }, [catalog.state]);
  const catalogHeading = useRef<HTMLHeadingElement>(null); const usageHeading = useRef<HTMLHeadingElement>(null); const search = useRef<HTMLInputElement>(null);
  const retryCatalog = useRef(false); const retryUsage = useRef(false); const focusSelection = useRef(false);
  useEffect(() => { if (catalog.state === 'ready' && retryCatalog.current) { retryCatalog.current = false; focusSelection.current = false; catalogHeading.current?.focus(); } }, [catalog.state]);
  useEffect(() => { if (overview.state === 'ready' && retryUsage.current) { retryUsage.current = false; usageHeading.current?.focus(); } }, [overview.state]);
  const [query, setQuery] = useState(''); const [provider, setProvider] = useState(''); const [reasoning, setReasoning] = useState(''); const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [form, setForm] = useState<{ mode: AgentFormMode; source: AgentDef | null; key: number; existingIds: string[]; providers: AgentCatalogList['editorOptions']['providers'] } | null>(null);
  const [pending, setPending] = useState(false); const [serverError, setServerError] = useState<ManagementError | null>(null); const [success, setSuccess] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<AgentDef | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<ManagementError | null>(null);
  const [deleteAlert, setDeleteAlert] = useState<ManagementError | null>(null);
  const deleteInFlight = useRef(false);
  const writeLock = useRef(false); const mounted = useRef(true); const opener = useRef<HTMLElement | null>(null); const formKey = useRef(0);
  const savedSelection = useRef<string | null>(null);
  const deferredOpener = useRef<{ element: HTMLElement; label: string; fallback: HTMLElement | null } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const blocked = displayedCatalog?.problems.length ? 'Saved agent changes are unavailable because agents.json has validation problems. Repair it on disk and refresh.' : null;
  const unavailable = !catalog.data ? 'Saved agent changes are unavailable until the catalog has refreshed successfully.' : null;
  const connectionReason = !connected ? (props.connection?.state === 'lost' ? 'Connection to the backend was lost. Saved agents can be inspected, but changes are disabled until it reconnects.' : 'Connecting to the backend… Saved agents can be inspected, but changes are disabled.') : null;
  const mutationBlock = connectionReason ?? blocked ?? unavailable;
  const openForm = (mode: AgentFormMode, source: AgentDef | null) => { if (writeLock.current || deleteInFlight.current || mutationBlock) return; opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setServerError(null); setForm({ mode, source, key: ++formKey.current, existingIds: displayedCatalog!.agents.map(a => a.id), providers: displayedCatalog!.editorOptions?.providers ?? [] }); };
  const restoreOpener = (label: string) => { const element = opener.current; requestAnimationFrame(() => { const button = element?.isConnected ? element : [...document.querySelectorAll<HTMLButtonElement>('.agents-screen button')].find(item => item.textContent === label); if (button instanceof HTMLButtonElement && button.disabled) { const fallback = search.current; fallback?.focus(); deferredOpener.current = { element: button, label, fallback }; } else if (button) button.focus(); else { search.current?.focus(); if (element) deferredOpener.current = { element, label, fallback: search.current }; } }); };
  const cancel = () => { const mode = form?.mode; setForm(null); restoreOpener(mode === 'edit' ? 'Edit' : mode === 'duplicate' ? 'Duplicate' : 'New agent'); };
  useEffect(() => {
    const target = deferredOpener.current;
    if (!target || mutationBlock || pending || deletePending || refreshLock.current || refreshingConnection) return;
    const button = target.element.isConnected ? target.element : [...document.querySelectorAll<HTMLButtonElement>('.agents-screen button')].find(item => item.textContent === target.label);
    if (button instanceof HTMLButtonElement && !button.disabled) {
      deferredOpener.current = null;
      if (document.activeElement === target.fallback || document.activeElement === document.body) button.focus();
    }
  });
  const submit = async (request: AgentFormRequest) => {
    if (writeLock.current || mutationBlock || !form) return;
    writeLock.current = true; setPending(true); setServerError(null);
    let result;
    try { result = request.kind === 'create' ? await props.management.createAgent(props.workspace.id, request.input) : await props.management.updateAgent(props.workspace.id, request.agentId, request.changes); }
    catch (reason) { result = { ok: false as const, error: { code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false } }; }
    writeLock.current = false; if (!mounted.current) return; setPending(false);
    if (!result.ok) { setServerError(result.error); return; }
    const agent = result.data.agent; savedSelection.current = agent.id; focusSelection.current = true; setQuery(''); setProvider(''); setReasoning(''); setForm(null);
    const verb = form.mode === 'create' ? 'Created saved agent' : form.mode === 'edit' ? 'Saved agent' : 'Created saved duplicate';
    setSuccess(`${verb} "${agent.name}" (${agent.id}). Saved configuration applies on the next team start; running agents are unchanged. Live switching remains in Teams.`);
    await catalog.reloadFresh?.();
  };
  const rows = catalogRows(displayedCatalog?.agents ?? []);
  const options = agentFilterOptions(rows);
  const visible = filterAgentRows(rows, query, provider, reasoning);
  const keys = visible.map(row => row.key).join(',');
  useEffect(() => { if (catalog.data) setSelectedKey(current => selectedAgentKey(visible, current)); }, [keys, catalog.data]);
  useEffect(() => {
    if (!catalog.data || (savedSelection.current === null && !focusSelection.current)) return;
    const match = filterAgentRows(catalogRows(catalog.data.agents), query, provider, reasoning).find(row => row.agent.id === savedSelection.current);
    setSelectedKey(match?.key ?? null);
    savedSelection.current = null;
    if (focusSelection.current) { focusSelection.current = false; requestAnimationFrame(() => { const button = document.querySelector<HTMLButtonElement>('.agents-row[aria-current="true"]'); (button ?? document.querySelector<HTMLButtonElement>('.agents-new'))?.focus(); }); }
  }, [catalog.data]);
  const selected = visible.find(row => row.key === selectedAgentKey(visible, selectedKey));
  const usage = (id: string | null) => overview.loading ? 'Usage loading'  : agentUsage(overview.data, id).summary;
  const confirmDelete = async () => {
    if (!deleteTarget || deleteInFlight.current || writeLock.current || mutationBlock) return;
    deleteInFlight.current = true; setDeletePending(true); setDeleteError(null);
    const target = deleteTarget;
    const fallback = selectionAfterRemoval(visible.map(row => row.agent.id), target.id);
    try {
      let result;
      try { result = await props.management.deleteAgent(props.workspace.id, target.id); }
      catch (reason) { result = { ok: false as const, error: { code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false } }; }
      if (!mounted.current) return;
      if (result.ok) {
        setDeleteTarget(null); setDeleteAlert(null);
        savedSelection.current = fallback; focusSelection.current = true;
        setSelectedKey(visible.find(row => row.agent.id === fallback)?.key ?? null);
        setSuccess(`Deleted only the saved agent definition "${value(target.name) ?? target.id}" (${target.id}). Team membership and live runtime were not changed.`);
        await Promise.all([catalog.reloadFresh?.() ?? catalog.reload(), overview.reloadFresh?.() ?? overview.reload()]);
      } else if (result.error.code === 'AGENT_IN_USE') {
        flushSync(() => { setDeletePending(false); });
        flushSync(() => { setDeleteTarget(null); setDeleteAlert(result.error); setSuccess(''); });
        await (overview.reloadFresh?.() ?? overview.reload());
      } else setDeleteError(result.error);
    } finally { deleteInFlight.current = false; if (mounted.current) setDeletePending(false); }
  };
  const savedUsage = selected ? savedAgentUsage(overview.data, selected.agent.id) : null;
  const detailsUsage = selected ? agentUsage(overview.data, selected.agent.id) : null;
  return <div className="agents-screen" data-section="agents">
    <header className="dashboard-header agents-header"><div><nav aria-label="Breadcrumb" className="breadcrumb"><ol><li>Workspace</li><li aria-current="page">Agents</li></ol></nav><h1>Agents</h1><p>Browse reusable agent configurations saved in this workspace.</p></div><button className="agents-new" type="button" disabled={!!mutationBlock || pending || deletePending} aria-describedby={connectionReason ? "agents-connection" : blocked ? "agents-blocked" : undefined} onClick={() => openForm('create', null)}>New agent</button></header>
    {connectionReason && <p id="agents-connection" role="status">{connectionReason}</p>}
    {blocked && <p id="agents-blocked" className="panel-note">{blocked}</p>}
    {success && <div role="status" className="panel-note">{success} <button type="button" onClick={() => setSuccess('')}>Dismiss</button></div>}
    {!form && serverError && <div role="alert" className="panel-error agents-error"><p><code>{serverError.code}</code>: {serverError.message}</p>{serverError.remediation && <p>{serverError.remediation}</p>}</div>}
    {deleteAlert && <div role="alert" className="panel-error agents-error"><p><code>{deleteAlert.code}</code>: {deleteAlert.message}</p>{deleteAlert.remediation?.trim() && <p>{deleteAlert.remediation}</p>}{agentInUseTeamIds(deleteAlert).length > 0 && <p>Referenced by backend team ids: {agentInUseTeamIds(deleteAlert).join(', ')}.</p>}</div>}
    {catalog.loading && <p role="status">Loading saved agents…</p>}
    <ErrorNote section={catalog} label="agents" onRetry={() => { retryCatalog.current = true; void catalog.reload(); }} />
    {displayedCatalog && <>
      {displayedCatalog.problems.length > 0 && <div role="alert" className="panel-note agents-problems"><p>Agent catalog has configuration problems.</p><ul>{displayedCatalog.problems.map((p, i) => <li key={i}>{p.path}: {p.message}</li>)}</ul><p>Repair .agent-studio/agents.json before making changes.</p></div>}
      <h2 tabIndex={-1} ref={catalogHeading}>Agent catalog</h2>
      <div className="agents-filters"><label>Search agents<input ref={search} type="search" placeholder="Search agents…" value={query} onChange={e => setQuery(e.target.value)} /></label><label>Provider<select value={provider} onChange={e => setProvider(e.target.value)}><option value="">All providers</option>{options.providers.map(p => <option key={p}>{p}</option>)}</select></label><label>Reasoning<select value={reasoning} onChange={e => setReasoning(e.target.value)}><option value="">All reasoning</option>{options.reasoningLevels.map(r => <option key={r}>{r}</option>)}</select></label></div>
      <p className="agents-count">{visible.length} {visible.length === 1 ? 'agent' : 'agents'}</p>
      {rows.length === 0 && !displayedCatalog.problems.length && <p>No saved agents yet.</p>}{rows.length > 0 && visible.length === 0 && <p>No agents match these filters. <button type="button" onClick={() => { setQuery(''); setProvider(''); setReasoning(''); search.current?.focus(); }}>Clear filters</button></p>}<div className="agents-layout">
        <ul className="agents-list" aria-label="Saved agents">{visible.map(row => <li key={row.key}><button type="button" className="agents-row" aria-pressed={selected?.key === row.key} aria-current={selected?.key === row.key ? "true" : undefined} onClick={() => setSelectedKey(row.key)}><strong>{value(row.agent.name) ?? 'Unnamed agent'}</strong><span>{value(row.agent.provider) ?? 'Provider unavailable'}</span><span>{value(row.agent.model) ?? 'Model not set'}</span><span>{value(row.agent.reasoning) ?? 'Reasoning not set'}</span><span>{usage(row.agent.id)}</span></button></li>)}</ul>
          {selected && detailsUsage && <section className="dashboard-panel agents-details"><h2>Agent details</h2><div className="agent-form-actions"><button type="button" disabled={!!mutationBlock || pending || deletePending} aria-describedby={connectionReason ? 'agents-connection' : blocked ? 'agents-blocked' : undefined} onClick={() => openForm('edit', selected.agent)}>Edit</button><button type="button" disabled={!!mutationBlock || pending || deletePending} aria-describedby={connectionReason ? 'agents-connection' : blocked ? 'agents-blocked' : undefined} onClick={() => openForm('duplicate', selected.agent)}>Duplicate</button><button type="button" disabled={!!mutationBlock || pending || deletePending || !!savedUsage?.references.length} aria-describedby={connectionReason ? 'agents-connection' : savedUsage?.references.length ? 'agents-delete-referenced' : blocked ? 'agents-blocked' : undefined} onClick={() => { if (deleteInFlight.current || writeLock.current || mutationBlock || savedUsage?.references.length) return; opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setDeleteError(null); setDeleteTarget(selected.agent); }}>Delete</button></div>{!!savedUsage?.references.length && <p id="agents-delete-referenced">Remove this saved agent from the listed team members in Teams before deleting it.</p>}<h3>{value(selected.agent.name) ?? 'Unnamed agent'}</h3><p>{value(selected.agent.id) ?? 'ID unavailable'}</p><p>{value(selected.agent.description) ?? 'No description'}</p><p>{value(selected.agent.provider) ?? 'Provider unavailable'} · {value(selected.agent.model) ?? 'Model not set'} · {value(selected.agent.reasoning) ?? 'Reasoning not set'}</p><h3 tabIndex={-1} ref={usageHeading}>Used by</h3>{overview.loading ? <p role="status">Loading saved usage…</p> : overview.error ? <><p>Usage unavailable.</p><ErrorNote section={overview} label="usage" onRetry={() => { retryUsage.current = true; void overview.reload(); }} /></> : savedUsage && (savedUsage.references.length ? <>{savedUsage.completeness === 'truncated' && <p>Saved references may be incomplete. The backend will verify deletion.</p>}<ul className="agents-references">{savedUsage.references.map((ref, i) => <li key={i}>{ref.teamName ?? ref.teamId ?? 'Unknown team'}{ref.teamName && ref.teamId && ref.teamName !== ref.teamId && <> (<code>{ref.teamId}</code>)</>} — {ref.memberName ?? ref.memberId ?? 'Unknown member'}{ref.memberName && ref.memberId && ref.memberName !== ref.memberId && <> (<code>{ref.memberId}</code>)</>}</li>)}</ul></> : <p>{savedUsage.completeness === 'complete' ? 'No saved team references found.' : savedUsage.completeness === 'truncated' ? 'Saved references may be incomplete. The backend will verify deletion.' : 'Saved reference usage is unavailable. The backend will verify deletion.'}</p>)}<p>Saved configuration only. Changes do not switch a running team member; live agent controls remain in Teams.</p></section>}
      </div>
    </>}
    {form && catalog.state !== 'error' && <div className="modal-overlay"><AgentForm key={form.key} mode={form.mode} source={form.source} existingIds={displayedCatalog?.agents.map(a => a.id) ?? form.existingIds} providers={displayedCatalog?.editorOptions?.providers ?? form.providers} pending={pending} serverError={serverError} mutationsBlockedReason={mutationBlock} onSubmit={request => void submit(request)} onCancel={cancel} /></div>}
    {deleteTarget && <AgentDeleteDialog agent={deleteTarget} pending={deletePending} blockedReason={mutationBlock} error={deleteError} onCancel={() => { if (!deleteInFlight.current) { setDeleteTarget(null); restoreOpener('Delete'); } }} onConfirm={() => void confirmDelete()} />}
  </div>;
}
