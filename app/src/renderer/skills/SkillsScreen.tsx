import { useEffect, useRef, useState, type JSX } from 'react';
import type { ConnectionStatus, ManagementApi, SkillCatalogList, Workspace } from '../api';
import { useDashboardSection } from '../dashboard/useDashboardSection';
import { ShellIcon } from '../shell/ShellIcon';
import { filterSkills, skillRoleNames, skillSize, skillSummary } from './skillsModel';

export interface SkillsScreenProps {
  workspace: Workspace;
  management: ManagementApi;
  connection?: ConnectionStatus;
}

type SkillsView = { kind: 'list' } | { kind: 'skill'; skillId: string };

export function SkillsScreen(props: SkillsScreenProps): JSX.Element {
  return <SkillsBrowser key={props.workspace.id} {...props} />;
}

function SkillsBrowser(props: SkillsScreenProps): JSX.Element {
  const catalog = useDashboardSection<SkillCatalogList>(props.management.skills, props.workspace.id);
  const connected = !props.connection || props.connection.state === 'connected';
  const heading = useRef<HTMLHeadingElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const retried = useRef(false);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const skillHeading = useRef<HTMLHeadingElement>(null);
  const lastData = useRef<SkillCatalogList | null>(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<SkillsView>({ kind: 'list' });
  const [focusRowId, setFocusRowId] = useState<string | null>(null);
  const [focusSkillPage, setFocusSkillPage] = useState(false);

  useEffect(() => { if (catalog.state === 'ready' && retried.current) { retried.current = false; heading.current?.focus(); } }, [catalog.state]);

  if (catalog.data) lastData.current = catalog.data;
  const data = catalog.data ?? (catalog.loading ? lastData.current : null);
  const shown = data;
  const skills = shown?.skills ?? [];
  const visible = filterSkills(skills, query);
  const filtering = query.trim().length > 0;
  const countLabel = filtering
    ? `${visible.length} of ${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}`
    : `${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}`;
  const error = catalog.error;
  const limit = shown?.limits.skillBytes ?? 0;

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
    if (view.kind !== 'skill' || catalog.state !== 'ready' || data === null) return;
    if (!data.skills.some(skill => skill.id === view.skillId)) setView({ kind: 'list' });
  }, [view, catalog.state, data]);

  return <div className="skills-screen" data-section="skills">
    {view.kind === 'list' && <header className="skills-header">
      <div className="skills-heading">
        <h1>Skills</h1>
        <p className="skills-subtitle">Reusable instructions that roles load. Each skill is a folder with a SKILL.md file; a role lists the skills it uses.</p>
      </div>
    </header>}
    {view.kind === 'list' && <div className="skills-notice">
      <ShellIcon name="refresh" size={14} strokeWidth={2.2} />
      <span>Saved changes apply to new assignments. Assignments already running keep the skills they started with.</span>
    </div>}
    {!connected && <p role="status">{props.connection?.state === 'lost' ? 'Connection to the backend was lost. Saved skill data stays visible but may be out of date.' : 'Connecting to the backend… Saved skill data may be out of date.'}</p>}
    {catalog.loading && <p role="status">Loading skills…</p>}
    {error && <div className="panel-error skills-error" role="alert"><p><code>{error.code}</code>: {error.message}</p>{error.remediation && <p>{error.remediation}</p>}<button type="button" onClick={() => { retried.current = true; void catalog.reload(); }}>Retry loading skills</button></div>}
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
    {view.kind === 'skill' && <div className="skills-page" role="region" aria-label="Skill details">
      <nav className="skills-breadcrumb" aria-label="Breadcrumb">
        <ol>
          <li><button type="button" className="skills-back" onClick={backToList}>Skills</button></li>
          <li aria-current="page">{view.skillId}</li>
        </ol>
      </nav>
      <h1 tabIndex={-1} ref={skillHeading} className="skills-page-title">{view.skillId}</h1>
    </div>}
  </div>;
}
