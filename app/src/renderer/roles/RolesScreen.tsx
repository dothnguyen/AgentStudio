import { useEffect, useRef, useState, type JSX } from 'react';
import type { ConnectionStatus, ManagementApi, RoleCatalogItem, RoleCatalogList, Workspace } from '../api';
import { useDashboardSection } from '../dashboard/useDashboardSection';
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

function RoleDetails(props: { role: RoleCatalogItem }): JSX.Element {
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
  const data = catalog.data;
  const connected = !props.connection || props.connection.state === 'connected';
  const heading = useRef<HTMLHeadingElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const retried = useRef(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    {showCatalog && <>
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
          {selected && <RoleDetails role={selected.role} />}
        </div>
      </>}
    </>}
  </div>;
}
