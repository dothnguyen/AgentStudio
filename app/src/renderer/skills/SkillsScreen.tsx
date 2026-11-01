import { useEffect, useRef, useState, type JSX } from 'react';
import type { ConnectionStatus, ManagementApi, ManagementResult, RoleCatalogList, SkillCatalogList, SkillDetail, Workspace } from '../api';
import { useDashboardSection } from '../dashboard/useDashboardSection';
import { ShellIcon } from '../shell/ShellIcon';
import { SkillCreateDialog } from './SkillCreateDialog';
import { SkillPage } from './SkillPage';
import type { SkillCatalogsReload } from './SkillRolesDialog';
import { filterSkills, skillRoleNames, skillSize, skillSummary } from './skillsModel';

export interface SkillsScreenProps {
  workspace: Workspace;
  management: ManagementApi;
  connection?: ConnectionStatus;
  /** Opens the role page in the Roles screen; the member pages use the same navigation. */
  onViewRole?(roleId: string): void;
}

type SkillsView = { kind: 'list' } | { kind: 'skill'; skillId: string };

export function SkillsScreen(props: SkillsScreenProps): JSX.Element {
  return <SkillsBrowser key={props.workspace.id} {...props} />;
}

function SkillsBrowser(props: SkillsScreenProps): JSX.Element {
  const catalog = useDashboardSection<SkillCatalogList>(props.management.skills, props.workspace.id);
  // The roles dialog must list every role, including ones that do not use this
  // skill, so it reads the same roles catalog the Roles screen uses.
  const rolesSection = useDashboardSection<RoleCatalogList>(props.management.roles, props.workspace.id);
  const connected = !props.connection || props.connection.state === 'connected';
  const heading = useRef<HTMLHeadingElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const retried = useRef(false);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const skillHeading = useRef<HTMLHeadingElement>(null);
  const lastData = useRef<SkillCatalogList | null>(null);
  const lastRoles = useRef<RoleCatalogList | null>(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<SkillsView>({ kind: 'list' });
  const [focusRowId, setFocusRowId] = useState<string | null>(null);
  const [focusSkillPage, setFocusSkillPage] = useState(false);
  const [createTarget, setCreateTarget] = useState<{ initialId: string | null } | null>(null);
  const [createPending, setCreatePending] = useState(false);
  const [pendingOpenId, setPendingOpenId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => { if (catalog.state === 'ready' && retried.current) { retried.current = false; heading.current?.focus(); } }, [catalog.state]);

  if (catalog.data) lastData.current = catalog.data;
  if (rolesSection.data) lastRoles.current = rolesSection.data;
  const data = catalog.data ?? (catalog.loading ? lastData.current : null);
  const shown = data;
  const rolesData = rolesSection.data ?? (rolesSection.loading ? lastRoles.current : null);
  const skills = shown?.skills ?? [];
  const visible = filterSkills(skills, query);
  const filtering = query.trim().length > 0;
  const countLabel = filtering
    ? `${visible.length} of ${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}`
    : `${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}`;
  const error = catalog.error;
  const limit = shown?.limits.skillBytes ?? 0;
  const createBlock = !connected ? 'Skill changes are unavailable while the backend is disconnected.'
    : shown === null ? 'Skill changes are unavailable until the catalog loads.'
    : createPending ? 'A skill is being created; wait for it to finish.'
    : null;

  const openSkill = (skillId: string) => {
    setView({ kind: 'skill', skillId });
    setFocusRowId(null);
    setFocusSkillPage(true);
  };
  const backToList = () => {
    if (view.kind !== 'skill') return;
    setFocusRowId(view.skillId);
    setView({ kind: 'list' });
  };

  const refreshCatalog = async (): Promise<void> => {
    if (catalog.reloadFresh !== undefined) await catalog.reloadFresh();
    else await catalog.reload();
  };

  const refreshCatalogs = async (): Promise<SkillCatalogsReload> => {
    const skillsRequest = catalog.reloadFresh !== undefined
      ? catalog.reloadFresh()
      : catalog.reload().then(() => ({
        ok: false as const,
        error: { code: 'INTERNAL', message: 'The skills list cannot be refreshed.', retryable: true },
      }));
    const rolesRequest = rolesSection.reloadFresh !== undefined
      ? rolesSection.reloadFresh()
      : rolesSection.reload().then(() => ({
        ok: false as const,
        error: { code: 'INTERNAL', message: 'The roles catalog cannot be refreshed.', retryable: true },
      }));
    const [skills, roles] = await Promise.all([skillsRequest, rolesRequest]);
    return { skills, roles } as SkillCatalogsReload;
  };

  const openCreate = (initialId: string | null = null) => {
    if (createBlock !== null || shown === null) return;
    setAnnouncement('');
    setCreateTarget({ initialId });
  };

  const createdSkill = (detail: SkillDetail) => {
    const createdId = detail.skill.id;
    setCreateTarget(null);
    setCreatePending(false);
    setAnnouncement(`Created skill ${createdId}.`);
    // Open the new page as soon as the list has it, then keep the reload going
    // so a missing skill stops being marked missing.
    setPendingOpenId(createdId);
    void refreshCatalog().catch(() => undefined);
  };

  useEffect(() => {
    if (view.kind !== 'list' || focusRowId === null) return;
    const row = rowRefs.current.get(focusRowId);
    setFocusRowId(null);
    row?.focus();
  }, [view, focusRowId, visible.length]);

  useEffect(() => {
    if (!focusSkillPage || view.kind !== 'skill') return;
    const target = skillHeading.current;
    if (target === null) return;
    setFocusSkillPage(false);
    target.focus();
  }, [focusSkillPage, view, data]);

  useEffect(() => {
    if (pendingOpenId === null || shown === null) return;
    if (!shown.skills.some(skill => skill.id === pendingOpenId)) return;
    const openId = pendingOpenId;
    setPendingOpenId(null);
    openSkill(openId);
    // openSkill only updates local view state and is stable enough for this transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOpenId, shown]);

  const skillPage = view.kind === 'skill' ? shown?.skills.find(skill => skill.id === view.skillId) ?? null : null;
  const skillRemoved = view.kind === 'skill' && skillPage === null && catalog.state === 'ready'
    && shown !== null && !shown.skills.some(skill => skill.id === view.skillId);
  const backFromRemoved = () => {
    setView({ kind: 'list' });
    setFocusRowId(null);
  };

  return <div className="skills-screen" data-section="skills">
    {view.kind === 'list' && <header className="skills-header">
      <div className="skills-heading">
        <h1>Skills</h1>
        <p className="skills-subtitle">Reusable instructions that roles load. Each skill is a folder with a SKILL.md file; a role lists the skills it uses.</p>
      </div>
      <div className="skills-header-actions">
        <button
          type="button"
          className="skills-new-button"
          disabled={createBlock !== null}
          aria-describedby={createBlock !== null ? 'skills-create-reason' : undefined}
          onClick={() => openCreate()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          New skill
        </button>
        {createBlock !== null && <span id="skills-create-reason" className="skills-create-reason">{createBlock}</span>}
      </div>
    </header>}
    {announcement !== '' && <p role="status" className="skills-announcement">{announcement}</p>}
    {view.kind === 'list' && <div className="skills-notice">
      <ShellIcon name="refresh" size={14} strokeWidth={2.2} />
      <span>Saved changes apply to new assignments. Assignments already running keep the skills they started with.</span>
    </div>}
    {!connected && <p role="status">{props.connection?.state === 'lost' ? 'Connection to the backend was lost. Saved skill data stays visible but may be out of date.' : 'Connecting to the backend… Saved skill data may be out of date.'}</p>}
    {catalog.loading && <p role="status">Loading skills…</p>}
    {error && <div className="panel-error skills-error" role="alert"><p><code>{error.code}</code>: {error.message}</p>{error.remediation && <p>{error.remediation}</p>}<button type="button" onClick={() => { retried.current = true; void catalog.reload(); }}>Retry loading skills</button></div>}
    {rolesSection.error && <div className="panel-error skills-roles-error" role="alert"><p>Roles catalog: <code>{rolesSection.error.code}</code>: {rolesSection.error.message}</p>{rolesSection.error.remediation && <p>{rolesSection.error.remediation}</p>}<button type="button" onClick={() => { void rolesSection.reload(); }}>Retry loading roles</button></div>}
    {view.kind === 'list' && shown && <>
      {shown.problems.length > 0 && <div className="panel-note skills-problems"><p>Skill catalog problems</p><ul>{shown.problems.map((problem, index) => <li key={index}>{problem.path ? `${problem.path}: ` : ''}{problem.message}</li>)}</ul></div>}
      {skills.length === 0 && <p className="skills-empty">No skills yet. A skill is a folder <code>.agent-studio/skills/&lt;id&gt;/SKILL.md</code>.</p>}
      {skills.length > 0 && <>
        <h2 tabIndex={-1} ref={heading} className="skills-visually-hidden">Skill catalog</h2>
        <div className="skills-toolbar">
          <label className="skills-search">
            <span className="skills-visually-hidden">Search skills</span>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input ref={search} type="search" placeholder="Search skills" value={query} onChange={event => setQuery(event.target.value)} />
          </label>
          <p className="skills-count">{countLabel}</p>
        </div>
        {visible.length === 0
          ? <p className="skills-no-match">{`No skill matches "${query.trim()}".`} <button type="button" onClick={() => { setQuery(''); search.current?.focus(); }}>Clear search</button></p>
          : <section className="skills-table-card" aria-label="Skill catalog">
            <p id="skills-table-columns" className="skills-visually-hidden">Columns: Skill, Summary, Used by roles, Size.</p>
            <div className="skills-table-scroll">
              <div className="skills-table">
                <div className="skills-table-head" aria-hidden="true"><span>Skill</span><span>Summary</span><span>Used by roles</span><span>Size</span><span /></div>
                <ul className="skills-table-list" aria-label="Saved skills">{visible.map(skill => {
                  const summary = skillSummary(skill);
                  const size = skillSize(skill, limit);
                  const roles = skillRoleNames(skill);
                  return <li key={skill.id}>
                    <button type="button" className="skills-row" data-skill-id={skill.id} aria-label={`Open skill ${skill.id}`} aria-describedby="skills-table-columns"
                      ref={element => { if (element) rowRefs.current.set(skill.id, element); else rowRefs.current.delete(skill.id); }}
                      onClick={() => openSkill(skill.id)}>
                      <span className="skills-cell skills-skill-cell">
                        <span className={`skills-badge${skill.state === 'missing' ? ' is-warning' : ''}`} aria-hidden="true"><ShellIcon name="skills" /></span>
                        <span className="skills-skill-text">
                          <span className="skills-skill-id">{skill.id}</span>
                          <span className="skills-skill-path">{skill.path}</span>
                        </span>
                      </span>
                      <span className={`skills-cell skills-summary${summary.warning ? ' is-warning' : ''}`}>{summary.text}</span>
                      <span className="skills-cell skills-usedby">
                        {roles.length === 0
                          ? <span className="skills-usedby-none">Not used</span>
                          : <>
                            {roles.slice(0, 2).map((name, index) => <span key={`${name}:${index}`} className="skills-role-chip">{name}</span>)}
                            {roles.length > 2 && <span className="skills-role-more">+{roles.length - 2}</span>}
                          </>}
                      </span>
                      <span className="skills-cell skills-size">
                        <span className={`skills-size-primary${size.warning ? ' is-warning' : ''}`}>{size.primary}</span>
                        {size.secondary && <span className={`skills-size-note${size.noteWarning ? ' is-warning' : ''}`}>{size.secondary}</span>}
                      </span>
                      <span className="skills-cell skills-chevron" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg></span>
                    </button>
                  </li>;
                })}</ul>
              </div>
            </div>
          </section>}
      </>}
    </>}
    {view.kind === 'skill' && skillPage !== null && shown !== null && <SkillPage
      skill={skillPage}
      limits={shown.limits}
      management={props.management}
      workspaceId={props.workspace.id}
      onBack={backToList}
      onViewRole={props.onViewRole}
      connected={connected}
      onCreateSkill={() => openCreate(skillPage.id)}
      createPending={createPending}
      onReloadCatalog={refreshCatalog}
      rolesCatalog={rolesData}
      skillsReady={catalog.state === 'ready'}
      rolesReady={rolesSection.state === 'ready'}
      rolesError={rolesSection.error}
      rolesSha256={shown.rolesSha256}
      onReloadRolesCatalogs={refreshCatalogs}
      headingRef={skillHeading}
    />}
    {view.kind === 'skill' && skillRemoved && <div className="skills-page skills-removed" role="region" aria-label="Skill details">
      <nav className="skills-breadcrumb" aria-label="Breadcrumb">
        <ol>
          <li><button type="button" className="skills-back" onClick={backFromRemoved}>Skills</button></li>
          <li aria-current="page">{view.skillId}</li>
        </ol>
      </nav>
      <p className="skills-removed-text">This skill no longer exists.</p>
      <button type="button" className="skills-removed-back" onClick={backFromRemoved}>Back to skills</button>
    </div>}
    {createTarget !== null && shown !== null && <SkillCreateDialog
      catalog={shown}
      initialId={createTarget.initialId}
      management={props.management}
      workspaceId={props.workspace.id}
      limit={shown.limits.skillBytes}
      onClose={() => { setCreateTarget(null); setCreatePending(false); }}
      onCreated={createdSkill}
      onPendingChange={setCreatePending}
      onRefreshCatalog={refreshCatalog}
    />}
  </div>;
}
