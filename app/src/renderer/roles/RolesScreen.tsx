import { useEffect, useRef, useState, type JSX, type RefObject } from 'react';
import type { ConnectionStatus, ManagementApi, ManagementError, RoleCatalogItem, RoleCatalogList, Workspace } from '../api';
import { useDashboardSection } from '../dashboard/useDashboardSection';
import { RoleForm, type RoleFormConflict, type RoleFormPhase } from './RoleForm';
import { buildRoleSavePlan, type RoleFormField, type RoleFormMode, type RoleFormValues } from './roleEditModel';
import { assignedMemberLabels, filterRoleRows, roleDisplayLabel, roleInitials, roleIssueSummary, roleRows, roleRuntimeState, roleUsageProblems, selectedRoleId } from './rolesModel';

export interface RolesScreenProps { workspace: Workspace; management: ManagementApi; connection?: ConnectionStatus }
export function RolesScreen(props: RolesScreenProps): JSX.Element { return <RolesBrowser key={props.workspace.id} {...props} />; }

const INSTRUCTION_MESSAGES: Record<string, string> = {
  none: 'No shared instruction file configured.',
  missing: 'The configured instruction file is missing.',
  invalid: 'Shared instructions are unavailable because the configured file is invalid or unsafe.',
};

function ProblemList(props: { title: string; items: Array<{ path: string; message: string }> }): JSX.Element | null {
  if (props.items.length === 0) return null;
  return <><h4>{props.title}</h4><ul>{props.items.map((p, i) => <li key={i}>{p.path ? `${p.path}: ` : ''}{p.message}</li>)}</ul></>;
}

function RoleDetails(props: { role: RoleCatalogItem; onEdit(): void; editDisabled: boolean; editReasonId: string | null }): JSX.Element {
  const { role } = props;
  const label = roleDisplayLabel(role);
  const instructions = role.instructions;
  const members = assignedMemberLabels(role);
  const usageProblems = roleUsageProblems(role);
  const runtime = roleRuntimeState(role);
  const showsText = (instructions.state === 'ok' || instructions.state === 'truncated') && instructions.text !== null;
  return <section className="dashboard-panel roles-details" aria-labelledby="roles-details-heading">
    <h2 id="roles-details-heading">Role details</h2>
    <h3>{label}</h3>
    <p><button type="button" className="roles-edit-button" disabled={props.editDisabled} aria-describedby={props.editReasonId ?? undefined} onClick={props.onEdit}>Edit role</button></p>
    <p>ID: <code>{role.id}</code></p>
    {label !== role.id && <p>Display name: {label}</p>}
    <p>{role.description?.trim() ? role.description : 'No description'}</p>
    <h3>Shared instructions</h3>
    <p>Shared instructions are read when an assignment starts; later edits apply to new assignments only.</p>
    {instructions.path && <p>Instruction file: <code>{instructions.path}</code></p>}
    {instructions.state !== 'ok' && instructions.state !== 'truncated' && <p>{INSTRUCTION_MESSAGES[instructions.state]}</p>}
    {showsText && <pre className="roles-instructions">{instructions.text}</pre>}
    {instructions.state === 'truncated' && <p>Instruction content is truncated.</p>}
    <h3>Configured skills</h3>
    {role.skills.length === 0 ? <p>No skills configured.</p> : <ul>{role.skills.map((skill, i) => <li key={`${skill.id}:${i}`}><code>{skill.id}</code> — {skill.state === 'ok' ? 'Available' : 'Missing'}</li>)}</ul>}
    <h3>Warnings and problems</h3>
    <p>{roleIssueSummary(role)}</p>
    {role.warnings.length > 0 && <><h4>Warnings</h4><ul>{role.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></>}
    <ProblemList title="Role problems" items={role.problems} />
    <ProblemList title="Assignment source problems" items={usageProblems} />
    <h3>Assigned members</h3>
    {role.usage.partial && <p>Assigned-member results are incomplete.</p>}
    {runtime !== 'connected' && <p>Live assignments are unavailable; saved assignments remain shown.</p>}
    {members.length === 0 ? (!role.usage.partial && <p>No saved or live member assignments found.</p>) : <ul>{members.map((m, i) => <li key={`${m.key}:${i}`}>
      {m.team}{m.teamId && m.teamId !== m.team && <> (<code>{m.teamId}</code>)</>} — {m.member}{m.memberId && m.memberId !== m.member && <> (<code>{m.memberId}</code>)</>}
      {m.states.length > 0 && <> · {m.states.join(' and ')}</>}{m.runtime && <> · {m.runtime}</>}
    </li>)}</ul>}
    <p>Roles do not grant permissions and do not choose agents; those come from team and agent settings.</p>
  </section>;
}

function RolesBrowser(props: RolesScreenProps): JSX.Element {
  const catalog = useDashboardSection<RoleCatalogList>(props.management.roles, props.workspace.id);
  const connected = !props.connection || props.connection.state === 'connected';
  const heading = useRef<HTMLHeadingElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const retried = useRef(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const edit = useRoleEditing(props, catalog, setSelectedId, setQuery, search);
  const data = edit.displayed;
  useEffect(() => { if (catalog.state === 'ready' && retried.current) { retried.current = false; heading.current?.focus(); } }, [catalog.state]);

  const rows = roleRows(data?.items ?? []);
  const visible = filterRoleRows(rows, query);
  const currentId = selectedRoleId(visible, selectedId);
  const selected = visible.find(row => row.role.id === currentId) ?? null;
  const error = catalog.error;
  const showCatalog = data !== null;
  const invalid = data?.state === 'invalid';

  return <div className="roles-screen" data-section="roles">
    <header className="dashboard-header roles-header"><div>
      <nav aria-label="Breadcrumb" className="breadcrumb"><ol><li>Workspace</li><li aria-current="page">Roles</li></ol></nav>
      <h1>Roles</h1>
      <p>Browse reusable roles saved in this workspace. Shared instructions are read when an assignment starts.</p>
    </div></header>
    {!connected && <p role="status">{props.connection?.state === 'lost' ? 'Connection to the backend was lost. Saved role data stays visible but may be out of date.' : 'Connecting to the backend… Saved role data may be out of date.'}</p>}
    {catalog.loading && <p role="status">Loading roles…</p>}
    {error && <div className="panel-error roles-error" role="alert"><p><code>{error.code}</code>: {error.message}</p>{error.remediation && <p>{error.remediation}</p>}<button type="button" onClick={() => { retried.current = true; void catalog.reload(); }}>Retry loading roles</button></div>}
    {edit.announcement && <p role="status" className="roles-saved">{edit.announcement}</p>}
    {showCatalog && <>
      <div className="roles-toolbar"><button type="button" className="roles-new-button" disabled={edit.mutationBlock !== null} aria-describedby={edit.mutationBlock ? 'roles-mutation-reason' : undefined} onClick={() => edit.open('create', null)}>New role</button>
        {edit.mutationBlock && <span id="roles-mutation-reason">{edit.mutationBlock}</span>}</div>
      {data.state === 'missing' && <p>No roles catalog is configured for this workspace.</p>}
      {invalid && <div className="panel-note roles-problems" role="alert"><p>Roles catalog is invalid.</p><ul>{data.problems.map((p, i) => <li key={i}>{p.path ? `${p.path}: ` : ''}{p.message}</li>)}</ul></div>}
      {!invalid && data.problems.length > 0 && <div className="panel-note roles-problems"><p>Roles catalog problems</p><ul>{data.problems.map((p, i) => <li key={i}>{p.path ? `${p.path}: ` : ''}{p.message}</li>)}</ul></div>}
      {data.state === 'ok' && rows.length === 0 && <p>No roles are configured yet.</p>}
      {rows.length > 0 && <>
        <h2 tabIndex={-1} ref={heading}>Role catalog</h2>
        <div className="roles-search"><label>Search roles<input ref={search} type="search" placeholder="Search roles…" value={query} onChange={e => setQuery(e.target.value)} /></label></div>
        <p className="roles-count">{visible.length} {visible.length === 1 ? 'role' : 'roles'}</p>
        {visible.length === 0 && <p>No roles match this search. <button type="button" onClick={() => { setQuery(''); search.current?.focus(); }}>Clear search</button></p>}
        <div className="roles-layout">
          <ul className="roles-list" aria-label="Saved roles">{visible.map(row => <li key={row.key}>
            <button type="button" className="roles-row" aria-current={selected?.key === row.key ? 'true' : undefined} onClick={() => setSelectedId(row.role.id)}>
              <span className="roles-initials" aria-hidden="true">{roleInitials(row.role)}</span>
              <strong>{roleDisplayLabel(row.role)}</strong>
              <span>{row.role.id}</span>
            </button></li>)}</ul>
          {selected && <RoleDetails role={selected.role} editDisabled={edit.mutationBlock !== null || data.state !== 'ok'} editReasonId={edit.mutationBlock ? 'roles-mutation-reason' : null} onEdit={() => edit.open('edit', selected.role)} />}
        </div>
      </>}
    </>}
    {edit.dialog}
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

const TOKENS_MESSAGE = 'Metadata and skills were saved, but current instruction tokens could not be loaded. Reload and review before saving instructions.';
const INSTRUCTIONS_MESSAGE = 'Metadata and skills were saved; shared instructions were not saved.';
const VERIFY_MESSAGE = 'The save completed, but the catalog could not be reloaded to verify it. Reload and review.';
const changedError = (remediation?: string): ManagementError => ({ code: 'CONFIG_CHANGED', message: 'Another edit was saved first.', retryable: true, remediation });
const normalize = (reason: unknown): ManagementError => ({ code: 'INTERNAL', message: String(reason), retryable: false });
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
    const row = root?.querySelector<HTMLElement>('.roles-row[aria-current="true"]');
    const target = focusTarget.kind === 'opener' && focusTarget.opener?.isConnected ? focusTarget.opener : row ?? search.current;
    target?.focus();
    setFocusTarget(null);
  }, [focusTarget, search]);

  const data = displayed;
  const mutationBlock = !connected ? 'Role changes are unavailable while the backend is disconnected.'
    : !data ? 'Role changes are unavailable until the catalog loads.'
    : data.state === 'invalid' || data.problems.length > 0 ? 'Role changes are unavailable while the roles catalog has problems.'
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
    let wrote = false;
    let createdOrEdited: string | null = start.base?.id ?? null;
    const fail = (error: ManagementError, notice: string | null = null) => {
      setPending(false); setPhase('idle');
      setPartialNotice(notice);
      setServerError(error);
      setConflict(null);
    };
    try {
      const plan = buildRoleSavePlan(start.mode, start.base, values);
      if (plan.create) {
        setPhase('saving_metadata');
        const r = await guarded(() => management.createRole(workspaceId, plan.create!, start.catalogSha));
        if (!live()) return;
        if (!r.ok) return fail(r.error);
        wrote = true;
        createdOrEdited = r.data.role.id;
        patch({ mode: 'edit', base: r.data.role, catalogSha: r.data.sha256, metadataSaved: true });
      } else if (plan.metadata && start.base) {
        setPhase('saving_metadata');
        const r = await guarded(() => management.updateRole(workspaceId, start.base!.id, plan.metadata!, start.catalogSha!));
        if (!live()) return;
        if (!r.ok) return fail(r.error);
        wrote = true;
        patch({ base: r.data.role, catalogSha: r.data.sha256, metadataSaved: true });
      }
      const roleId = createdOrEdited;
      if (!roleId) return fail(normalize('Role id is missing.'));
      if (plan.instructionsChanged) {
        if (wrote) {
          setPhase('reloading_tokens');
          const reloaded = await fresh();
          if (!live()) return;
          const role = reloaded.ok ? reloaded.data.items.find(item => item.id === roleId) : undefined;
          if (!reloaded.ok || !role) return fail(reloaded.ok ? normalize(`Role ${roleId} was not found after saving.`) : reloaded.error, TOKENS_MESSAGE);
          patch({ base: role, catalogSha: reloaded.data.sha256 });
        }
        setPhase('saving_instructions');
        const current = sessionRef.current!;
        const r = await guarded(() => management.updateRoleInstructions(workspaceId, roleId, values.instructions, current.catalogSha!, current.base!.instructions.sha256));
        if (!live()) return;
        if (!r.ok) return fail(r.error, sessionRef.current?.metadataSaved ? INSTRUCTIONS_MESSAGE : null);
        wrote = true;
        patch({ base: r.data.role, catalogSha: r.data.sha256 });
      }
      setPhase('verifying');
      const verified = await fresh();
      if (!live()) return;
      const role = verified.ok ? verified.data.items.find(item => item.id === roleId) : undefined;
      if (!verified.ok || !role) return fail(verified.ok ? normalize(`Role ${roleId} was not found after saving.`) : verified.error, VERIFY_MESSAGE);
      select(roleId);
      setQuery('');
      if (wrote) setAnnouncement(`${start.mode === 'create' ? 'Created' : 'Saved'} role "${role.name}" (${role.id}). Saved changes apply to new assignments; current assignments are unchanged.`);
      close('role');
    } catch (reason) {
      if (live()) fail(normalize(reason));
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

  return { displayed, mutationBlock, open, dialog, announcement };
}
