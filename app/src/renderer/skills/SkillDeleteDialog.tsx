import { useEffect, useId, useRef, type JSX } from 'react';
import type { ManagementError, SkillDeleteResult, SkillItem } from '../api';
import { Dialog } from '../teams/Dialog';

export const SKILL_DELETE_REASON_ID = 'skills-delete-reason';
export const SKILL_DELETE_CONFLICT = 'This skill or the roles changed since you opened it. Reload and try again.';
export const SKILL_DELETE_GENERIC = 'The skill could not be deleted. Check the Agent Studio connection, then retry.';
export const SKILL_DELETE_REFRESH_FAILED = 'Skill was deleted, but Skills could not be refreshed. Retry Skills before making another change.';

export type SkillDeleteTone = 'warning' | 'muted';

export interface SkillDeleteActionState {
  /** The button is disabled for every reason except the unused-skill state. */
  disabled: boolean;
  text: string;
  tone: SkillDeleteTone;
}

export interface SkillDeleteActionInput {
  skill: Pick<SkillItem, 'roles'>;
  connected: boolean;
  /** Any write is running: a content or roles save, a create, or this delete. */
  pending: boolean;
  /** A previous delete succeeded but the list has not been refreshed yet. */
  refreshRequired?: boolean;
}

function roleCount(count: number): string {
  return `${count} ${count === 1 ? 'role' : 'roles'}`;
}

/**
 * The header action state. A used skill always explains why it cannot be
 * deleted in amber; pending writes, a lost connection and an unrefreshed list
 * win over the usage message so the action says what is actually blocking it.
 */
export function skillDeleteActionState(input: SkillDeleteActionInput): SkillDeleteActionState {
  if (input.pending) {
    return { disabled: true, text: 'A skill change is in progress; wait for it to finish.', tone: 'muted' };
  }
  if (!input.connected) {
    return { disabled: true, text: 'Connect to the backend to delete this skill.', tone: 'muted' };
  }
  if (input.refreshRequired) {
    return { disabled: true, text: 'Skills must be reloaded before deleting another skill.', tone: 'muted' };
  }
  if (input.skill.roles.length > 0) {
    return {
      disabled: true,
      text: `Used by ${roleCount(input.skill.roles.length)}. Remove it from them before deleting it.`,
      tone: 'warning',
    };
  }
  return { disabled: false, text: 'No role uses this skill, so it can be deleted.', tone: 'muted' };
}

export const SKILL_DELETE_UNREADABLE_CAVEAT = 'The file could not be read, so its content cannot be checked.';

export interface SkillDeleteDescriptionParts {
  before: string;
  /** The folder path, rendered as code by the dialog. */
  path: string;
  after: string;
}

/** The dialog copy split around the folder path; an unreadable or truncated file adds a caveat. */
export function skillDeleteDescriptionParts(skill: Pick<SkillItem, 'id' | 'state'>): SkillDeleteDescriptionParts {
  const after = ' and its SKILL.md will be removed. No role uses this skill.';
  const unreadable = skill.state === 'unreadable' || skill.state === 'truncated';
  return {
    before: 'The folder ',
    path: `skills/${skill.id}`,
    after: unreadable ? `${after} ${SKILL_DELETE_UNREADABLE_CAVEAT}` : after,
  };
}

/** The dialog copy; an unreadable or truncated file has content that cannot be checked. */
export function skillDeleteDescription(skill: Pick<SkillItem, 'id' | 'state'>): string {
  const parts = skillDeleteDescriptionParts(skill);
  return `${parts.before}${parts.path}${parts.after}`;
}

export function skillDeleteAnnouncement(result: Pick<SkillDeleteResult, 'deleted'>): string {
  const base = `Deleted skill ${result.deleted.id}.`;
  return result.deleted.folder === 'kept'
    ? `${base} The folder was kept because it contains other files.`
    : base;
}

/** Role labels carried by a SKILL_IN_USE error; malformed data never leaks into the message. */
export function skillInUseRoles(error: Pick<ManagementError, 'data'> | null): string[] {
  const data = error?.data;
  if (typeof data !== 'object' || data === null) return [];
  const roles = (data as { roles?: unknown }).roles;
  if (!Array.isArray(roles)) return [];
  return roles
    .map((role) => {
      if (typeof role === 'string') return role.trim();
      if (typeof role === 'object' && role !== null) {
        const name = (role as { name?: unknown }).name;
        const id = (role as { id?: unknown }).id;
        if (typeof name === 'string' && name.trim() !== '') return name.trim();
        if (typeof id === 'string' && id.trim() !== '') return id.trim();
      }
      return '';
    })
    .filter((role) => role !== '');
}

export function skillDeleteErrorMessage(
  error: ManagementError,
  roleNames: Readonly<Record<string, string>> = {},
): string {
  if (error.code === 'SKILL_IN_USE') {
    const roles = skillInUseRoles(error).map(role => roleNames[role] ?? role);
    return `${roles.length > 0 ? roles.join(', ') : 'Roles'} still use this skill. Remove it from them first.`;
  }
  if (error.code === 'CONFIG_CHANGED') return SKILL_DELETE_CONFLICT;
  return SKILL_DELETE_GENERIC;
}

export interface SkillDeleteDialogProps {
  skill: Pick<SkillItem, 'id' | 'state'>;
  pending: boolean;
  error: ManagementError | null;
  /** Role ids mapped to display names, so SKILL_IN_USE does not show raw ids. */
  roleNames?: Readonly<Record<string, string>>;
  /** A failed reload after a conflict; shown under the conflict action. */
  reloadFailure?: string | null;
  reloading?: boolean;
  onCancel(): void;
  onConfirm(): void;
  onReloadLatest(): void;
  onRetry(): void;
  onEditRoles?(): void;
}

/** Compact confirmation for deleting one skill, with every failure kept in place. */
export function SkillDeleteDialog(props: SkillDeleteDialogProps): JSX.Element {
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const reloadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (props.error !== null) errorRef.current?.focus();
  }, [props.error]);
  useEffect(() => {
    if (props.reloadFailure) reloadRef.current?.focus();
  }, [props.reloadFailure]);

  const conflict = props.error?.code === 'CONFIG_CHANGED';
  const inUse = props.error?.code === 'SKILL_IN_USE';
  const generic = props.error !== null && !conflict && !inUse;
  const busy = props.pending || props.reloading === true;
  const description = skillDeleteDescriptionParts(props.skill);

  return <Dialog
    title={`Delete ${props.skill.id}?`}
    width={480}
    busy={props.pending}
    showClose={false}
    role="alertdialog"
    describedBy={bodyId}
    initialFocus={cancelRef}
    className="skill-delete-dialog"
    onClose={props.onCancel}
    actions={[
      { label: 'Cancel', onClick: props.onCancel, buttonRef: cancelRef },
      {
        label: props.pending ? 'Deleting…' : 'Delete skill',
        variant: 'danger',
        disabled: busy,
        busy: props.pending,
        onClick: props.onConfirm,
      },
    ]}
  >
    <p id={bodyId} className="skill-delete-copy">
      {description.before}<code>{description.path}</code>{description.after}
    </p>
    {props.error !== null && <div ref={errorRef} className="skill-delete-error" role="alert" tabIndex={-1}>
      <p>{skillDeleteErrorMessage(props.error, props.roleNames)}</p>
      {inUse && <button type="button" disabled={busy} onClick={props.onEditRoles}>Edit roles</button>}
      {conflict && <button type="button" disabled={busy} onClick={props.onReloadLatest}>Reload latest</button>}
      {generic && <button type="button" disabled={busy} onClick={props.onRetry}>Retry</button>}
    </div>}
    {props.reloadFailure !== undefined && props.reloadFailure !== null && <div ref={reloadRef} className="skill-delete-error" role="alert" tabIndex={-1}>
      <p>{props.reloadFailure}</p>
      <button type="button" disabled={busy} onClick={props.onReloadLatest}>Retry reload latest</button>
    </div>}
  </Dialog>;
}
