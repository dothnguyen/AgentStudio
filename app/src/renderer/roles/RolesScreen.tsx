import { useEffect, useRef, useState, type JSX, type RefObject } from 'react';
import type { ConnectionStatus, ManagementApi, ManagementError, RoleCatalogItem, RoleCatalogList, Workspace } from '../api';
import { useDashboardSection } from '../dashboard/useDashboardSection';
import { RoleDeleteDialog } from './RoleDeleteDialog';
import { RolePage } from './RolePage';
import { RoleForm, type RoleFormConflict, type RoleFormPhase } from './RoleForm';
import type { RoleFormField, RoleFormMode, RoleFormValues } from './roleEditModel';
import { runRoleSave, normalizeRoleError } from './roleSave';
import { ROLE_DATA_CHANGED_REASON, isInstructionFileShared, roleBlockerGroups, roleDeleteAnnouncement, roleDeleteDisabledReason, roleDeleteDisposition, roleUsageFromDeleteError, roleUsageProblemsFromDeleteError, filterRoleRows, roleDisplayLabel, roleInitials, roleRows, roleUsageSummary } from './rolesModel';

export interface RolesScreenProps { workspace: Workspace; management: ManagementApi; connection?: ConnectionStatus; requestedRoleId?: string | null; onOpenMember?(teamId: string, memberId: string): void }
export function RolesScreen(props: RolesScreenProps): JSX.Element { return <RolesBrowser key={props.workspace.id} {...props} />; }

interface DeleteAlert { roleId: string; error: ManagementError }
interface DeleteTarget { role: RoleCatalogItem; catalogSha256: string | null; instructionsSha256: string | null; shared: boolean }
const REFRESH_FAILED = 'Role was deleted, but Roles could not be refreshed. Retry Roles before making another change.';

function DeleteAlert(props: { alert: DeleteAlert }): JSX.Element {
  const { error } = props.alert;
  const usage = roleUsageFromDeleteError(error);
  const problems = roleUsageProblemsFromDeleteError(error);
  return <div className="panel-error roles-delete-alert" role="alert">
    <p><code>{error.code}</code>: {error.message}</p>
    {error.remediation && <p>{error.remediation}</p>}
    {error.code === 'ROLE_IN_USE' && <p>The role was not deleted. Remove these references elsewhere, then reload Roles.</p>}
    {usage && roleBlockerGroups(usage).map(g => <section key={g.key} className="roles-delete-group"><h4>{g.title}</h4><ul>{g.items.map((item, i) => <li key={i}>{item}</li>)}</ul></section>)}
    {error.code === 'ROLE_USAGE_UNAVAILABLE' && <><p>Role usage could not be checked completely. Fix the listed sources, then retry the scan and confirm again.</p>
      {problems.length > 0 && <ul>{problems.map((p, i) => <li key={i}><code>{p.source}</code>: {p.message}</li>)}</ul>}</>}
    {error.code === 'CONFIG_CHANGED' && <p>Role files changed. Reload Roles and confirm again.</p>}
  </div>;
}

type RolesView = { kind: 'list' } | { kind: 'role'; roleId: string };

function RolesBrowser(props: RolesScreenProps): JSX.Element {
  const catalog = useDashboardSection<RoleCatalogList>(props.management.roles, props.workspace.id);
  const connected = !props.connection || props.connection.state === 'connected';
  const heading = useRef<HTMLHeadingElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const retried = useRef(false);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const roleHeading = useRef<HTMLHeadingElement>(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<RolesView>({ kind: 'list' });
  const [focusRowId, setFocusRowId] = useState<string | null>(null);
  const [focusRolePage, setFocusRolePage] = useState(false);
  const [missingRequest, setMissingRequest] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteAlert, setDeleteAlert] = useState<DeleteAlert | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [refreshFailure, setRefreshFailure] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const deleteLock = useRef(false);
  const active = useRef(true);
  const committed = useRef<{ roleId: string; label: string; disposition: ReturnType<typeof roleDeleteDisposition> } | null>(null);
  const reloading = useRef(false);
  const lastData = useRef<RoleCatalogList | null>(null);
  const [focusTrigger, setFocusTrigger] = useState(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const openRole = (roleId: string, focusPage = true) => {
    setView({ kind: 'role', roleId });
    setFocusRowId(null);
    setMissingRequest(null);
    setFocusRolePage(focusPage);
  };
  const edit = useRoleEditing(props, catalog, roleId => openRole(roleId, false), setQuery, search, deletePending || refreshRequired || deleteTarget !== null);
  const data = edit.displayed;
  useEffect(() => { if (catalog.state === 'ready' && retried.current) { retried.current = false; heading.current?.focus(); } }, [catalog.state]);

  const requestedRoleId = props.requestedRoleId ?? null;
  const handledRequest = useRef<string | null>(null);
  useEffect(() => {
    if (requestedRoleId === null) { handledRequest.current = null; setMissingRequest(null); return; }
    if (data === null || handledRequest.current === requestedRoleId) return;
    handledRequest.current = requestedRoleId;
    const found = data.items.some(item => item.id === requestedRoleId);
    if (found) {
      openRole(requestedRoleId);
      setMissingRequest(null);
      setQuery('');
    } else {
      setView({ kind: 'list' });
      setMissingRequest(requestedRoleId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedRoleId, data]);

  if (data) lastData.current = data;
  const shown = data ?? (refreshRequired ? lastData.current : null);
  const rows = roleRows(shown?.items ?? []);
  const visible = filterRoleRows(rows, query);
  const filtering = query.trim().length > 0;
  const countLabel = filtering
    ? `${visible.length} of ${rows.length} ${rows.length === 1 ? 'role' : 'roles'}`
    : `${rows.length} ${rows.length === 1 ? 'role' : 'roles'}`;
  const rolePage = view.kind === 'role' ? shown?.items.find(item => item.id === view.roleId) ?? null : null;
  const currentId = view.kind === 'role' ? view.roleId : null;
  const error = catalog.error;
  const showCatalog = shown !== null;
  const invalid = shown?.state === 'invalid';

  useEffect(() => {
    if (view.kind !== 'list' || focusRowId === null) return;
    const row = rowRefs.current.get(focusRowId);
    setFocusRowId(null);
    row?.focus();
  }, [view, focusRowId, visible.length]);

  useEffect(() => {
    if (!focusRolePage || view.kind !== 'role') return;
    setFocusRolePage(false);
    roleHeading.current?.focus();
  }, [focusRolePage, view]);

  useEffect(() => {
    if (view.kind !== 'role' || catalog.state !== 'ready' || data === null) return;
    if (!data.items.some(item => item.id === view.roleId)) setView({ kind: 'list' });
  }, [view, catalog.state, data]);

  const finalize = () => {
    const done = committed.current;
    if (!done) return;
    committed.current = null;
    setView({ kind: 'list' });
    setFocusRowId(null);
    setRefreshRequired(false);
    setRefreshFailure(false);
    setDeleteTarget(null);
    setDeleteAlert(null);
    setAnnouncement(roleDeleteAnnouncement(done.label, done.disposition));
    setFocusTrigger(true);
  };
  useEffect(() => {
    if (committed.current && !reloading.current && catalog.state === 'ready' && data) finalize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog.state, data]);
  useEffect(() => {
    if (!focusTrigger) return;
    setFocusTrigger(false);
    const target = view.kind === 'role' ? deleteButton.current : heading.current ?? title.current;
    target?.focus();
    // A refresh failure disables Delete, so the browser refuses to focus it.
    // Keep keyboard users on the page by falling back to the role heading.
    if (view.kind === 'role' && (target === null || document.activeElement !== target)) roleHeading.current?.focus();
  }, [focusTrigger, view]);

  const selectedRole = rolePage;
  const disabledReason = selectedRole ? roleDeleteDisabledReason({ role: selectedRole, catalogSha256: shown?.sha256 ?? null, disconnected: !connected, mutationPending: deletePending || edit.busy, refreshRequired }) : null;
  const targetCurrent = deleteTarget ? shown?.items.find(r => r.id === deleteTarget.role.id) : undefined;
  const targetChanged = !!deleteTarget && (!targetCurrent || currentId !== deleteTarget.role.id
    || shown?.sha256 !== deleteTarget.catalogSha256 || (targetCurrent.instructions.sha256 ?? null) !== deleteTarget.instructionsSha256
    || !data || roleDeleteDisabledReason({ role: targetCurrent, catalogSha256: shown?.sha256 ?? null, disconnected: !connected, mutationPending: false, refreshRequired }) !== null);

  const openDelete = () => {
    if (!selectedRole || disabledReason || !shown) return;
    setDeleteAlert(null);
    setAnnouncement('');
    setDeleteTarget({
      role: selectedRole, catalogSha256: shown.sha256, instructionsSha256: selectedRole.instructions.sha256 ?? null,
      shared: isInstructionFileShared(selectedRole, shown.items),
    });
  };
  const closeDelete = () => { setDeleteTarget(null); };
  const confirmDelete = async () => {
    const target = deleteTarget;
    if (!target || deleteLock.current || targetChanged || !target.catalogSha256) return;
    deleteLock.current = true;
    setDeletePending(true);
    const label = roleDisplayLabel(target.role) || target.role.id;
    let result;
    try {
      result = await props.management.deleteRole(props.workspace.id, target.role.id, {
        expectedRolesSha256: target.catalogSha256, expectedInstructionsSha256: target.instructionsSha256,
      });
    } catch (reason) {
      result = { ok: false as const, error: { code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false } };
    }
    if (!active.current) return;
    if (!result.ok) {
      deleteLock.current = false;
      setDeletePending(false);
      setDeleteTarget(null);
      setDeleteAlert({ roleId: target.role.id, error: result.error });
      return;
    }
    committed.current = { roleId: target.role.id, label, disposition: roleDeleteDisposition(result.data) };
    setRefreshRequired(true);
    reloading.current = true;
    const fresh = await (catalog.reloadFresh ? catalog.reloadFresh() : catalog.reload().then(() => ({ ok: false as const })));
    reloading.current = false;
    if (!active.current) return;
    deleteLock.current = false;
    setDeletePending(false);
    if (fresh.ok) finalize();
    else { setDeleteTarget(null); setRefreshFailure(true); setFocusTrigger(true); }
  };

  return <div className="roles-screen" data-section="roles">
    {view.kind === 'list' && <header className="roles-header">
      <div className="roles-heading">
        <h1 tabIndex={-1} ref={title}>Roles</h1>
        <p className="roles-subtitle">Shared descriptions, instructions and skills. Every member with a role uses it.</p>
      </div>
      <div className="roles-header-actions">
        <button type="button" className="roles-new-button" disabled={edit.mutationBlock !== null} aria-describedby={edit.mutationBlock ? 'roles-mutation-reason' : undefined} onClick={() => edit.open('create', null)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          New role
        </button>
        {edit.mutationBlock && <span id="roles-mutation-reason">{edit.mutationBlock}</span>}
      </div>
    </header>}
    {view.kind === 'list' && <div className="roles-notice">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></svg>
      <span>Saved changes apply to new assignments. Assignments already running keep the instructions they started with.</span>
    </div>}
    {!connected && <p role="status">{props.connection?.state === 'lost' ? 'Connection to the backend was lost. Saved role data stays visible but may be out of date.' : 'Connecting to the backend… Saved role data may be out of date.'}</p>}
    {catalog.loading && !refreshRequired && <p role="status">Loading roles…</p>}
    {announcement && <p role="status" className="roles-announcement">{announcement}</p>}
    {refreshFailure && <p role="alert">{REFRESH_FAILED}</p>}
    {error && <div className="panel-error roles-error" role="alert"><p><code>{error.code}</code>: {error.message}</p>{error.remediation && <p>{error.remediation}</p>}<button type="button" onClick={() => { retried.current = true; void catalog.reload(); }}>Retry loading roles</button></div>}
    {missingRequest !== null && <p role="status" className="roles-missing-request">{`Role "${missingRequest}" is unavailable in this workspace.`}</p>}
    {edit.announcement && <p role="status" className="roles-saved">{edit.announcement}</p>}
    {view.kind === 'list' && showCatalog && shown && <>
      {shown.state === 'missing' && <p>No roles catalog is configured for this workspace.</p>}
      {invalid && <div className="panel-note roles-problems" role="alert"><p>Roles catalog is invalid.</p><ul>{shown.problems.map((p, i) => <li key={i}>{p.path ? `${p.path}: ` : ''}{p.message}</li>)}</ul></div>}
      {!invalid && shown.problems.length > 0 && <div className="panel-note roles-problems"><p>Roles catalog problems</p><ul>{shown.problems.map((p, i) => <li key={i}>{p.path ? `${p.path}: ` : ''}{p.message}</li>)}</ul></div>}
      {shown.state === 'ok' && rows.length === 0 && <><p>No roles are configured yet.</p><p>Use New role to create one.</p></>}
      {rows.length > 0 && <>
        <h2 tabIndex={-1} ref={heading} className="roles-visually-hidden">Role catalog</h2>
        <div className="roles-toolbar">
          <label className="roles-search">
            <span className="roles-visually-hidden">Search roles</span>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input ref={search} type="search" placeholder="Search roles" value={query} onChange={e => setQuery(e.target.value)} />
          </label>
          <p className="roles-count">{countLabel}</p>
        </div>
        {visible.length === 0
          ? <p className="roles-no-match">No role matches this search. <button type="button" onClick={() => { setQuery(''); search.current?.focus(); }}>Clear search</button></p>
          : <section className="roles-table-card" aria-label="Role catalog">
            <p id="roles-table-columns" className="roles-visually-hidden">Columns: Role, Description, Skills, Used by.</p>
            <div className="roles-table-scroll">
              <div className="roles-table">
                <div className="roles-table-head" aria-hidden="true"><span>Role</span><span>Description</span><span>Skills</span><span>Used by</span><span /></div>
                <ul className="roles-table-list" aria-label="Saved roles">{visible.map(row => {
                  const role = row.role;
                  const summary = roleUsageSummary(role);
                  const path = role.instructions.path?.trim();
                  const description = role.description?.trim();
                  return <li key={row.key}>
                    <button type="button" className="roles-row" data-role-id={role.id} aria-label={`Open role ${roleDisplayLabel(role)}`} aria-describedby="roles-table-columns"
                      ref={element => { if (element) rowRefs.current.set(role.id, element); else rowRefs.current.delete(role.id); }}
                      onClick={() => openRole(role.id)}>
                      <span className="roles-cell roles-role-cell">
                        <span className="roles-avatar" aria-hidden="true">{roleInitials(role)}</span>
                        <span className="roles-role-text">
                          <span className="roles-role-name">{roleDisplayLabel(role)}</span>
                          <span className="roles-role-path">{path || 'No instruction file'}</span>
                        </span>
                      </span>
                      <span className={`roles-cell roles-description${description ? '' : ' roles-description-empty'}`}>{description || 'No description'}</span>
                      <span className="roles-cell roles-skills">
                        {role.skills.length === 0
                          ? <span className="roles-skill-none">None</span>
                          : <>
                            {role.skills.slice(0, 2).map((skill, i) => <span key={`${skill.id}:${i}`} className={`roles-skill-chip${skill.state === 'ok' ? '' : ' roles-skill-chip-missing'}`}>
                              {skill.id}{skill.state !== 'ok' && <span className="roles-visually-hidden"> missing</span>}
                            </span>)}
                            {role.skills.length > 2 && <span className="roles-skill-more">+{role.skills.length - 2}</span>}
                          </>}
                      </span>
                      <span className="roles-cell roles-usage">
                        <span className={`roles-usage-count${summary.members === 'Unused' ? ' roles-usage-muted' : summary.incomplete ? ' roles-usage-incomplete' : ''}`}>{summary.members}</span>
                        {summary.running && <span className={`roles-usage-running${summary.incomplete ? ' roles-usage-incomplete' : ''}`}>{summary.running}</span>}
                      </span>
                      <span className="roles-cell roles-chevron" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg></span>
                    </button>
                  </li>;
                })}</ul>
              </div>
            </div>
          </section>}
      </>}
    </>}
    {view.kind === 'role' && rolePage && <div className="roles-page" role="region" aria-label="Role details">
      {deleteAlert?.roleId === rolePage.id && <DeleteAlert alert={deleteAlert} />}
      <RolePage
        role={rolePage}
        editDisabled={edit.mutationBlock !== null || shown?.state !== 'ok'}
        editReason={edit.mutationBlock}
        onEdit={() => edit.open('edit', rolePage)}
        onBack={() => { setView({ kind: 'list' }); setFocusRowId(view.roleId); }}
        onDelete={openDelete}
        deleteDisabledReason={disabledReason}
        onOpenMember={props.onOpenMember}
        headingRef={roleHeading}
        deleteRef={deleteButton}
      />
    </div>}
    {edit.dialog}
    {deleteTarget && <RoleDeleteDialog role={deleteTarget.role} shared={deleteTarget.shared} pending={deletePending} blockedReason={targetChanged ? ROLE_DATA_CHANGED_REASON : null} onCancel={closeDelete} onConfirm={() => void confirmDelete()} />}
  </div>;
}


interface Session {
  id: number;
  mode: RoleFormMode;
  base: RoleCatalogItem | null;
  catalogSha: string | null;
  opener: HTMLElement | null;
  metadataSaved: boolean;
}

const changedError = (remediation?: string): ManagementError => ({ code: 'CONFIG_CHANGED', message: 'Another edit was saved first.', retryable: true, remediation });
const normalize = normalizeRoleError;
async function guarded<T>(run: () => Promise<{ ok: true; data: T } | { ok: false; error: ManagementError }>): Promise<{ ok: true; data: T } | { ok: false; error: ManagementError }> {
  try { return await run(); } catch (reason) { return { ok: false, error: normalize(reason) }; }
}
function changedFields(before: RoleCatalogItem, after: RoleCatalogItem): RoleFormField[] {
  const out: RoleFormField[] = [];
  if (before.name !== after.name) out.push('name');
  if ((before.description ?? '') !== (after.description ?? '')) out.push('description');
  if (before.instructions.text !== after.instructions.text || before.instructions.sha256 !== after.instructions.sha256) out.push('instructions');
  if (before.skills.map(s => s.id).join('\n') !== after.skills.map(s => s.id).join('\n')) out.push('skills');
  return out;
}

function useRoleEditing(
  props: RolesScreenProps,
  catalog: ReturnType<typeof useDashboardSection<RoleCatalogList>>,
  select: (id: string) => void,
  setQuery: (query: string) => void,
  search: RefObject<HTMLInputElement | null>,
  deleteBusy: boolean,
) {
  const lastData = useRef<RoleCatalogList | null>(null);
  if (catalog.data) lastData.current = catalog.data;
  const displayed = catalog.data ?? (catalog.loading ? lastData.current : null);
  const formCatalog = displayed ?? lastData.current;
  const workspaceId = props.workspace.id;
  const connected = !props.connection || props.connection.state === 'connected';

  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const requestRef = useRef(0);
  const sessionCounter = useRef(0);
  const mounted = useRef(true);
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [phase, setPhase] = useState<RoleFormPhase>('idle');
  const [serverError, setServerError] = useState<ManagementError | null>(null);
  const [partialNotice, setPartialNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<RoleFormConflict | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<{ n: number; kind: 'opener' | 'role'; opener: HTMLElement | null } | null>(null);
  const reloadFreshRef = useRef(catalog.reloadFresh);
  reloadFreshRef.current = catalog.reloadFresh;
  const management = props.management;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!focusTarget) return;
    const root = document.querySelector('.roles-screen');
    const roleHeading = root?.querySelector<HTMLElement>('.roles-role-heading');
    const target = focusTarget.kind === 'opener' && focusTarget.opener?.isConnected
      ? focusTarget.opener
      : focusTarget.kind === 'role' ? roleHeading ?? search.current : search.current;
    target?.focus();
    setFocusTarget(null);
  }, [focusTarget, search]);

  const data = displayed;
  const mutationBlock = !connected ? 'Role changes are unavailable while the backend is disconnected.'
    : !data ? 'Role changes are unavailable until the catalog loads.'
    : data.state === 'invalid' || data.problems.length > 0 ? 'Role changes are unavailable while the roles catalog has problems.'
    : deleteBusy ? 'A role deletion is in progress.'
    : pending || session ? 'Another role change is in progress.' : null;

  const patch = (change: Partial<Session>) => {
    const next = { ...sessionRef.current!, ...change };
    sessionRef.current = next;
    setSession(next);
    return next;
  };
  const fresh = (): Promise<{ ok: true; data: RoleCatalogList } | { ok: false; error: ManagementError }> =>
    guarded(async () => (await (reloadFreshRef.current?.() ?? management.roles(workspaceId))) as { ok: true; data: RoleCatalogList } | { ok: false; error: ManagementError });
  const reset = () => { setPending(false); setPhase('idle'); setServerError(null); setPartialNotice(null); setConflict(null); };

  const open = (mode: RoleFormMode, role: RoleCatalogItem | null) => {
    if (mutationBlock || lock.current || !data) return;
    if (mode === 'create' && data.state === 'invalid') return;
    reset();
    const next: Session = { id: ++sessionCounter.current, mode, base: role, catalogSha: data.sha256, opener: document.activeElement instanceof HTMLElement ? document.activeElement : null, metadataSaved: false };
    requestRef.current += 1;
    sessionRef.current = next;
    setAnnouncement(null);
    setSession(next);
  };
  const close = (kind: 'opener' | 'role') => {
    const opener = sessionRef.current?.opener ?? null;
    sessionRef.current = null;
    requestRef.current += 1;
    setSession(null);
    reset();
    setFocusTarget({ n: sessionCounter.current, kind, opener });
  };

  const submit = async (values: RoleFormValues) => {
    const start = sessionRef.current;
    if (!start || lock.current || !mounted.current) return;
    lock.current = true;
    const sid = start.id;
    const rid = ++requestRef.current;
    const live = () => mounted.current && sessionRef.current?.id === sid && requestRef.current === rid;
    setPending(true); setServerError(null); setPartialNotice(null);
    try {
      const outcome = await runRoleSave({
        management,
        workspaceId,
        session: { mode: start.mode, base: start.base, catalogSha: start.catalogSha, metadataSaved: start.metadataSaved },
        values,
        reload: fresh,
        isLive: live,
        onPhase: setPhase,
        onSession: change => patch(change),
      });
      if (outcome.status === 'stale') return;
      if (outcome.status === 'failed') {
        setPending(false);
        setPhase('idle');
        setPartialNotice(outcome.partialNotice);
        setServerError(outcome.error);
        setConflict(null);
        return;
      }
      select(outcome.role.id);
      setQuery('');
      if (outcome.wrote) setAnnouncement(`${start.mode === 'create' ? 'Created' : 'Saved'} role "${outcome.role.name}" (${outcome.role.id}). Saved changes apply to new assignments; current assignments are unchanged.`);
      close('role');
    } catch (reason) {
      if (live()) {
        setPending(false);
        setPhase('idle');
        setPartialNotice(null);
        setServerError(normalize(reason));
        setConflict(null);
      }
    } finally {
      lock.current = false;
    }
  };

  const reloadReview = async () => {
    const start = sessionRef.current;
    if (!start || lock.current || !mounted.current) return;
    lock.current = true;
    const sid = start.id;
    const rid = ++requestRef.current;
    const live = () => mounted.current && sessionRef.current?.id === sid && requestRef.current === rid;
    const wasConflict = serverError?.code === 'CONFIG_CHANGED';
    setPending(true); setPhase('reloading_tokens');
    try {
      const reloaded = await fresh();
      if (!live()) return;
      setPending(false); setPhase('idle');
      if (!reloaded.ok) { setServerError(wasConflict ? changedError(`Reloading current values failed: ${reloaded.error.message}`) : reloaded.error); return; }
      if (start.mode === 'create') {
        patch({ catalogSha: reloaded.data.sha256 });
        setServerError(null); setConflict(null);
        setPartialNotice('Current roles were reloaded. Review the id and name, then save again.');
        return;
      }
      const server = reloaded.data.items.find(item => item.id === start.base!.id);
      if (!server) { setServerError(wasConflict ? changedError('This role no longer exists in the reloaded catalog.') : normalize('This role no longer exists in the reloaded catalog.')); return; }
      const fields = changedFields(start.base!, server);
      patch({ base: server, catalogSha: reloaded.data.sha256 });
      setPartialNotice(null);
      if (wasConflict) { setServerError(null); setConflict({ server, changedFields: fields, acknowledged: false }); } else setServerError(null);
    } finally {
      lock.current = false;
    }
  };
  const keepDraft = () => { setConflict(c => (c ? { ...c, acknowledged: true } : c)); setServerError(null); };
  const useServer = () => {
    if (!conflict || !sessionRef.current) return;
    const next = { ...sessionRef.current, id: ++sessionCounter.current, base: conflict.server };
    requestRef.current += 1;
    sessionRef.current = next;
    setSession(next);
    reset();
  };

  const dialog = session && formCatalog ? <div className="modal-overlay"><RoleForm key={session.id} mode={session.mode} source={session.base} catalog={formCatalog}
    pending={pending} phase={phase} serverError={serverError} partialNotice={partialNotice} conflict={conflict}
    mutationsBlockedReason={!connected ? 'Role changes are unavailable while the backend is disconnected.' : null}
    onSubmit={values => void submit(values)} onCancel={() => close('opener')} onReloadConflict={() => void reloadReview()} onKeepDraft={keepDraft} onUseServer={useServer} /></div> : null;

  return { displayed, mutationBlock, open, dialog, announcement, busy: pending || session !== null };
}
