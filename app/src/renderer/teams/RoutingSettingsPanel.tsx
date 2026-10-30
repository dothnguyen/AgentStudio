import { useEffect, useRef, useState, type JSX } from 'react';
import type { BoardSettings, ManagementApi, ManagementError, RoleCatalogItem } from '../../shared/management';
import { RoutingReadView } from './RoutingReadView';
import { RoutingEditForm, routingSummaryProblems } from './RoutingEditForm';
import type { DashboardSectionController } from '../dashboard/useDashboardSection';
import { boardSettingsChanges, createRoutingDraft, errorProblems, updateRuleField, setRuleFailureLimit, removeRuleFailureLimit, validateRoutingDraft, type EditableRuleField, type RoutingDraft } from './routingSettingsModel';

export interface RoutingSettingsPanelProps { workspaceId: string; management: ManagementApi; section: DashboardSectionController<BoardSettings>; connected: boolean; alert?: boolean; announce?: boolean; onLocalErrorChange?(active: boolean): void; roleItems?: RoleCatalogItem[] | null; onViewRole?(roleId: string): void }
export function RoutingSettingsPanel({ workspaceId, management, section, connected, alert = true, announce = true, onLocalErrorChange, roleItems = null, onViewRole }: RoutingSettingsPanelProps): JSX.Element {
  const [draft, setDraft] = useState<RoutingDraft | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [focusRequest, setFocusRequest] = useState<{ target: 'invalid' | 'conflict' | 'reload-retry' | 'heading' | 'edit' | 'section-retry'; n: number } | null>(null);
  const requestFocus = (target: NonNullable<typeof focusRequest>['target']): void => setFocusRequest(r => ({ target, n: (r?.n ?? 0) + 1 }));
  useEffect(() => {
    if (!focusRequest) return;
    const root = rootRef.current;
    const el = focusRequest.target === 'heading' ? headingRef.current
      : focusRequest.target === 'invalid' ? root?.querySelector<HTMLElement>('[aria-invalid="true"]')
      : root?.querySelector<HTMLElement>(`[data-focus="${focusRequest.target}"]`);
    el?.focus();
  }, [focusRequest]);
  const [editSettings, setEditSettings] = useState<BoardSettings | null>(null);
  const [pending, setPending] = useState(false); const lock = useRef(false);
  const [error, setError] = useState<ManagementError | null>(null); const [notice, setNotice] = useState('');
  const lastSettings = useRef<BoardSettings | null>(null);
  if (section.data) lastSettings.current = section.data;
  const settings = section.data ?? lastSettings.current;
  const [reloadError, setReloadError] = useState<ManagementError | null>(null);
  const [savedKind, setSavedKind] = useState<'routing' | null>(null);
  const fresh = section.data !== null && section.error === null && !section.loading;
  const canEdit = !!(connected && fresh && settings && settings.board.state === 'ok' && settings.roles.state === 'ok' && settings.board.sha256 && settings.roles.sha256 && createRoutingDraft(settings));
  const problems = draft && editSettings ? [...validateRoutingDraft(draft, editSettings), ...(error?.code === 'BOARD_CONFIG_INVALID' ? errorProblems(error) : [])] : [];
  const problemKey = draft && editSettings ? validateRoutingDraft(draft, editSettings).map(p => p.path).join('|') : '';
  useEffect(() => {
    if (!problemKey) return;
    const el = rootRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (el && document.activeElement !== el) el.focus();
  }, [problemKey]);
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
  async function reload() { if (lock.current) return; lock.current = true; setPending(true); try { if (await refreshLatest()) { setDraft(null); setEditSettings(null); setError(null); setNotice(savedKind ? 'Routing settings saved.' : ''); setSavedKind(null); requestFocus('heading'); } else requestFocus(error?.code === 'CONFIG_CHANGED' ? 'conflict' : 'reload-retry'); } catch (reason) { setReloadError({ code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false }); } finally { lock.current = false; setPending(false); } }
  async function save() {
    if (lock.current || !editSettings || !canEdit || savedKind || error?.code === 'CONFIG_CHANGED') return;
    const snapshot = editSettings;
    if (!draft || validateRoutingDraft(draft, snapshot).length) return;
    const changes = draft ? boardSettingsChanges(draft, snapshot) : null;
    if (!changes) { setNotice('No routing changes to save.'); return; }
    lock.current = true; setPending(true); setError(null); setNotice('');
    try {
      const result = await management.updateBoardSettings(workspaceId, changes, snapshot.board.sha256!);
      if (!result.ok) { setError(result.error); if (result.error.code === 'CONFIG_CHANGED') requestFocus('conflict'); return; }
      setSavedKind('routing');
      if (await refreshLatest()) { setDraft(null); setEditSettings(null); setSavedKind(null); setNotice('Routing settings saved.'); }
    } catch (reason) { setError({ code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false }); }
    finally { lock.current = false; setPending(false); }
  }
  const summaryAlert = draft !== null && routingSummaryProblems(problems, draft).length > 0;
  const localAlert = !!(reloadError || error || summaryAlert);
  useEffect(() => { onLocalErrorChange?.(localAlert); return () => onLocalErrorChange?.(false); }, [localAlert, onLocalErrorChange]);
  return <section ref={rootRef} className="dashboard-panel routing-settings" aria-label="Workspace board routing"><h2 ref={headingRef} tabIndex={-1}>Workspace board routing</h2>
    <p className="routing-scope">Routing belongs to the workspace board. Changes affect every team that uses this workspace board, not only the selected team.</p>
    {section.loading && <p className="panel-loading" role={announce ? 'status' : undefined}>{settings ? 'Refreshing routing settings… Showing previously loaded data.' : 'Loading settings…'}</p>}
    {section.error && <div className="panel-error" role={alert && !localAlert ? 'alert' : undefined}>{settings && <p>Showing previously loaded data.</p>}<p>{section.error.code}: {section.error.message}</p><p>{section.error.remediation || 'Retry loading routing settings; if it keeps failing, check the Agent Studio connection.'}</p><button type="button" data-focus="section-retry" onClick={() => void (async () => { const result = section.reloadFresh ? await section.reloadFresh() : (await section.reload(), null); requestFocus(result?.ok === false ? 'section-retry' : 'heading'); })()}>Retry</button></div>}
    {!connected && settings && <p className="panel-note">Disconnected from the backend. Routing is read-only until the connection returns.</p>}
    {settings && (section.error !== null || section.data === null) && <p className="panel-note">Showing the last loaded routing; it may be out of date.</p>}
    {settings && <>
      {settings.board.state === 'missing' && <p className="routing-problem">No workspace board is configured, so no routing is shown.</p>}
      {settings.board.state === 'invalid' && <p className="routing-problem">The workspace board configuration is invalid. Routing cannot be shown until it is repaired.</p>}
      {settings.board.message && <p>{settings.board.message}</p>}
      {settings.board.problems.map((p, i) => <p className="routing-problem" key={i}>{p.path}: {p.message}</p>)}
      {settings.roles.state !== 'ok' && <p>{settings.roles.message ?? `Workspace roles are ${settings.roles.state}.`}</p>}
      {roleItems === null && <p className="panel-note">Role names are unavailable; rules show stable role ids.</p>}
      {notice && <p role={announce && !section.loading ? 'status' : undefined}>{notice}</p>}
      <RoutingReadView settings={settings} roleItems={roleItems} onViewRole={onViewRole} />
      {!draft && <button type="button" data-focus="edit" disabled={!canEdit || pending} onClick={() => { setEditSettings(settings); setDraft(createRoutingDraft(settings)); setError(null); setNotice(''); }}>Edit routing settings</button>}
      {draft && editSettings && <RoutingEditForm draft={draft} settings={editSettings} problems={problems} pending={pending} connected={connected} locked={!!savedKind} canEdit={canEdit} conflict={error?.code === 'CONFIG_CHANGED'} alert={alert && !reloadError && !error} onChange={change} onBaseBranchChange={v => { setDraft({ ...draft, baseBranch: v }); setError(p => p?.code === 'CONFIG_CHANGED' ? p : null); setNotice(''); }} onFailureChange={(index, count, status) => { setDraft(d => d && setRuleFailureLimit(d, index, count, status)); setError(e => e?.code === 'CONFIG_CHANGED' ? e : null); setNotice(''); }} onFailureRemove={index => { setDraft(d => d && removeRuleFailureLimit(d, index)); setError(e => e?.code === 'CONFIG_CHANGED' ? e : null); setNotice(''); }} onSubmit={() => void save()} onCancel={() => { setDraft(null); setEditSettings(null); setError(null); setReloadError(null); setNotice(''); requestFocus('edit'); }} />}
      {reloadError && <div className="panel-error" role={alert ? 'alert' : undefined}><p>Reload failed: {reloadError.code}: {reloadError.message}</p><p>{reloadError.remediation || 'Retry loading the latest settings; if it keeps failing, check the Agent Studio connection.'}</p><button type="button" data-focus="reload-retry" disabled={pending || !connected} onClick={() => void reload()}>Retry latest settings</button></div>}
      {error && <div className="panel-error" role={alert && !reloadError ? 'alert' : undefined}><p>{error.code}: {error.message}</p><p>{error.remediation || (error.code === 'CONFIG_CHANGED' ? 'Reload the latest settings before saving your changes.' : 'Review your changes and try saving again; if the problem persists, check the Agent Studio connection.')}</p>{(!draft || error.code !== 'BOARD_CONFIG_INVALID') && errorProblems(error).map((p, i) => <p key={i}>{p.path}: {p.message}</p>)}{error.code === 'CONFIG_CHANGED' && <button type="button" data-focus="conflict" disabled={pending || !connected} onClick={() => void reload()}>Reload latest settings</button>}</div>}
    </>}
  </section>;
}
