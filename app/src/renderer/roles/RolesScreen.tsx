import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { ConnectionStatus, ManagementApi, ManagementError, RoleCatalogItem, RoleCatalogList, Workspace } from '../api';
import { useDashboardSection } from '../dashboard/useDashboardSection';
import { RoleCreateDialog } from './RoleCreateDialog';
import { RoleDeleteDialog } from './RoleDeleteDialog';
import { RoleOverviewDialog } from './RoleOverviewDialog';
import { RolePage } from './RolePage';
import { RolePageInstructionsDialog } from './RolePageInstructionsDialog';
import { RoleSkillsDialog } from './RoleSkillsDialog';
import { ROLE_DATA_CHANGED_REASON, isInstructionFileShared, roleBlockerGroups, roleDeleteAnnouncement, roleDeleteDisabledReason, roleDeleteDisposition, roleUsageFromDeleteError, roleUsageProblemsFromDeleteError, filterRoleRows, roleDisplayLabel, roleInitials, roleRows, roleUsageSummary } from './rolesModel';

export interface RolesScreenProps {
  workspace: Workspace;
  management: ManagementApi;
  connection?: ConnectionStatus;
  requestedRoleId?: string | null;
  onOpenMember?(teamId: string, memberId: string): void;
  /** Opens the standalone Skills screen on that skill's page. */
  onOpenSkill?(skillId: string): void;
  /** Opens the Skills list; used by the Edit skills dialog footer. */
  onOpenSkills?(): void;
}
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

type RoleDialogState =
  | { kind: 'overview'; roleId: string }
  | { kind: 'skills'; roleId: string }
  | { kind: 'instructions'; roleId: string }
  | { kind: 'create' };

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
  const [dialog, setDialog] = useState<RoleDialogState | null>(null);
  const [dialogPending, setDialogPending] = useState(false);
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
  const data = catalog.data ?? (catalog.loading ? lastData.current : null);
  const reloadFresh = useCallback((): Promise<{ ok: true; data: RoleCatalogList } | { ok: false; error: ManagementError }> => {
    if (catalog.reloadFresh !== undefined) return catalog.reloadFresh();
    return Promise.resolve({ ok: false, error: { code: 'INTERNAL', message: 'Roles cannot be refreshed.', retryable: true } });
  }, [catalog.reloadFresh]);
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

  if (catalog.data) lastData.current = catalog.data;
  const shown = data ?? ((refreshRequired || dialog !== null) ? lastData.current : null);
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
    const target = roleHeading.current;
    if (target === null) return;
    setFocusRolePage(false);
    target.focus();
  }, [focusRolePage, view, data]);

  useEffect(() => {
    if (view.kind !== 'role' || catalog.state !== 'ready' || data === null) return;
    if (!data.items.some(item => item.id === view.roleId)) setView({ kind: 'list' });
  }, [view, catalog.state, data]);

  const mutationBlock = !connected ? 'Role changes are unavailable while the backend is disconnected.'
    : !shown ? 'Role changes are unavailable until the catalog loads.'
    : shown.state === 'invalid' || shown.problems.length > 0 ? 'Role changes are unavailable while the roles catalog has problems.'
    : refreshRequired ? 'Role changes are unavailable until Roles is reloaded.'
    : deletePending ? 'A role deletion is in progress.'
    : dialogPending ? 'Another role change is in progress.' : null;

  const dialogRole = dialog !== null && dialog.kind !== 'create' && shown !== null
    ? shown.items.find(item => item.id === dialog.roleId) ?? null
    : null;
  useEffect(() => {
    if (dialog !== null && dialog.kind !== 'create' && dialogRole === null) setDialog(null);
  }, [dialog, dialogRole]);

  const openDialog = (next: RoleDialogState) => {
    if (mutationBlock !== null || shown === null) return;
    setAnnouncement('');
    setDialog(next);
  };
  const closeDialog = () => { setDialog(null); setDialogPending(false); };
  const savedRole = (role: RoleCatalogItem, created: boolean) => {
    const label = roleDisplayLabel(role) || role.id;
    setDialog(null);
    setDialogPending(false);
    setAnnouncement(created
      ? `Created role ${label}.`
      : `Saved role ${label}. Saved changes apply to new assignments; current assignments are unchanged.`);
    if (created) openRole(role.id);
  };

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
  const disabledReason = selectedRole ? roleDeleteDisabledReason({ role: selectedRole, catalogSha256: shown?.sha256 ?? null, disconnected: !connected, mutationPending: deletePending || dialogPending, refreshRequired }) : null;
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
        <button type="button" className="roles-new-button" disabled={mutationBlock !== null} aria-describedby={mutationBlock ? 'roles-mutation-reason' : undefined} onClick={() => openDialog({ kind: 'create' })}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          New role
        </button>
        {mutationBlock && <span id="roles-mutation-reason">{mutationBlock}</span>}
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
        editDisabled={mutationBlock !== null || shown?.state !== 'ok'}
        editReason={mutationBlock}
        onEditOverview={() => openDialog({ kind: 'overview', roleId: rolePage.id })}
        onEditSkills={() => openDialog({ kind: 'skills', roleId: rolePage.id })}
        onEditInstructions={() => openDialog({ kind: 'instructions', roleId: rolePage.id })}
        onBack={() => { closeDialog(); setView({ kind: 'list' }); setFocusRowId(view.roleId); }}
        onDelete={openDelete}
        deleteDisabledReason={disabledReason}
        onOpenMember={props.onOpenMember}
        onOpenSkill={props.onOpenSkill}
        headingRef={roleHeading}
        deleteRef={deleteButton}
      />
    </div>}
    {dialog?.kind === 'create' && shown && <RoleCreateDialog
      catalog={shown}
      catalogSha={shown.sha256}
      management={props.management}
      workspaceId={props.workspace.id}
      reload={reloadFresh}
      onCreated={role => savedRole(role, true)}
      onCancel={closeDialog}
      onPendingChange={setDialogPending}
    />}
    {dialogRole !== null && shown && dialog !== null && dialog.kind === 'overview' && <RoleOverviewDialog
      key={`overview:${dialogRole.id}`}
      role={dialogRole}
      catalog={shown}
      catalogSha={shown.sha256}
      management={props.management}
      workspaceId={props.workspace.id}
      reload={reloadFresh}
      onSaved={role => savedRole(role, false)}
      onCancel={closeDialog}
      onPendingChange={setDialogPending}
    />}
    {dialogRole !== null && shown && dialog !== null && dialog.kind === 'skills' && <RoleSkillsDialog
      key={`skills:${dialogRole.id}`}
      role={dialogRole}
      catalog={shown}
      catalogSha={shown.sha256}
      management={props.management}
      workspaceId={props.workspace.id}
      reload={reloadFresh}
      onSaved={role => savedRole(role, false)}
      onCancel={closeDialog}
      onPendingChange={setDialogPending}
      onManageSkills={props.onOpenSkills === undefined ? undefined : () => {
        closeDialog();
        props.onOpenSkills?.();
      }}
    />}
    {dialogRole !== null && shown && dialog !== null && dialog.kind === 'instructions' && <RolePageInstructionsDialog
      key={`instructions:${dialogRole.id}`}
      role={dialogRole}
      catalogSha={shown.sha256}
      management={props.management}
      workspaceId={props.workspace.id}
      reload={reloadFresh}
      onSaved={role => savedRole(role, false)}
      onCancel={closeDialog}
      onPendingChange={setDialogPending}
    />}
    {deleteTarget && <RoleDeleteDialog role={deleteTarget.role} shared={deleteTarget.shared} pending={deletePending} blockedReason={targetChanged ? ROLE_DATA_CHANGED_REASON : null} onCancel={closeDelete} onConfirm={() => void confirmDelete()} />}
  </div>;
}
