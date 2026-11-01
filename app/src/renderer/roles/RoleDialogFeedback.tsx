import { useEffect, useRef, type JSX } from 'react';
import type { ManagementError } from '../api';
import { roleErrorProblems } from './roleEditModel';
import { CONFLICT_MESSAGE } from './roleSave';

export interface RoleDialogFeedbackProps {
  /** Save failure from the shared role save sequence. */
  error: ManagementError | null;
  /** Set when an earlier part of the save succeeded and a later part did not. */
  partialNotice: string | null;
  /** Failure to reload current values after a conflict. */
  reloadFailure?: string | null;
  /** Set after a conflict reload so the draft can be reviewed and saved again. */
  reloaded?: boolean;
  pending: boolean;
  onReload?(): void;
}

/**
 * Shared failure/partial-save feedback for the role edit dialogs. The alert is
 * focusable and takes focus when it appears so keyboard users hear the error.
 */
export function RoleDialogFeedback(props: RoleDialogFeedbackProps): JSX.Element | null {
  const alertRef = useRef<HTMLDivElement>(null);
  const { error, partialNotice, reloadFailure = null } = props;
  const conflict = error?.code === 'CONFIG_CHANGED';
  const problems = error === null || conflict ? [] : roleErrorProblems(error).unmatched;

  useEffect(() => {
    if (error !== null || partialNotice !== null || reloadFailure !== null) alertRef.current?.focus();
  }, [error, partialNotice, reloadFailure]);

  if (error === null && partialNotice === null && reloadFailure === null && props.reloaded !== true) return null;
  return <>
    {(error !== null || partialNotice !== null || reloadFailure !== null) && <div
      ref={alertRef}
      className="role-dialog-error"
      role="alert"
      tabIndex={-1}
    >
      {partialNotice !== null && <p>{partialNotice}</p>}
      {error !== null && (conflict
        ? <>
          <p><code>{error.code}</code>: {CONFLICT_MESSAGE}</p>
          {error.remediation !== undefined && <p>{error.remediation}</p>}
        </>
        : <>
          <p><code>{error.code}</code>: {error.message}</p>
          {error.remediation !== undefined && <p>{error.remediation}</p>}
          {problems.map((line, index) => <p key={index}>{line}</p>)}
        </>)}
      {reloadFailure !== null && <p>{reloadFailure}</p>}
      {conflict && props.onReload !== undefined && <button type="button" disabled={props.pending} onClick={props.onReload}>Reload and review</button>}
    </div>}
    {props.reloaded === true && <p className="role-dialog-reloaded" role="status">Current role values were reloaded. Review the draft, then save again.</p>}
  </>;
}
