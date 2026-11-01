import { useEffect, useState, type JSX, type RefObject } from 'react';
import type { ManagementApi, ManagementError, ManagementResult, SkillDetail, SkillItem } from '../api';
import { Icon } from '../icons/Icon';
import { ShellIcon } from '../shell/ShellIcon';
import { SectionCard } from '../teams/SectionCard';
import {
  formatRoleContext,
  formatSkillStats,
  roleInitial,
  skillDetailsSize,
  skillDetailsTitle,
  skillHeaderNote,
  skillTruncatedNote,
  skillUsage,
} from './skillsModel';

export interface SkillPageProps {
  skill: SkillItem;
  limits: { skillBytes: number; roleContextBytes: number };
  management: ManagementApi;
  workspaceId: string;
  onBack(): void;
  onViewRole?(roleId: string): void;
  headingRef?: RefObject<HTMLHeadingElement | null>;
}

type DetailState =
  | { kind: 'loading' }
  | { kind: 'ready'; text: string | null }
  | { kind: 'error'; error: ManagementError };

const NOTICE = 'Saved changes apply to new assignments. Assignments already running keep the skills they started with.';

function detailError(reason: unknown): ManagementError {
  return {
    code: 'INTERNAL',
    message: reason instanceof Error ? reason.message : String(reason),
    retryable: false,
  };
}

/** Read-only skill page: header, content preview, details and the roles that load it. */
export function SkillPage(props: SkillPageProps): JSX.Element {
  const { skill } = props;
  const missing = skill.state === 'missing';
  const usage = skillUsage(skill);
  const [detail, setDetail] = useState<DetailState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setDetail({ kind: 'loading' });
    let request: Promise<ManagementResult<SkillDetail>>;
    try {
      request = props.management.skill(props.workspaceId, skill.id);
    } catch (reason) {
      request = Promise.resolve({ ok: false as const, error: detailError(reason) });
    }
    Promise.resolve(request).then(
      result => {
        if (!active) return;
        setDetail(result.ok ? { kind: 'ready', text: result.data.text } : { kind: 'error', error: result.error });
      },
      reason => {
        if (!active) return;
        setDetail({ kind: 'error', error: detailError(reason) });
      },
    );
    return () => { active = false; };
  }, [props.management, props.workspaceId, skill.id, skill.sha256, attempt]);

  const canPreview = skill.state === 'ok' || skill.state === 'truncated';
  const text = detail.kind === 'ready' ? detail.text : null;

  return <div className="skills-page" role="region" aria-label="Skill details">
    <div className="skills-page-top">
      <nav className="skills-breadcrumb" aria-label="Breadcrumb">
        <ol>
          <li><button type="button" className="skills-back" onClick={props.onBack}>Skills</button></li>
          <li aria-current="page">{skill.id}</li>
        </ol>
      </nav>
      <header className="skills-page-header">
        <div className="skills-page-heading-row">
          <div className="skills-page-identity">
            <span className={`skills-page-icon${missing ? ' is-missing' : ''}`} aria-hidden="true">
              <ShellIcon name="skills" size={22} strokeWidth={1.8} />
            </span>
            <div className="skills-page-identity-text">
              <div className="skills-page-title-row">
                <h1 tabIndex={-1} ref={props.headingRef} className="skills-page-title">{skill.id}</h1>
                <span className={`skills-page-pill is-${usage.tone}`}>{usage.text}</span>
              </div>
              <span className="skills-page-subtitle">{skillHeaderNote(skill)}</span>
            </div>
          </div>
        </div>
        {missing && <div className="skills-missing-note">
          <Icon name="warning" size={14} tone="warning" />
          <span>Roles refer to this skill but <code>{skill.path}</code> does not exist, so it is skipped when assignments start. Create it, or remove it from the roles that list it.</span>
        </div>}
        <div className="skills-notice">
          <ShellIcon name="refresh" size={14} strokeWidth={2.2} />
          <span>{NOTICE}</span>
        </div>
      </header>
    </div>

    <div className="skills-page-layout">
      <div className="skills-page-main">
        {missing ? <MissingCard /> : <ContentCard
          skill={skill}
          limit={props.limits.skillBytes}
          detail={detail}
          canPreview={canPreview}
          text={text}
          onRetry={() => setAttempt(value => value + 1)}
        />}
      </div>

      <aside className="skills-page-aside" aria-label="Skill details and roles">
        <SectionCard
          title="Details"
          subtitle="The folder name is the skill's id and cannot change."
          className="skills-details-card"
        >
          <dl className="skills-details-grid">
            <div><dt>Skill id</dt><dd><code>{skill.id}</code></dd></div>
            <div><dt>File</dt><dd><code className="skills-details-path">{skill.path}</code></dd></div>
            <div><dt>Title</dt><dd>{skillDetailsTitle(skill)}</dd></div>
            <div><dt>Size</dt><dd>{skillDetailsSize(skill, props.limits.skillBytes)}</dd></div>
          </dl>
        </SectionCard>

        <SectionCard
          title="Used by roles"
          subtitle="Roles that load this skill."
          className="skills-usedby-card"
        >
          {skill.roles.length === 0
            ? <p className="skills-usedby-empty">No role uses this skill yet.</p>
            : <ul className="skills-usedby-list" aria-label="Roles that use this skill">{skill.roles.map(role => {
              const name = role.name?.trim() || role.id;
              const context = formatRoleContext(role.contextBytes, props.limits.roleContextBytes);
              return <li className="skills-usedby-row" key={role.id}>
                <span className="skills-usedby-avatar" aria-hidden="true">{roleInitial(name)}</span>
                <span className="skills-usedby-text">
                  <span className="skills-usedby-name">{name}</span>
                  <span className={`skills-usedby-context${context.warning ? ' is-warning' : ''}`}>{context.text}</span>
                </span>
                <button
                  type="button"
                  className="skills-usedby-open"
                  aria-label={`Open role ${name}`}
                  onClick={() => props.onViewRole?.(role.id)}
                >Open</button>
              </li>;
            })}</ul>}
        </SectionCard>
      </aside>
    </div>
  </div>;
}

function MissingCard(): JSX.Element {
  return <SectionCard
    title="No SKILL.md yet"
    subtitle="Two ways to fix the roles that list this skill."
    className="skills-missing-card"
  >
    <div className="skills-missing-options">
      <div className="skills-missing-option">
        <span className="skills-missing-option-text">
          <span className="skills-missing-option-title">Create the file</span>
          <span className="skills-missing-option-description">Start from a template and write the skill.</span>
        </span>
      </div>
      <div className="skills-missing-option">
        <span className="skills-missing-option-text">
          <span className="skills-missing-option-title">Remove it from the roles</span>
          <span className="skills-missing-option-description">Stop listing a skill that does not exist.</span>
        </span>
      </div>
    </div>
  </SectionCard>;
}

interface ContentCardProps {
  skill: SkillItem;
  limit: number;
  detail: DetailState;
  canPreview: boolean;
  text: string | null;
  onRetry(): void;
}

function ContentCard(props: ContentCardProps): JSX.Element {
  const { skill, detail } = props;
  const unreadable = skill.state === 'unreadable';
  const showStats = detail.kind === 'ready' && props.text !== null && skill.bytes !== null;
  return <SectionCard
    title="Content"
    subtitle="What the agent reads. Loaded into the role's context when an assignment starts."
    className="skills-content-card"
  >
    <div className="skills-content-head">
      <span className="skills-content-file"><Icon name="document" size={13} /><code>{skill.path}</code></span>
      {showStats && <span className="skills-content-stats">{formatSkillStats(props.text!, skill.bytes!, props.limit)}</span>}
    </div>
    {unreadable
      ? <p className="skills-content-empty">{'The file cannot be read.'}</p>
      : <>{detail.kind === 'loading' && <p className="skills-content-empty" role="status">Loading content…</p>}
        {detail.kind === 'error' && <div className="panel-error skills-content-error" role="alert">
          <p><code>{detail.error.code}</code>: {detail.error.message}</p>
          {detail.error.remediation && <p>{detail.error.remediation}</p>}
          <button type="button" onClick={props.onRetry}>Retry loading content</button>
        </div>}
        {detail.kind === 'ready' && (props.canPreview && props.text !== null
          ? <div className="skills-content-preview">
            <pre>{props.text}</pre>
            <div className="skills-content-fade" aria-hidden="true" />
          </div>
          : <p className="skills-content-empty">{'The file cannot be read.'}</p>)}</>}
    {skill.state === 'truncated' && <p className="skills-content-note">{skillTruncatedNote(props.limit)}</p>}
  </SectionCard>;
}
