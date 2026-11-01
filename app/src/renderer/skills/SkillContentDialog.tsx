import { useEffect, useId, useRef, useState, type JSX } from 'react';
import type { ManagementApi, ManagementError, ManagementResult, SkillDetail, SkillItem } from '../api';
import { Icon } from '../icons/Icon';
import { textByteCountText, textBytes } from '../shared/textStats';
import { Dialog } from '../teams/Dialog';
import { formatSkillLimit } from './skillsModel';

export const SKILL_CONTENT_GENERIC_ERROR = 'Review your changes and try saving again; if the problem persists, check the Agent Studio connection.';

/** The over-limit alert uses the catalog limit so it cannot contradict the counter. */
export function skillContentLimitMessage(limit: number): string {
  return `The skill is over the ${formatSkillLimit(limit)} limit. Shorten it to save.`;
}

/** The amber note under the editor: how many roles load it and how the context limit works. */
export function skillContentRoleNote(roles: number, roleContextBytes: number): string {
  const lead = roles === 0 ? 'No role uses this skill yet.' : `${roles} ${roles === 1 ? 'role loads' : 'roles load'} this skill.`;
  return `${lead} Assignments already running keep the version they started with. A role's whole context (instructions and skills) is limited to ${formatSkillLimit(roleContextBytes)}; a skill that does not fit is skipped.`;
}

function normalizeError(reason: unknown): ManagementError {
  return { code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false };
}

function isValidationError(error: ManagementError): boolean {
  return error.code === 'BAD_REQUEST' || error.code === 'VALIDATION' || error.code === 'VALIDATION_ERROR';
}

export interface SkillContentDialogProps {
  skill: SkillItem;
  /** The file text loaded through management.skill. */
  initialText: string;
  /** The skill byte limit from the catalog. */
  limit: number;
  /** The whole role context limit from the catalog. */
  roleContextLimit: number;
  management: ManagementApi;
  workspaceId: string;
  onClose(): void;
  onSaved(detail: SkillDetail): void;
  onPendingChange?(pending: boolean): void;
}

/**
 * Edits one skill's SKILL.md. It writes through management.updateSkill with the
 * sha the page opened with, keeps a conflicting draft available for copying,
 * and reports what the backend said without closing on failure.
 */
export function SkillContentDialog(props: SkillContentDialogProps): JSX.Element {
  const { skill } = props;
  const uid = useId();
  const countId = `${uid}-count`;
  const limitId = `${uid}-limit`;
  const draftId = `${uid}-draft`;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  const [text, setText] = useState(props.initialText);
  const [baseText, setBaseText] = useState(props.initialText);
  const [sha, setSha] = useState<string | null>(skill.sha256);
  const [pending, setPending] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<ManagementError | null>(null);
  const [reloadFailure, setReloadFailure] = useState<ManagementError | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [reloaded, setReloaded] = useState(false);

  const bytes = textBytes(text);
  const overLimit = bytes > props.limit;
  const dirty = text !== baseText;
  const saveDisabled = pending || reloading || overLimit || !dirty || sha === null;
  const conflict = error?.code === 'CONFIG_CHANGED';
  const notFound = error?.code === 'SKILL_NOT_FOUND';
  const unreadable = error?.code === 'SKILL_UNREADABLE' || error?.code === 'SKILL_TOO_LARGE';
  const validation = error !== null && isValidationError(error);

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

  useEffect(() => {
    if (reloaded) textareaRef.current?.focus();
  }, [reloaded]);

  function setBusy(next: boolean): void {
    if (!live.current) return;
    setPending(next);
    props.onPendingChange?.(next);
  }

  async function save(): Promise<void> {
    if (saveDisabled) return;
    setError(null);
    setReloadFailure(null);
    setReloaded(false);
    setBusy(true);
    let result: ManagementResult<SkillDetail>;
    try {
      result = await props.management.updateSkill(props.workspaceId, skill.id, text, sha!);
    } catch (reason) {
      result = { ok: false as const, error: normalizeError(reason) };
    }
    if (!live.current) return;
    setBusy(false);
    if (result.ok) {
      props.onSaved(result.data);
      return;
    }
    setError(result.error);
  }

  async function reloadLatest(): Promise<void> {
    if (pending || reloading) return;
    setReloadFailure(null);
    setReloaded(false);
    setReloading(true);
    let result: ManagementResult<SkillDetail>;
    try {
      result = await props.management.skill(props.workspaceId, skill.id);
    } catch (reason) {
      result = { ok: false as const, error: normalizeError(reason) };
    }
    if (!live.current) return;
    setReloading(false);
    if (!result.ok) {
      setReloadFailure(result.error);
      return;
    }
    // The detail item distinguishes a deleted file from one that now cannot be
    // read or has grown past the editing limit; do not call all of them "missing".
    const state = result.data.skill.state;
    if (state === 'truncated') {
      setError({
        code: 'SKILL_TOO_LARGE',
        message: `The file is larger than ${formatSkillLimit(props.limit)}, so it cannot be edited. Shorten it outside the app first.`,
        retryable: false,
      });
      return;
    }
    if (result.data.text === null) {
      if (state === 'missing') {
        setError({ code: 'SKILL_NOT_FOUND', message: `Skill '${skill.id}' was not found.`, retryable: false });
      } else {
        setError({ code: 'SKILL_UNREADABLE', message: 'The file cannot be read. Reload or fix the file outside the app.', retryable: false });
      }
      return;
    }
    // Keep the person's draft separate instead of silently replacing it.
    setDraft(text);
    setText(result.data.text);
    setBaseText(result.data.text);
    setSha(result.data.skill.sha256);
    setError(null);
    setReloaded(true);
  }

  return <Dialog
    title={`Edit ${skill.id}`}
    subtitle={<>Saved to <code>{skill.path}</code></>}
    width={780}
    busy={pending}
    onClose={props.onClose}
    footerNote="Takes effect on the next assignment"
    initialFocus={textareaRef}
    className="skill-content-dialog"
    actions={[
      { label: 'Cancel', onClick: props.onClose },
      { label: pending ? 'Saving...' : 'Save to file', variant: 'primary', disabled: saveDisabled, onClick: () => { void save(); } },
    ]}
  >
    <div className="role-instructions-field skill-content-field">
      <div className="skill-content-field-head">
        <label htmlFor={`${uid}-content`}>Content (markdown)</label>
        <span id={countId} className={`skill-content-count${overLimit ? ' is-error' : ''}`} aria-live="polite">
          {textByteCountText(text, props.limit)}
        </span>
      </div>
      <textarea
        id={`${uid}-content`}
        ref={textareaRef}
        className="skill-content-input"
        rows={16}
        value={text}
        disabled={pending || reloading}
        aria-describedby={overLimit ? `${countId} ${limitId}` : countId}
        onChange={event => {
          // The textarea is disabled while a write or reload is in flight; this
          // guard also protects against programmatic changes racing the result.
          if (pending || reloading) return;
          setReloaded(false);
          setText(event.target.value);
        }}
      />
    </div>
    {overLimit && <p id={limitId} className="skill-content-limit" role="alert">{skillContentLimitMessage(props.limit)}</p>}
    <div className="skill-content-note">
      <Icon name="warning" size={14} />
      <span>{skillContentRoleNote(skill.roles.length, props.roleContextLimit)}</span>
    </div>
    {error !== null && <div ref={alertRef} className="skill-content-error" role="alert" tabIndex={-1}>
      {conflict
        ? <>
          <p>{`${skill.path} changed since you opened it. Reload to see the latest version.`}</p>
          <button type="button" disabled={reloading} onClick={() => { void reloadLatest(); }}>Reload latest</button>
        </>
        : notFound
          ? <p>The file no longer exists.</p>
          : unreadable
            ? <p>{error.message}</p>
            : validation
              ? <p>{error.message}</p>
              : <>
                <p>{SKILL_CONTENT_GENERIC_ERROR}</p>
                <button type="button" disabled={pending} onClick={() => { void save(); }}>Retry</button>
              </>}
      {reloadFailure !== null && <>
        <p>{`Could not reload ${skill.path}: ${reloadFailure.message}`}</p>
        <button type="button" disabled={reloading} onClick={() => { void reloadLatest(); }}>Retry reload latest</button>
      </>}
    </div>}
    {draft !== null && <div className="skill-content-draft">
      <label htmlFor={draftId}>Your changes</label>
      <textarea id={draftId} className="skill-content-draft-text" rows={6} readOnly value={draft} />
      <p>Copy anything you still need into the current file before saving again.</p>
    </div>}
  </Dialog>;
}
