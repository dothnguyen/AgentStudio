import { useEffect, useRef, useState, type JSX } from 'react';
import type {
  ManagementApi,
  ManagementError,
  ManagementResult,
  RoleCatalogList,
  SkillCatalogList,
  SkillItem,
  SkillRolesResult,
} from '../api';
import { Dialog } from '../teams/Dialog';

export const SKILL_ROLES_CONFLICT_MESSAGE = 'roles.json changed since you opened this. Reload to see the latest roles.';
export const SKILL_ROLES_ROLE_MISSING_MESSAGE = 'A role in your selection no longer exists.';
export const SKILL_ROLES_SKILL_MISSING_MESSAGE = 'The skill file no longer exists.';
export const SKILL_ROLES_GENERIC_ERROR = 'Roles could not be saved. Check the Agent Studio connection, then retry.';
export const SKILL_ROLES_REASON_ID = 'skill-roles-edit-reason';
export const SKILL_ROLES_CREATE_FIRST = 'Create the skill first to add it to a role.';

export interface SkillCatalogsReload {
  skills: ManagementResult<SkillCatalogList>;
  roles: ManagementResult<RoleCatalogList>;
}

export interface SkillRolesEditReasonInput {
  connected: boolean;
  pending: boolean;
  skillsReady: boolean;
  rolesReady: boolean;
  roles: RoleCatalogList | null;
  rolesSha256: string | null;
  /** The roles section failure, so the disabled reason names the real cause. */
  rolesError?: ManagementError | null;
}

/**
 * Why the roles Edit action is unavailable, or null when it may open. It reuses
 * the Roles screen rule (an ok catalog without problems) and also waits for the
 * skills list and roles catalog to be current and agree on roles.json.
 */
export function skillRolesEditReason(args: SkillRolesEditReasonInput): string | null {
  if (args.pending) return 'Saving roles; wait for it to finish.';
  if (!args.connected) return 'Connect to the backend to edit which roles use this skill.';
  if (!args.skillsReady) return 'Role changes are unavailable until the skills list is current.';
  if (args.rolesError !== null && args.rolesError !== undefined) {
    return `Role changes are unavailable: ${args.rolesError.code}: ${args.rolesError.message}`;
  }
  if (!args.rolesReady || args.roles === null) return 'Role changes are unavailable until the roles catalog loads.';
  if (args.roles.state === 'missing') return 'Role changes are unavailable until a roles catalog exists.';
  if (args.roles.state !== 'ok' || args.roles.problems.length > 0) {
    return 'Role changes are unavailable while the roles catalog has problems.';
  }
  if (args.rolesSha256 === null || args.roles.sha256 === null || args.roles.sha256 !== args.rolesSha256) {
    return 'Role changes are unavailable until the roles catalog is reloaded.';
  }
  return null;
}

interface RoleRowView {
  id: string;
  name: string;
}

function normalizeError(reason: unknown): ManagementError {
  return { code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false };
}

function roleRows(skill: SkillItem, catalog: RoleCatalogList): RoleRowView[] {
  const rows: RoleRowView[] = catalog.items.map((role) => ({
    id: role.id,
    name: role.name.trim() || role.id,
  }));
  const known = new Set(rows.map((row) => row.id));
  // A role the skill lists but the catalog no longer has must stay visible so
  // saving cannot silently drop its reference.
  for (const role of skill.roles) {
    if (!known.has(role.id)) rows.push({ id: role.id, name: role.name?.trim() || role.id });
  }
  return rows;
}

function messageFor(error: ManagementError): string {
  if (error.code === 'CONFIG_CHANGED') return SKILL_ROLES_CONFLICT_MESSAGE;
  if (error.code === 'ROLE_NOT_FOUND') return SKILL_ROLES_ROLE_MISSING_MESSAGE;
  if (error.code === 'SKILL_NOT_FOUND') return SKILL_ROLES_SKILL_MISSING_MESSAGE;
  return SKILL_ROLES_GENERIC_ERROR;
}

export interface SkillRolesDialogProps {
  skill: SkillItem;
  /** The roles catalog loaded for the Roles screen; it lists every role. */
  roles: RoleCatalogList;
  /** roles.json version from the skills list, sent with the write. */
  rolesSha256: string | null;
  management: ManagementApi;
  workspaceId: string;
  onClose(): void;
  onSaved(result: SkillRolesResult): void;
  onPendingChange?(pending: boolean): void;
  /** Re-reads both the skills list and the roles catalog for a conflict reload. */
  reloadCatalogs(): Promise<SkillCatalogsReload>;
}

/**
 * "Roles that use <id>" checklist. Every catalog role is listed with its draft
 * state; saving writes the complete checked list through updateSkillRoles with
 * the roles.json token from the skills list.
 */
export function SkillRolesDialog(props: SkillRolesDialogProps): JSX.Element {
  const [currentSkill, setCurrentSkill] = useState(props.skill);
  const [catalog, setCatalog] = useState(props.roles);
  const initialIds = useRef(new Set(props.skill.roles.map((role) => role.id)));
  const [checked, setChecked] = useState<Set<string>>(() => new Set(initialIds.current));
  const [pending, setPending] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<ManagementError | null>(null);
  const [reloadFailure, setReloadFailure] = useState<string | null>(null);
  const [reloaded, setReloaded] = useState(false);
  const sha = useRef<string | null>(props.rolesSha256);
  const firstRow = useRef<HTMLButtonElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      props.onPendingChange?.(false);
    };
    // The callback is owned by the page and only reports the write state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (error !== null || reloadFailure !== null) alertRef.current?.focus();
  }, [error, reloadFailure]);

  function setBusy(next: boolean): void {
    if (!live.current) return;
    setPending(next);
    props.onPendingChange?.(next);
  }

  const rows = roleRows(currentSkill, catalog);
  const currentIds = new Set(currentSkill.roles.map((role) => role.id));
  const missing = currentSkill.state === 'missing';
  const same = checked.size === currentIds.size && [...checked].every((id) => currentIds.has(id));
  const saveDisabled = pending || reloading || same;
  const conflict = error?.code === 'CONFIG_CHANGED';
  const roleMissing = error?.code === 'ROLE_NOT_FOUND';
  const skillMissing = error?.code === 'SKILL_NOT_FOUND';
  const generic = error !== null && !conflict && !roleMissing && !skillMissing;

  function toggle(row: RoleRowView): void {
    if (pending || reloading) return;
    // A missing file cannot be added to a role, but existing references can be removed.
    if (missing && !currentIds.has(row.id)) return;
    setReloaded(false);
    // Keep a conflict: retrying without fresh tokens would only conflict again,
    // and the person still needs the Reload latest action.
    setError((current) => current !== null && current.code === 'CONFIG_CHANGED' ? current : null);
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
      return next;
    });
  }

  async function reloadLatest(): Promise<void> {
    if (pending || reloading) return;
    setReloadFailure(null);
    setReloaded(false);
    setReloading(true);
    let result: SkillCatalogsReload;
    try {
      result = await props.reloadCatalogs();
    } catch (reason) {
      if (!live.current) return;
      setReloading(false);
      setReloadFailure(`Could not reload: ${normalizeError(reason).message}`);
      return;
    }
    if (!live.current) return;
    setReloading(false);
    if (!result.skills.ok) {
      setReloadFailure(`Could not reload the skills list: ${result.skills.error.message}`);
      return;
    }
    const fresh = result.skills.data.skills.find((item) => item.id === currentSkill.id);
    if (fresh === undefined || fresh.state === 'missing') {
      setError({ code: 'SKILL_NOT_FOUND', message: SKILL_ROLES_SKILL_MISSING_MESSAGE, retryable: false });
      return;
    }
    if (!result.roles.ok) {
      setReloadFailure(`Could not reload the roles catalog: ${result.roles.error.message}`);
      return;
    }
    const nextRoles = new Set(result.roles.data.items.map((role) => role.id));
    setCurrentSkill(fresh);
    setCatalog(result.roles.data);
    sha.current = result.skills.data.rolesSha256;
    setChecked((draft) => new Set([...draft].filter((id) => nextRoles.has(id))));
    setError(null);
    setReloaded(true);
  }

  async function save(): Promise<void> {
    if (saveDisabled) return;
    setError(null);
    setReloadFailure(null);
    setReloaded(false);
    setBusy(true);
    const wanted = rows.filter((row) => checked.has(row.id)).map((row) => row.id);
    let result: ManagementResult<SkillRolesResult>;
    try {
      result = await props.management.updateSkillRoles(props.workspaceId, currentSkill.id, wanted, sha.current);
    } catch (reason) {
      result = { ok: false, error: normalizeError(reason) };
    }
    if (!live.current) return;
    setBusy(false);
    if (result.ok) {
      props.onSaved(result.data);
      return;
    }
    setError(result.error);
    if (result.error.code === 'ROLE_NOT_FOUND') void reloadLatest();
  }

  return <Dialog
    title={`Roles that use ${currentSkill.id}`}
    subtitle="Adds or removes the skill in each role's list."
    width={560}
    busy={pending}
    onClose={props.onClose}
    footerNote="Saved to roles.json"
    initialFocus={firstRow}
    className="skill-roles-dialog"
    actions={[
      { label: 'Cancel', onClick: props.onClose },
      {
        label: pending ? 'Saving…' : 'Save',
        variant: 'primary',
        disabled: saveDisabled,
        busy: pending,
        onClick: () => { void save(); },
      },
    ]}
  >
    <div role="group" aria-label="Roles" className="skill-roles-options">
      {rows.length === 0 && <p className="skill-roles-empty">No roles are configured yet.</p>}
      {rows.map((row, index) => {
        const isChecked = checked.has(row.id);
        const cannotAdd = missing && !currentIds.has(row.id);
        const disabled = pending || reloading || cannotAdd;
        return <button
          key={row.id}
          ref={index === 0 ? firstRow : undefined}
          type="button"
          role="checkbox"
          aria-checked={isChecked}
          className={`skill-roles-option${isChecked ? ' is-checked' : ''}${cannotAdd ? ' is-cannot-add' : ''}`}
          disabled={disabled}
          onClick={() => toggle(row)}
        >
          <span className="skill-roles-check" aria-hidden="true">
            {isChecked && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#0b1220" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>}
          </span>
          <span className="skill-roles-option-text">
            <span className="skill-roles-option-name">{row.name}</span>
            <span className="skill-roles-option-state">{isChecked ? 'Uses this skill' : 'Does not use it'}</span>
            {cannotAdd && <span className="skill-roles-option-note">{SKILL_ROLES_CREATE_FIRST}</span>}
          </span>
        </button>;
      })}
    </div>
    {error !== null && <div ref={alertRef} className="skill-roles-error" role="alert" tabIndex={-1}>
      <p>{messageFor(error)}</p>
      {(conflict || roleMissing) && <button type="button" disabled={pending || reloading} onClick={() => { void reloadLatest(); }}>Reload latest</button>}
      {generic && <button type="button" disabled={pending || reloading} onClick={() => { void save(); }}>Retry</button>}
    </div>}
    {reloadFailure !== null && <div ref={alertRef} className="skill-roles-error" role="alert" tabIndex={-1}>
      <p>{reloadFailure}</p>
      <button type="button" disabled={pending || reloading} onClick={() => { void reloadLatest(); }}>Retry reload latest</button>
    </div>}
    {reloaded && <p className="skill-roles-reloaded" role="status">Roles were reloaded. Review your selection, then save again.</p>}
  </Dialog>;
}
