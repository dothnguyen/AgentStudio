import { useEffect, useId, useRef, type JSX, type KeyboardEvent, type RefObject } from 'react';

export interface ConfirmDialogProps {
  title: string;
  body: string;
  details?: string[];
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  reasonLabel?: string;
  maxReasonLength?: number;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onConfirm(reason?: string): void;
  onCancel(): void;
}

export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element {
  const { title, body, details, confirmLabel, danger = false, busy = false, reasonLabel, maxReasonLength = 500 } = props;
  const reactId = useId().replace(/:/g, '');
  const titleId = `ui-confirm-${reactId}-title`;
  const bodyId = `ui-confirm-${reactId}-body`;
  const detailsId = `ui-confirm-${reactId}-details`;
  const reasonId = `ui-confirm-${reactId}-reason`;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const reasonRef = useRef<HTMLInputElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => {
      const target = props.returnFocusRef?.current ?? previousFocus.current;
      if (target !== null && target.isConnected && !(target as HTMLButtonElement).disabled) target.focus();
    };
    // Focus return is intentionally only on mount/unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!busy) props.onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [reasonRef.current, cancelRef.current, confirmRef.current]
      .filter((control): control is HTMLButtonElement | HTMLInputElement => control !== null && !control.disabled);
    if (controls.length === 0) return;
    const first = controls[0]!;
    const last = controls[controls.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function submit(): void {
    if (busy) return;
    props.onConfirm(reasonRef.current?.value.trim() === '' || reasonRef.current === null ? undefined : reasonRef.current.value.trim());
  }

  const hasDetails = details !== undefined && details.length > 0;
  const describedBy = hasDetails ? `${bodyId} ${detailsId}` : bodyId;

  return (
    <div className="modal-overlay teams-live-modal" onKeyDown={onKeyDown}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        className={`ui-confirm${danger ? ' ui-confirm-danger-dialog' : ''}`}
        ref={dialogRef}
      >
        <h2 id={titleId}>{title}</h2>
        <p id={bodyId}>{body}</p>
        {hasDetails && (
          <ul id={detailsId} className="ui-confirm-details">
            {details!.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
          </ul>
        )}
        {reasonLabel !== undefined && (
          <label htmlFor={reasonId} className="ui-confirm-reason">
            <span>{reasonLabel}</span>
            <input
              id={reasonId}
              ref={reasonRef}
              type="text"
              maxLength={maxReasonLength}
              disabled={busy}
              onChange={() => undefined}
            />
          </label>
        )}
        <div className="ui-confirm-actions">
          <button type="button" ref={cancelRef} disabled={busy} onClick={props.onCancel}>Cancel</button>
          <button
            type="button"
            ref={confirmRef}
            className={danger ? 'ui-confirm-confirm ui-confirm-confirm-danger' : 'ui-confirm-confirm'}
            disabled={busy}
            aria-busy={busy}
            onClick={submit}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
