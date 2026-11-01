import { useEffect, useRef, useState, type JSX, type RefObject } from 'react';
import type {
  ManagementApi,
  ManagementError,
  ManagementResult,
  RoleCatalogList,
  SkillCatalogList,
  SkillDeleteResult,
  SkillDetail,
  SkillItem,
  SkillRolesResult,
} from '../api';
import { Icon } from '../icons/Icon';
import { ShellIcon } from '../shell/ShellIcon';
import { SectionCard } from '../teams/SectionCard';
import { SkillContentDialog } from './SkillContentDialog';
import {
  SKILL_DELETE_REASON_ID,
  SkillDeleteDialog,
  skillDeleteActionState,
} from './SkillDeleteDialog';
import {
  SKILL_ROLES_REASON_ID,
  SkillRolesDialog,
  skillRolesEditReason,
  type SkillCatalogsReload,
} from './SkillRolesDialog';
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
  /** The roles catalog loaded for the Roles screen; the dialog lists every role from it. */
  rolesCatalog?: RoleCatalogList | null;
  /** True when the skills list section is fresh. */
  skillsReady?: boolean;
  /** True when the roles catalog section is fresh. */
  rolesReady?: boolean;
  /** The roles section failure, so the disabled reason names the real cause. */
  rolesError?: ManagementError | null;
  /** The roles.json token carried by the skills list. */
  rolesSha256?: string | null;
  /** Re-reads the skills list and roles catalog after a roles write or conflict. */
  onReloadRolesCatalogs?(): Promise<SkillCatalogsReload>;
  /** Called after a successful delete (or a SKILL_NOT_FOUND that was already gone). */
  onDeleted?(result: SkillDeleteResult): void;
  /** Called when the backend says the file was already gone, so the list can refresh. */
  onAlreadyDeleted?(skillId: string): void;
  /** True while a previous delete succeeded but the list has not been refreshed. */
  refreshRequired?: boolean;
  /** Reports the delete write so the list can block its own actions. */
  onDeletePendingChange?(pending: boolean): void;
  headingRef?: RefObject<HTMLHeadingElement | null>;
}

type DetailState =
  | { kind: 'loading' }
  | { kind: 'ready'; text: string | null }
  | { kind: 'error'; error: ManagementError };

const NOTICE = 'Saved changes apply to new assignments. Assignments already running keep the skills they started with.';
const CREATE_REASON_ID = 'skills-page-create-reason';
const MISSING_ROLES_REASON_ID = 'skills-missing-roles-reason';

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
  const [rolesOpen, setRolesOpen] = useState(false);
  const [savingRoles, setSavingRoles] = useState(false);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<ManagementError | null>(null);
  const [deleteReloadFailure, setDeleteReloadFailure] = useState<string | null>(null);
  const [deleteReloading, setDeleteReloading] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const rolesCardButtonRef = useRef<HTMLButtonElement>(null);
  const rolesRowButtonRef = useRef<HTMLButtonElement>(null);
  const rolesTrigger = useRef<'card' | 'row'>('card');
  const refocusEdit = useRef(false);
  const refocusRoles = useRef(false);
  const deleteLock = useRef(false);
  const deleteLive = useRef(true);

  useEffect(() => {
    deleteLive.current = true;
    return () => {
      deleteLive.current = false;
      props.onDeletePendingChange?.(false);
    };
    // The callback only reports the delete state to the screen that owns the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // The roles catalog and skills list reload after a roles save, which disables
  // the Edit button for a moment. Return focus once both are current again.
  const rolesReason = skillRolesEditReason({
    connected: props.connected !== false,
    pending: saving || savingRoles || deletePending,
    skillsReady: props.skillsReady !== false,
    rolesReady: props.rolesReady !== false,
    roles: props.rolesCatalog ?? null,
    rolesSha256: props.rolesSha256 ?? null,
    rolesError: props.rolesError ?? null,
  });
  useEffect(() => {
    if (!refocusRoles.current || savingRoles || rolesReason !== null) return;
    refocusRoles.current = false;
    const target = rolesTrigger.current === 'row' ? rolesRowButtonRef.current : rolesCardButtonRef.current;
    target?.focus();
  }, [rolesReason, savingRoles]);

  const canPreview = skill.state === 'ok' || skill.state === 'truncated';
  const text = detail.kind === 'ready' ? detail.text : null;
  const editReason = missing ? null
    : skill.state === 'truncated' || skill.state === 'unreadable' ? 'Shorten the file outside the app first.'
    : saving ? 'Saving the file; wait for it to finish.'
    : savingRoles ? 'Saving the roles; wait for it to finish.'
    : deletePending ? 'Deleting the skill; wait for it to finish.'
    : props.connected === false ? 'Connect to the backend to edit this skill.'
    : detail.kind === 'loading' ? 'The content is still loading.'
    : detail.kind === 'error' || detail.text === null || skill.sha256 === null ? 'The content could not be loaded.' : null;
  const createReason = !missing ? null
    : props.createPending ? 'A skill is being created; wait for it to finish.'
    : props.connected === false ? 'Connect to the backend to create this skill.'
    : null;
  const deleteState = missing ? null : skillDeleteActionState({
    skill,
    connected: props.connected !== false,
    pending: saving || savingRoles || deletePending || props.createPending === true,
    refreshRequired: props.refreshRequired === true,
  });
  // The backend error carries role ids; the catalog knows their display names.
  const roleNames = Object.fromEntries(
    (props.rolesCatalog?.items ?? []).map(role => [role.id, role.name.trim() || role.id]),
  );

  function openContent(): void {
    if (editReason !== null) return;
    setAnnouncement(null);
    setContentOpen(true);
  }

  function openRoles(source: 'card' | 'row' = 'card'): void {
    if (rolesReason !== null) return;
    rolesTrigger.current = source;
    setAnnouncement(null);
    setRolesOpen(true);
  }

  function openDelete(): void {
    if (deleteState === null || deleteState.disabled) return;
    setAnnouncement(null);
    setDeleteError(null);
    setDeleteReloadFailure(null);
    setDeleteOpen(true);
  }

  function setDeleteBusy(next: boolean): void {
    if (!deleteLive.current) return;
    setDeletePending(next);
    props.onDeletePendingChange?.(next);
  }

  async function confirmDelete(): Promise<void> {
    if (deleteLock.current || deletePending || deleteState === null || deleteState.disabled) return;
    const target = props.skill;
    deleteLock.current = true;
    setDeleteBusy(true);
    setDeleteError(null);
    setDeleteReloadFailure(null);
    let result: ManagementResult<SkillDeleteResult>;
    try {
      // An unreadable or truncated file has no stable full-file token; null tells
      // the backend that its content cannot be checked before deleting.
      const fileToken = target.state === 'ok' ? target.sha256 ?? null : null;
      result = await props.management.deleteSkill(
        props.workspaceId, target.id, props.rolesSha256 ?? null, fileToken,
      );
    } catch (reason) {
      result = { ok: false, error: detailError(reason) };
    }
    if (!deleteLive.current) return;
    deleteLock.current = false;
    setDeleteBusy(false);
    if (result.ok) {
      setDeleteOpen(false);
      props.onDeleted?.(result.data);
      return;
    }
    if (result.error.code === 'SKILL_NOT_FOUND') {
      setDeleteOpen(false);
      props.onAlreadyDeleted?.(target.id);
      return;
    }
    setDeleteError(result.error);
  }

  function retryDelete(): void {
    setDeleteError(null);
    void confirmDelete();
  }

  async function reloadLatest(): Promise<void> {
    if (deletePending || deleteReloading) return;
    setDeleteError(null);
    setDeleteReloadFailure(null);
    setDeleteReloading(true);
    let result: SkillCatalogsReload | undefined;
    try {
      result = await props.onReloadRolesCatalogs?.();
    } catch (reason) {
      if (!deleteLive.current) return;
      setDeleteReloading(false);
      setDeleteReloadFailure(`Could not reload: ${detailError(reason).message}`);
      return;
    }
    if (!deleteLive.current) return;
    if (result === undefined) {
      setDeleteReloading(false);
      setDeleteReloadFailure('Could not reload the latest skill and roles.');
      return;
    }
    if (!result.skills.ok) {
      setDeleteReloading(false);
      setDeleteReloadFailure(`Could not reload the skills list: ${result.skills.error.message}`);
      return;
    }
    const fresh = result.skills.data.skills.find(item => item.id === skill.id);
    if (fresh === undefined || fresh.state === 'missing') {
      setDeleteReloading(false);
      setDeleteOpen(false);
      props.onAlreadyDeleted?.(skill.id);
      return;
    }
    if (!result.roles.ok) {
      setDeleteReloading(false);
      setDeleteReloadFailure(`Could not reload the roles catalog: ${result.roles.error.message}`);
      return;
    }
    setDeleteReloading(false);
    setDeleteError(null);
  }

  function editRolesFromDelete(): void {
    setDeleteOpen(false);
    setDeleteError(null);
    openRoles('card');
  }

  async function savedRoles(_result: SkillRolesResult): Promise<void> {
    setRolesOpen(false);
    setSavingRoles(false);
    setAnnouncement(`Saved roles for ${skill.id}.`);
    refocusRoles.current = true;
    try {
      await props.onReloadRolesCatalogs?.();
    } catch {
      // The announcement still reports the write; a failed reload leaves the
      // actions disabled with their own reason.
    }
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
          {!missing && deleteState !== null && <div className="skills-page-actions">
            <button
              type="button"
              className="skills-delete-button"
              disabled={deleteState.disabled}
              aria-describedby={SKILL_DELETE_REASON_ID}
              onClick={openDelete}
            >
              <Icon name="trash" size={14} />
              Delete skill
            </button>
          </div>}
        </div>
        {!missing && deleteState !== null && <p id={SKILL_DELETE_REASON_ID} className={`skills-delete-reason is-${deleteState.tone}`}>{deleteState.text}</p>}
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
          rolesReason={rolesReason}
          rolesButtonRef={rolesRowButtonRef}
          onEditRoles={() => openRoles('row')}
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
          action={{
            label: 'Edit',
            ariaLabel: 'Edit roles that use this skill',
            disabled: rolesReason !== null,
            descriptionId: rolesReason !== null ? SKILL_ROLES_REASON_ID : undefined,
            buttonRef: rolesCardButtonRef,
            onClick: () => openRoles('card'),
          }}
        >
          {rolesReason !== null && <p id={SKILL_ROLES_REASON_ID} className="skills-roles-reason">{rolesReason}</p>}
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
    {rolesOpen && props.rolesCatalog !== null && props.rolesCatalog !== undefined && <SkillRolesDialog
      skill={skill}
      roles={props.rolesCatalog}
      rolesSha256={props.rolesSha256 ?? null}
      management={props.management}
      workspaceId={props.workspaceId}
      onClose={() => { setRolesOpen(false); setSavingRoles(false); }}
      onSaved={(result) => { void savedRoles(result); }}
      onPendingChange={setSavingRoles}
      reloadCatalogs={() => props.onReloadRolesCatalogs?.() ?? Promise.reject(new Error('The catalogs cannot be reloaded.'))}
    />}
    {deleteOpen && !missing && <SkillDeleteDialog
      skill={skill}
      pending={deletePending}
      error={deleteError}
      roleNames={roleNames}
      reloadFailure={deleteReloadFailure}
      reloading={deleteReloading}
      onCancel={() => { setDeleteOpen(false); setDeleteError(null); setDeleteReloadFailure(null); }}
      onConfirm={() => { void confirmDelete(); }}
      onReloadLatest={() => { void reloadLatest(); }}
      onRetry={retryDelete}
      onEditRoles={editRolesFromDelete}
    />}
  </div>;
}

function MissingCard(props: {
  createReason: string | null;
  onCreate?: () => void;
  rolesReason: string | null;
  rolesButtonRef: RefObject<HTMLButtonElement | null>;
  onEditRoles(): void;
}): JSX.Element {
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
        <button
          type="button"
          ref={props.rolesButtonRef}
          className="skills-edit-roles-button"
          disabled={props.rolesReason !== null}
          aria-describedby={props.rolesReason !== null ? MISSING_ROLES_REASON_ID : undefined}
          onClick={props.onEditRoles}
        >Edit roles</button>
      </div>
      {props.rolesReason !== null && <p id={MISSING_ROLES_REASON_ID} className="skills-roles-reason">{props.rolesReason}</p>}
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
