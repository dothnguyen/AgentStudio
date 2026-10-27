import { useRef, useState, type JSX } from 'react';
import type { BoardSettings, ManagementApi, ManagementError, Problem } from '../../shared/management';
import type { DashboardSectionController } from '../dashboard/useDashboardSection';
import { boardSettingsChanges, createRoutingDraft, errorProblems, updateRuleField, validateRoutingDraft, type EditableRuleField, type RoutingDraft } from './routingSettingsModel';

export interface RoutingSettingsPanelProps { workspaceId: string; management: ManagementApi; section: DashboardSectionController<BoardSettings>; connected: boolean }
const modes: Record<string, string> = { '': 'Default', main: 'Main workspace', worktree: 'Isolated worktree', none: 'No workspace' };
const val = (v: unknown) => typeof v === 'string' ? v : '';
export function RoutingSettingsPanel({ workspaceId, management, section, connected }: RoutingSettingsPanelProps): JSX.Element {
  const [draft, setDraft] = useState<RoutingDraft | null>(null);
  const [editSettings, setEditSettings] = useState<BoardSettings | null>(null);
  const [role, setRole] = useState<string | null>(null); const [description, setDescription] = useState('');
  const [pending, setPending] = useState(false); const lock = useRef(false);
  const [error, setError] = useState<ManagementError | null>(null); const [notice, setNotice] = useState('');
  const lastSettings = useRef<BoardSettings | null>(null);
  if (section.data) lastSettings.current = section.data;
  const settings = section.data ?? lastSettings.current;
  const [reloadError, setReloadError] = useState<ManagementError | null>(null);
  const [savedKind, setSavedKind] = useState<'routing' | 'role' | null>(null);
  const canEdit = !!(connected && settings && settings.board.state === 'ok' && settings.roles.state === 'ok' && settings.board.sha256 && settings.roles.sha256 && createRoutingDraft(settings));
  const problems = draft && editSettings ? [...validateRoutingDraft(draft, editSettings), ...(error ? errorProblems(error) : [])] : [];
  function change(index: number, field: EditableRuleField, value: string) { if (draft) setDraft(updateRuleField(draft, index, field, value)); setError(e => e?.code === 'CONFIG_CHANGED' ? e : null); setNotice(''); }
  async function refreshLatest() {
    try {
      if (section.reloadFresh) {
        const result = await section.reloadFresh();
        if (!result.ok) { setReloadError(result.error); return false; }
      } else { await section.reload(); }
      setReloadError(null); return true;
    } catch (reason) {
      setReloadError({ code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false });
      return false;
    }
  }
  async function reload() { if (lock.current) return; lock.current = true; setPending(true); try { if (await refreshLatest()) { setDraft(null); setRole(null); setError(null); setNotice(savedKind ? (savedKind === 'routing' ? 'Routing settings saved.' : 'Role description saved.') : ''); setSavedKind(null); } } catch (reason) { setReloadError({ code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false }); } finally { lock.current = false; setPending(false); } }
  async function save(kind: 'routing' | 'role') {
    if (lock.current || !editSettings || !canEdit || savedKind || error?.code === 'CONFIG_CHANGED') return;
    const snapshot = editSettings;
    if (kind === 'routing' && (!draft || validateRoutingDraft(draft, snapshot).length)) return;
    const changes = draft ? boardSettingsChanges(draft, snapshot) : null;
    const normalized = description.trim() || null;
    if (kind === 'routing' && !changes) { setNotice('No routing changes to save.'); return; }
    if (kind === 'role' && normalized === (snapshot.roles.items.find(r => r.id === role)?.description?.trim() || null)) { setNotice('No role description changes to save.'); return; }
    lock.current = true; setPending(true); setError(null); setNotice('');
    try {
      const result = kind === 'routing'
        ? await management.updateBoardSettings(workspaceId, changes!, snapshot.board.sha256!)
        : await management.updateRole(workspaceId, role!, normalized, snapshot.roles.sha256!);
      if (!result.ok) { setError(result.error); return; }
      setSavedKind(kind);
      if (await refreshLatest()) { setDraft(null); setRole(null); setSavedKind(null); setNotice(kind === 'routing' ? 'Routing settings saved.' : 'Role description saved.'); }
    } catch (reason) { setError({ code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false }); }
    finally { lock.current = false; setPending(false); }
  }
  function field(index: number, name: EditableRuleField, label: string, value: string, options: Array<{ value: string; label: string; disabled?: boolean }>) {
    const path = `rules[${index}].${name === 'status' ? 'when.status' : name}`; const matches = problems.filter(p => p.path === path); const id = `routing-${index}-${name}`;
    return <label htmlFor={id}>{label}<select id={id} value={value} disabled={pending || !connected || !!savedKind} aria-invalid={matches.length > 0} aria-describedby={matches.length ? `${id}-error` : undefined} onChange={e => change(index, name, e.target.value)}>{options.map(o => <option key={o.value} value={o.value} disabled={o.disabled && o.value !== value}>{o.label}</option>)}</select>{matches.length > 0 && <span id={`${id}-error`} className="routing-problem">{matches.map(p => <span key={p.message}>{path}: {p.message}</span>)}</span>}</label>;
  }
  const statusOptions = (editSettings ?? settings)?.statuses.map(s => ({ value: s.id, label: s.name ? `${s.name} (${s.id})` : s.id })) ?? [];
  const summaryProblems = problems.filter(p => {
    if (p.path === 'baseBranch') return false;
    const match = /^rules\[(\d+)\]\.(when\.status|role|workflow|workspace|onPass|onFail|onBlocked)$/.exec(p.path);
    if (!match || !draft?.rules[Number(match[1])]) return true;
    return ['role', 'workflow', 'workspace', 'onBlocked'].includes(match[2]) && draft.rules[Number(match[1])].type !== 'agent';
  });
  return <section className="dashboard-panel routing-settings" aria-label="Worktree and routing settings"><h2>Worktree and routing settings</h2>
    {section.loading && <p className="panel-loading">Loading settings…</p>}
    {section.error && <div className="panel-error" role="alert"><p>{section.error.code}: {section.error.message}</p><button type="button" onClick={() => void section.reload()}>Retry</button></div>}
    {notice && <p role="status">{notice}</p>}
    {settings && <>
      {settings.board.message && <p>{settings.board.message}</p>}{settings.roles.message && <p>{settings.roles.message}</p>}
      {settings.board.problems.map((p, i) => <p className="routing-problem" key={i}>{p.path}: {p.message}</p>)}
      <p>Base branch: {settings.worktree.baseBranch ?? 'main'}</p>
      <ul>{settings.rules.map(r => <li key={r.index}>{r.status} → {r.type === 'action' ? 'merge' : `${r.role} → ${r.workflow}`} → pass: {r.onPass} / fail: {r.onFail}{r.type === 'agent' && r.onBlocked ? ` / blocked: ${r.onBlocked}` : ''}{r.type === 'agent' && ` (${modes[r.workspace ?? ''] ?? r.workspace})`}</li>)}</ul>
      <h3>Protected merge-conflict routing</h3><ul aria-label="Protected merge-conflict routing">{settings.protectedRoutes.map(r => <li key={r.status}>{r.status} → TeamLead — {r.satisfied ? 'Protected' : 'Needs repair'}</li>)}</ul>
      <h3>Roles</h3><ul>{settings.roles.items.map(r => <li key={r.id}><strong>{r.id}</strong>: {r.description ?? 'No description'} <button type="button" disabled={!canEdit || pending || !!draft || !!role} onClick={() => { setEditSettings(settings); setRole(r.id); setDescription(r.description ?? ''); setError(null); setNotice(''); }}>Edit description</button></li>)}</ul>
      <h3>Workflows</h3><ul>{settings.workflows.map(w => <li key={w.name}>{w.name}{w.errors.length > 0 && ' — unavailable'}</li>)}</ul>
      {!draft && <button type="button" disabled={!canEdit || pending || !!role} onClick={() => { setEditSettings(settings); setDraft(createRoutingDraft(settings)); setError(null); setNotice(''); }}>Edit routing settings</button>}
      {draft && <form onSubmit={e => { e.preventDefault(); void save('routing'); }}>
        <label htmlFor="routing-base">Base branch<input id="routing-base" value={draft.baseBranch} disabled={pending || !connected || !!savedKind} aria-invalid={problems.some(p => p.path === 'baseBranch')} aria-describedby={problems.some(p => p.path === 'baseBranch') ? 'routing-base-error' : undefined} onChange={e => { setDraft({ ...draft, baseBranch: e.target.value }); setError(previous => previous?.code === 'CONFIG_CHANGED' ? previous : null); }} /></label>
        {problems.filter(p => p.path === 'baseBranch').map(p => <p id="routing-base-error" className="routing-problem" key={p.message}>{p.path}: {p.message}</p>)}
        <div className="routing-rule-grid">{draft.rules.map((r, i) => { const when = r.when && typeof r.when === 'object' ? r.when as Record<string, unknown> : {}; return <fieldset key={i}><legend>Rule {i + 1} — {val(r.type)}</legend>
          {field(i, 'status', 'Source status', val(when.status), statusOptions)}
          {r.type === 'agent' ? <>{field(i, 'role', 'Role', val(r.role), (editSettings ?? settings).roles.items.map(x => ({ value: x.id, label: x.id })))}{field(i, 'workflow', 'Workflow', val(r.workflow), (editSettings ?? settings).workflows.map(x => ({ value: x.name, label: `${x.name}${x.errors.length ? ' — unavailable' : ''}`, disabled: !!x.errors.length })))}{field(i, 'workspace', 'Workspace', val(r.workspace), Object.entries(modes).map(([value, label]) => ({ value, label })))}</> : <p>Action: {val(r.action)}</p>}
          {field(i, 'onPass', 'Pass status', val(r.onPass), statusOptions)}{field(i, 'onFail', 'Fail status', val(r.onFail), statusOptions)}{r.type === 'agent' && field(i, 'onBlocked', 'Blocked status', val(r.onBlocked), [{ value: '', label: 'None' }, ...statusOptions])}
        </fieldset>; })}</div>
        {summaryProblems.length > 0 && <div role="alert" className="routing-problem">{summaryProblems.map((p, i) => <p key={i}>{p.path}: {p.message}</p>)}</div>}
        <button type="submit" disabled={!canEdit || pending || !!savedKind || problems.length > 0 || error?.code === 'CONFIG_CHANGED'}>Save</button> <button type="button" disabled={pending || !!savedKind} onClick={() => { setDraft(null); setError(null); setNotice(''); }}>Cancel</button>
      </form>}
      {role && <form onSubmit={e => { e.preventDefault(); void save('role'); }}><label htmlFor="role-description">Description for {role}<textarea id="role-description" value={description} disabled={pending || !connected || !!savedKind} onChange={e => setDescription(e.target.value)} /></label><button type="submit" disabled={pending || !canEdit || !!savedKind || error?.code === 'CONFIG_CHANGED'}>Save</button> <button type="button" disabled={pending || !!savedKind} onClick={() => { setRole(null); setError(null); setNotice(''); }}>Cancel</button></form>}
      {reloadError && <div className="panel-error" role="alert"><p>Reload failed: {reloadError.code}: {reloadError.message}</p><button type="button" disabled={pending || !connected} onClick={() => void reload()}>Retry latest settings</button></div>}
      {error && <div className="panel-error" role="alert"><p>{error.code}: {error.message}</p>{error.remediation && <p>{error.remediation}</p>}{(!draft || error.code !== 'BOARD_CONFIG_INVALID') && errorProblems(error).map((p, i) => <p key={i}>{p.path}: {p.message}</p>)}{error.code === 'CONFIG_CHANGED' && <button type="button" disabled={pending || !connected} onClick={() => void reload()}>Reload latest settings</button>}</div>}
    </>}
  </section>;
}
