import { useEffect, useId, useRef, useState, type JSX, type RefObject } from 'react';
import type { ManagementApi, ManagementError, ManagementResult, SkillCatalogList, SkillDetail, SkillItem } from '../api';
import { textByteCountText, textBytes } from '../shared/textStats';
import { Dialog } from '../teams/Dialog';
import { formatSkillLimit } from './skillsModel';

/** The same rule the backend applies to a skill folder name. */
export const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const SKILL_ID_INVALID_MESSAGE =
  'Use lowercase letters, numbers, dots, dashes and underscores, starting with a letter or number (up to 64 characters).';
export const SKILL_EXISTS_MESSAGE = 'A skill with this id already exists.';
export const SKILL_CREATE_GENERIC_ERROR =
  'The skill could not be created. Check the Agent Studio connection, then retry.';
export const SKILL_CREATE_STARTER = '# Skill title\n\nWhat the agent should do, step by step.\n';

/** The message shown under the id field, or null when the id can be used. */
export function skillIdMessage(id: string, skills: readonly SkillItem[]): string | null {
  if (id === '') return null;
  if (!SKILL_ID_PATTERN.test(id)) return SKILL_ID_INVALID_MESSAGE;
  // A listed skill without a file is the "create the missing file" case, so it is not a duplicate.
  if (skills.some(skill => skill.id === id && skill.state !== 'missing')) return SKILL_EXISTS_MESSAGE;
  return null;
}

/** True when every value the dialog needs is acceptable; used for the primary action. */
export function canCreateSkill(id: string, text: string, limit: number, skills: readonly SkillItem[]): boolean {
  return id !== '' && skillIdMessage(id, skills) === null && textBytes(text) <= limit;
}

export function skillOverLimitMessage(limit: number): string {
  return `The skill is over the ${formatSkillLimit(limit)} limit. Shorten it to create the skill.`;
}

function normalizeError(reason: unknown): ManagementError {
  return { code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false };
}

function isValidationError(error: ManagementError): boolean {
  return error.code === 'BAD_REQUEST' || error.code === 'VALIDATION' || error.code === 'VALIDATION_ERROR';
}

export interface SkillCreateDialogProps {
  /** The catalog used to block an id that already has a SKILL.md. */
  catalog: SkillCatalogList;
  /** Prefills and locks the id, for creating the file of a missing skill. */
  initialId?: string | null;
  management: ManagementApi;
  workspaceId: string;
  /** The skill byte limit from the catalog. */
  limit: number;
  onClose(): void;
  onCreated(detail: SkillDetail): void;
  onPendingChange?(pending: boolean): void;
  /** Refreshes the list after a raced SKILL_EXISTS so the duplicate check is current. */
  onRefreshCatalog?(): void | Promise<void>;
}

/**
 * Creates one skill file through management.createSkill. The id is validated
 * with the backend rule and checked against the current catalog before
 * anything is sent; the content starts from a template and is capped at the
 * catalog byte limit.
 */
export function SkillCreateDialog(props: SkillCreateDialogProps): JSX.Element {
  const uid = useId();
  const idId = `${uid}-id`;
  const hintId = `${uid}-hint`;
  const idErrorId = `${uid}-id-error`;
  const contentId = `${uid}-content`;
  const countId = `${uid}-count`;
  const limitId = `${uid}-limit`;
  const locked = props.initialId !== undefined && props.initialId !== null;
  const idRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  const [id, setId] = useState(props.initialId ?? '');
  const [text, setText] = useState(SKILL_CREATE_STARTER);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ManagementError | null>(null);
  const [serverDuplicate, setServerDuplicate] = useState(false);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      props.onPendingChange?.(false);
    };
    // The callback is owned by the screen and only reports the write state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (error !== null) feedbackRef.current?.focus();
  }, [error]);

  const bytes = textBytes(text);
  const overLimit = bytes > props.limit;
  const localMessage = skillIdMessage(id, props.catalog.skills);
  const idMessage = serverDuplicate ? SKILL_EXISTS_MESSAGE : localMessage;
  const createDisabled = pending || id === '' || idMessage !== null || overLimit;

  function setBusy(next: boolean): void {
    if (!live.current) return;
    setPending(next);
    props.onPendingChange?.(next);
  }

  async function submit(): Promise<void> {
    if (createDisabled || pending) return;
    setError(null);
    setBusy(true);
    let result: ManagementResult<SkillDetail>;
    try {
      result = await props.management.createSkill(props.workspaceId, { id, text });
    } catch (reason) {
      result = { ok: false as const, error: normalizeError(reason) };
    }
    if (!live.current) return;
    setBusy(false);
    if (result.ok) {
      props.onCreated(result.data);
      return;
    }
    if (result.error.code === 'SKILL_EXISTS') {
      // The id may have been created after this dialog opened. Keep the
      // person's draft, show the same message as the local check, and refresh
      // the list so the next attempt starts from current data.
      setServerDuplicate(true);
      setError(result.error);
      void Promise.resolve(props.onRefreshCatalog?.()).catch(() => undefined);
      return;
    }
    setError(result.error);
  }

  const path = `skills/${id || '<id>'}/SKILL.md`;
  return <Dialog
    title="New skill"
    width={680}
    busy={pending}
    onClose={props.onClose}
    footerNote="Add it to roles after creating it"
    initialFocus={(locked ? contentRef : idRef) as RefObject<HTMLElement | null>}
    className="skill-create-dialog"
    actions={[
      { label: 'Cancel', onClick: props.onClose },
      {
        label: pending ? 'Creating…' : 'Create skill',
        variant: 'primary',
        disabled: createDisabled,
        busy: pending,
        onClick: () => { void submit(); },
      },
    ]}
  >
    <div className="skill-create-field">
      <label htmlFor={idId}>Skill id</label>
      <input
        id={idId}
        ref={idRef}
        className="skill-create-id"
        type="text"
        value={id}
        placeholder="for example api-design"
        spellCheck={false}
        readOnly={locked}
        disabled={locked || pending}
        aria-invalid={idMessage !== null ? true : undefined}
        aria-describedby={idMessage !== null ? `${idErrorId} ${hintId}` : hintId}
        onChange={event => {
          if (locked || pending) return;
          setId(event.target.value);
          setServerDuplicate(false);
          setError(null);
        }}
      />
      <p className="skill-create-hint" id={hintId}>
        Lowercase letters, numbers, dots, dashes and underscores. It becomes the folder name and cannot be changed later.
        The file will be <code>{path}</code>.
      </p>
      {idMessage !== null && <div id={idErrorId} ref={feedbackRef} className="skill-create-field-error" role="alert" tabIndex={-1}>
        {idMessage}
      </div>}
    </div>
    <div className="skill-create-field">
      <div className="skill-create-content-head">
        <label htmlFor={contentId}>Content (markdown)</label>
        <span id={countId} className={`skill-create-count${overLimit ? ' is-error' : ''}`} aria-live="polite">
          {textByteCountText(text, props.limit)}
        </span>
      </div>
      <textarea
        id={contentId}
        ref={contentRef}
        className="skill-create-content"
        rows={9}
        value={text}
        disabled={pending}
        aria-describedby={overLimit ? `${countId} ${limitId}` : countId}
        onChange={event => {
          if (pending) return;
          setText(event.target.value);
        }}
      />
      {overLimit && <p id={limitId} className="skill-create-limit" role="alert">{skillOverLimitMessage(props.limit)}</p>}
    </div>
    {error !== null && error.code !== 'SKILL_EXISTS' && <div
      ref={feedbackRef}
      className="skill-create-error"
      role="alert"
      tabIndex={-1}
    >
      <p>{isValidationError(error) ? error.message : SKILL_CREATE_GENERIC_ERROR}</p>
      {!isValidationError(error) && <button type="button" disabled={pending} onClick={() => { void submit(); }}>Retry</button>}
    </div>}
  </Dialog>;
}
