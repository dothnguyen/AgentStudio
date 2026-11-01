import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import type { OverviewMember, OverviewTeam, RoleCatalogItem } from '../api';
import { Icon } from '../icons/Icon';
import { Dialog } from './Dialog';
import {
  findCatalogRole, memberChanges, memberRoleChoices, memberSettingsInitial, roleChoiceLabel,
  TICKET_PERMISSION_HINT, TICKET_PERMISSION_UNKNOWN,
  type ErrorFeedback, type MemberFormValues, type TeamWrites, type TicketPermissionState,
} from './teamEditModel';
import { roleNote } from './teamsModel';

export interface MemberSettingsDialogProps {
  team: OverviewTeam;
  member: OverviewMember;
  /** Role catalog, or null when it is unavailable. */
  roles: readonly RoleCatalogItem[] | null;
  roleCatalogMessage: string | null;
  permission: TicketPermissionState;
  onRetryPermission(): void;
  /** A team write is in flight; the dialog stays open and ignores Escape. */
  pending: boolean;
  readOnly: boolean;
  writes: TeamWrites;
  onClose(): void;
  onSaved(): void;
}

const TICKET_SWITCH_LABEL = 'Can add tickets';

/** The single v7 dialog that edits a member's name, role and ticket permission. */
export function MemberSettingsDialog(props: MemberSettingsDialogProps): JSX.Element {
  const { team, member, permission, roles, writes } = props;
  const uid = useId();
  const memberId = member.memberId ?? '';
  const nameId = `${uid}-name`;
  const nameErrorId = `${uid}-name-error`;
  const memberIdLabelId = `${uid}-member-id`;
  const roleDescriptionId = `${uid}-role-note`;
  const permissionHintId = `${uid}-permission-hint`;
  const [initial, setInitial] = useState<MemberFormValues>(() => memberSettingsInitial(member, permission.state === 'ready' ? permission.canAddTickets : null));
  const [values, setValues] = useState<MemberFormValues>(initial);
  const [failure, setFailure] = useState<ErrorFeedback | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const rolesRef = useRef<HTMLDivElement>(null);

  // The read can finish after the dialog opened. Fill the permission in once,
  // without overwriting a draft the user already changed.
  const permissionKnown = permission.state === 'ready' && typeof permission.canAddTickets === 'boolean' ? permission.canAddTickets : null;
  useEffect(() => {
    if (permissionKnown === null) return;
    setInitial(current => current.canAddTickets === undefined ? { ...current, canAddTickets: permissionKnown } : current);
    setValues(current => current.canAddTickets === undefined ? { ...current, canAddTickets: permissionKnown } : current);
  }, [permissionKnown]);

  useEffect(() => { if (failure !== null) errorRef.current?.focus(); }, [failure]);

  const nameError = values.name.trim() === '' ? 'Enter a name.' : undefined;
  const changes = memberChanges(initial, values);
  const catalogUnavailable = roles === null;
  // A role draft chosen before the catalog went stale cannot be saved against no catalog.
  const roleBlocked = catalogUnavailable && changes?.role !== undefined;
  const saveDisabled = nameError !== undefined || changes === null || roleBlocked || props.pending || props.readOnly;
  const roleChoices = roles === null ? [] : memberRoleChoices(roles, member.role ?? '');
  const roleSelected = roleChoices.some(choice => choice.id === values.role);
  const switchKnown = permission.state === 'ready' && typeof permission.canAddTickets === 'boolean';
  const switchDisabled = !switchKnown || props.pending || props.readOnly;

  function setRole(role: string): void {
    setValues(current => ({ ...current, role }));
  }

  function onRoleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (catalogUnavailable || roleChoices.length === 0) return;
    const ids = roleChoices.map(choice => choice.id);
    const currentIndex = ids.indexOf(values.role);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % ids.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = currentIndex < 0 ? ids.length - 1 : (currentIndex - 1 + ids.length) % ids.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = ids.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    setRole(ids[nextIndex]!);
    rolesRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]?.focus();
  }

  function save(): void {
    if (saveDisabled || changes === null) return;
    setFailure(null);
    void writes.updateMember(team, memberId, changes, { inlineFailure: true }).then(outcome => {
      if (outcome.ok) { props.onSaved(); return; }
      setFailure(outcome.feedback);
    });
  }

  const permissionHint = permission.state === 'error' || (permission.state === 'ready' && permission.canAddTickets === null)
    ? TICKET_PERMISSION_UNKNOWN
    : TICKET_PERMISSION_HINT;

  return <Dialog
    title="Edit member settings"
    width={680}
    busy={props.pending}
    onClose={props.onClose}
    footerNote="Applies on next team start"
    initialFocus={nameRef}
    actions={[
      { label: 'Cancel', onClick: props.onClose },
      { label: 'Save', variant: 'primary', disabled: saveDisabled, onClick: save },
    ]}
    className="member-settings-dialog"
  >
    <div className="member-settings-section">
      <h3>General</h3>
      <div className="member-settings-general">
        <div className="member-settings-field">
          <label className="member-settings-label" htmlFor={nameId}>Display name</label>
          <input
            id={nameId}
            ref={nameRef}
            type="text"
            value={values.name}
            disabled={props.pending || props.readOnly}
            aria-invalid={nameError !== undefined ? 'true' : undefined}
            aria-describedby={nameError !== undefined ? nameErrorId : undefined}
            onChange={event => setValues(current => ({ ...current, name: event.target.value }))}
          />
          {nameError !== undefined && <p className="teams-field-error" id={nameErrorId}>{nameError}</p>}
        </div>
        <div className="member-settings-field">
          <span className="member-settings-label" id={memberIdLabelId}>Member id</span>
          <span className="member-settings-id" aria-labelledby={memberIdLabelId}>
            <Icon name="lock" size={13} />
            <code className="entity-id">{memberId}</code>
          </span>
        </div>
      </div>
    </div>

    <div className="member-settings-section">
      <h3>Role</h3>
      <div
        ref={rolesRef}
        role="radiogroup"
        aria-label="Assigned role"
        aria-disabled={catalogUnavailable ? 'true' : undefined}
        aria-describedby={catalogUnavailable && props.roleCatalogMessage !== null ? roleDescriptionId : undefined}
        className="member-settings-roles"
        onKeyDown={onRoleKeyDown}
      >
        {catalogUnavailable
          ? <button type="button" role="radio" aria-checked="true" disabled className="member-settings-role">
            <span className="member-settings-role-radio" aria-hidden="true" />
            <span className="member-settings-role-text">
              <span className="member-settings-role-name">{member.role ?? 'No role'}</span>
              <span className="member-settings-role-desc">{roleNote(member) ?? 'The role catalog is unavailable.'}</span>
            </span>
          </button>
          : roleChoices.map((choice, index) => {
            const role = findCatalogRole(roles, choice.id);
            const description = role?.description ?? (choice.state === 'missing' ? roleNote(member) : null) ?? 'No description';
            const checked = values.role === choice.id;
            return <button
              key={`${choice.state}:${choice.id}`}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked || (!roleSelected && index === 0) ? 0 : -1}
              disabled={props.pending || props.readOnly}
              className="member-settings-role"
              onClick={() => setRole(choice.id)}
            >
              <span className="member-settings-role-radio" aria-hidden="true" />
              <span className="member-settings-role-text">
                <span className="member-settings-role-name">{choice.state === 'defined' ? roleChoiceLabel(role ?? { id: choice.id, name: choice.id }) : choice.label}</span>
                <span className="member-settings-role-desc">{description}</span>
              </span>
            </button>;
          })}
      </div>
      {catalogUnavailable && props.roleCatalogMessage !== null && <p id={roleDescriptionId} className="panel-note member-settings-role-message">{props.roleCatalogMessage}</p>}
    </div>

    <div className="member-settings-section">
      <h3>Permissions</h3>
      <div className="member-settings-permission">
        <span className="member-settings-permission-text">
          <span className="member-settings-permission-label">{TICKET_SWITCH_LABEL}</span>
          <span id={permissionHintId} className="member-settings-permission-hint">{permissionHint}</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={values.canAddTickets === true}
          aria-label={TICKET_SWITCH_LABEL}
          aria-describedby={permissionHintId}
          disabled={switchDisabled}
          className="member-settings-switch"
          onClick={() => setValues(current => ({ ...current, canAddTickets: current.canAddTickets !== true }))}
        >
          <span className="member-settings-switch-thumb" aria-hidden="true" />
        </button>
      </div>
      {permission.state === 'error' && <button type="button" className="member-settings-retry" disabled={props.pending} onClick={props.onRetryPermission}>Retry loading ticket permission</button>}
    </div>

    {failure !== null && <div ref={errorRef} className="member-settings-error" role="alert" tabIndex={-1}>
      <p><strong>{failure.title}</strong></p>
      <p><code className="entity-id">{failure.code}</code>: {failure.message}</p>
      {failure.remediation !== null && <p>{failure.remediation}</p>}
      {failure.hint !== null && <p>{failure.hint}</p>}
      {failure.problems.length > 0 && <ul aria-label="Validation problems">{failure.problems.map((problem, index) => <li key={index}>{problem}</li>)}</ul>}
    </div>}
  </Dialog>;
}
