import { useEffect, useRef, useState, type JSX, type RefObject } from 'react';
import type { ManagementApi, ManagementError, ManagementResult, SkillDetail, SkillItem } from '../api';
import { Icon } from '../icons/Icon';
import { ShellIcon } from '../shell/ShellIcon';
import { SectionCard } from '../teams/SectionCard';
import { SkillContentDialog } from './SkillContentDialog';
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
  /** Reloads the skill list after a save so the page shows the new file. */
  onReloadCatalog?(): Promise<void>;
  /** Opens the New skill dialog prefilled with this missing skill's id. */
  onCreateSkill?(): void;
  /** True while a skill creation is being saved. */
  createPending?: boolean;
  /** False while the backend is connecting or lost; editing is unavailable. */
  connected?: boolean;
  headingRef?: RefObject<HTMLHeadingElement | null>;
}

type DetailState =
  | { kind: 'loading' }
  | { kind: 'ready'; text: string | null }
  | { kind: 'error'; error: ManagementError };

const NOTICE = 'Saved changes apply to new assignments. Assignments already running keep the skills they started with.';
const CREATE_REASON_ID = 'skills-page-create-reason';

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
  const [contentOpen, setContentOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const refocusEdit = useRef(false);

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

  // The Edit button is disabled while the refreshed detail loads, which can
  // take focus away from it after the dialog closes. Return focus once the new
  // content is ready so keyboard users continue from where they were.
  useEffect(() => {
    if (!refocusEdit.current || saving) return;
    if (detail.kind !== 'ready' || detail.text === null) return;
    refocusEdit.current = false;
    editButtonRef.current?.focus();
  }, [detail, saving]);

  const canPreview = skill.state === 'ok' || skill.state === 'truncated';
  const text = detail.kind === 'ready' ? detail.text : null;
  const editReason = missing ? null
    : skill.state === 'truncated' || skill.state === 'unreadable' ? 'Shorten the file outside the app first.'
    : saving ? 'Saving the file; wait for it to finish.'
    : props.connected === false ? 'Connect to the backend to edit this skill.'
    : detail.kind === 'loading' ? 'The content is still loading.'
    : detail.kind === 'error' || detail.text === null || skill.sha256 === null ? 'The content could not be loaded.' : null;
  const createReason = !missing ? null
    : props.createPending ? 'A skill is being created; wait for it to finish.'
    : props.connected === false ? 'Connect to the backend to create this skill.'
    : null;

  function openContent(): void {
    if (editReason !== null) return;
    setAnnouncement(null);
    setContentOpen(true);
  }

  async function savedContent(): Promise<void> {
    setContentOpen(false);
    setSaving(false);
    setAnnouncement(`Saved ${skill.path}.`);
    // Show the loading state immediately so Edit stays disabled until the
    // refreshed content arrives; the effect above returns focus then.
    refocusEdit.current = true;
    setDetail({ kind: 'loading' });
    await props.onReloadCatalog?.();
    setAttempt(value => value + 1);
  }

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
                {announcement !== null && <span className="skills-page-saved" role="status">
                  <Icon name="check-circle" size={13} tone="success" />
                  {announcement}
                </span>}
              </div>
              <span className="skills-page-subtitle">{skillHeaderNote(skill)}</span>
            </div>
          </div>
          {missing && <div className="skills-page-actions">
            <button
              type="button"
              className="skills-create-button"
              disabled={createReason !== null}
              aria-describedby={createReason !== null ? CREATE_REASON_ID : undefined}
              onClick={props.onCreateSkill}
            >Create this skill</button>
            {createReason !== null && <span id={CREATE_REASON_ID} className="skills-create-reason">{createReason}</span>}
          </div>}
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
        {missing ? <MissingCard
          createReason={createReason}
          onCreate={props.onCreateSkill}
        /> : <ContentCard
          skill={skill}
          limit={props.limits.skillBytes}
          detail={detail}
          canPreview={canPreview}
          text={text}
          editReason={editReason}
          editButtonRef={editButtonRef}
          onEdit={openContent}
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
    {contentOpen && !missing && detail.kind === 'ready' && detail.text !== null && <SkillContentDialog
      skill={skill}
      initialText={detail.text}
      limit={props.limits.skillBytes}
      roleContextLimit={props.limits.roleContextBytes}
      management={props.management}
      workspaceId={props.workspaceId}
      onClose={() => { setContentOpen(false); setSaving(false); }}
      onSaved={() => { void savedContent(); }}
      onPendingChange={setSaving}
    />}
  </div>;
}

function MissingCard(props: { createReason: string | null; onCreate?: () => void }): JSX.Element {
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
        <button
          type="button"
          className="skills-create-button is-small"
          disabled={props.createReason !== null}
          aria-describedby={props.createReason !== null ? CREATE_REASON_ID : undefined}
          onClick={props.onCreate}
        >Create this skill</button>
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
  /** Null when Edit is available; otherwise the reason shown through aria-describedby. */
  editReason: string | null;
  editButtonRef?: RefObject<HTMLButtonElement | null>;
  onEdit(): void;
  onRetry(): void;
}

const EDIT_REASON_ID = 'skills-content-edit-reason';

function ContentCard(props: ContentCardProps): JSX.Element {
  const { skill, detail } = props;
  const unreadable = skill.state === 'unreadable';
  const showStats = detail.kind === 'ready' && props.text !== null && skill.bytes !== null;
  return <SectionCard
    title="Content"
    subtitle="What the agent reads. Loaded into the role's context when an assignment starts."
    className="skills-content-card"
    action={{
      label: 'Edit',
      ariaLabel: 'Edit skill content',
      disabled: props.editReason !== null,
      descriptionId: props.editReason !== null ? EDIT_REASON_ID : undefined,
      buttonRef: props.editButtonRef,
      onClick: props.onEdit,
    }}
  >
    {props.editReason !== null && <p id={EDIT_REASON_ID} className="skills-content-edit-reason">{props.editReason}</p>}
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
