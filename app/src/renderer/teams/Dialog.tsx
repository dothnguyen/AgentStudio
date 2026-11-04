import { useEffect, useId, useRef, type JSX, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '../icons/Icon';

export interface DialogAction {
  label: string;
  onClick(): void;
  /** "primary" is the blue save action; "secondary" is the outlined cancel action; "danger" is the red destructive action. */
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  /** Marks a destructive action that is currently running. */
  busy?: boolean;
  /** Optional icon shown before the label. */
  icon?: IconName;
  /** Optional explanation associated with the action (for example a blocked reason). */
  descriptionId?: string;
  /** Optional native tooltip, for example why a disabled action cannot run. */
  title?: string;
  /** Optional handle so the owner can focus this action when the dialog opens. */
  buttonRef?: RefObject<HTMLButtonElement | null>;
  /** Optional extra class, for example a link-style footer action. */
  className?: string;
}

export interface DialogProps {
  /** Dialog title, also used as its accessible name. */
  title: ReactNode;
  /** Optional secondary line under the title, for example the file the dialog saves to. */
  subtitle?: ReactNode;
  /** Panel width in pixels. It never grows past the window. */
  width?: number;
  onClose(): void;
  /** While busy, Escape and the close button are ignored. */
  busy?: boolean;
  /** Short note shown on the left of the footer. */
  footerNote?: ReactNode;
  /** Footer buttons, from left to right. */
  actions: DialogAction[];
  /** Optional destructive or secondary actions shown on the left of the footer. */
  leadingActions?: DialogAction[];
  /** Element focused when the dialog opens; defaults to the first focusable control. */
  initialFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  /** Set false for a confirmation that has no close button (defaults to true). */
  showClose?: boolean;
  /** Optional id of the body copy that describes this dialog. */
  describedBy?: string;
  /** Destructive confirmations use the alertdialog role; the default is dialog. */
  role?: 'dialog' | 'alertdialog';
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal dialog used by the member details edit screens.
 *
 * It renders in a portal, makes the rest of the app inert, traps Tab/Shift+Tab,
 * closes on Escape (unless busy) and restores focus to the opener on unmount.
 * A backdrop click deliberately does nothing.
 */
export function Dialog(props: DialogProps): JSX.Element {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const { busy = false, width = 520, showClose = true } = props;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    // Prefer the requested control, then the first focusable one. A disabled or
    // otherwise non-focusable initialFocus silently refuses focus, so verify the
    // result and fall through to the next candidate instead of leaving focus on
    // the opener behind the backdrop.
    const candidates = [props.initialFocus?.current ?? null, panel?.querySelector<HTMLElement>(FOCUSABLE) ?? null, panel];
    for (const candidate of candidates) {
      if (candidate === null || !candidate.isConnected) continue;
      candidate.focus();
      if (document.activeElement === candidate) break;
    }

    const overlay = panel?.parentElement ?? null;
    const inerted: HTMLElement[] = [];
    for (const child of Array.from(document.body.children)) {
      if (!(child instanceof HTMLElement) || child === overlay || child.hasAttribute('inert')) continue;
      child.setAttribute('inert', '');
      inerted.push(child);
    }

    return () => {
      for (const element of inerted) element.removeAttribute('inert');
      const target = previousFocus.current;
      if (target !== null && target.isConnected && !(target as HTMLButtonElement).disabled) target.focus();
    };
    // Focus and inertness only apply for the lifetime of one open dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape and the Tab trap are handled at the document level: a click on the
  // backdrop can leave focus on <body>, and a panel-background click focuses the
  // panel itself, so neither may depend on the key event reaching the panel.
  useEffect(() => {
    function onDocumentKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (panel === null) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      // Focus on the panel itself (or outside it) is a trap boundary.
      const atBoundary = active === panel || !panel.contains(active);
      if (event.shiftKey && (active === first || atBoundary)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || atBoundary)) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => document.removeEventListener('keydown', onDocumentKeyDown);
  }, []);

  function actionButton(action: DialogAction, key: string): JSX.Element {
    return <button
      key={key}
      type="button"
      ref={action.buttonRef}
      className={['dialog-action', action.variant === 'primary' ? 'dialog-action-primary' : action.variant === 'danger' ? 'dialog-action-danger' : 'dialog-action-secondary', action.className].filter(Boolean).join(' ')}
      aria-busy={action.busy ? true : undefined}
      aria-describedby={action.descriptionId}
      title={action.title}
      disabled={action.disabled || busy}
      onClick={action.onClick}
    >
      {action.icon !== undefined && <Icon name={action.icon} size={13} />}
      {action.label}
    </button>;
  }

  // Pressing the backdrop keeps focus inside the dialog; the click itself
  // deliberately does nothing (the dialog stays open).
  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={event => { if (event.target === event.currentTarget) event.preventDefault(); }}
    >
      <div
        ref={panelRef}
        role={props.role ?? 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={props.describedBy}
        tabIndex={-1}
        className={['dialog-panel', props.className].filter(Boolean).join(' ')}
        style={{ width: `min(${width}px, 100%)` }}
      >
        <div className="dialog-header">
          <div className="dialog-title-group">
            <h2 id={titleId}>{props.title}</h2>
            {props.subtitle !== undefined && <p className="dialog-subtitle">{props.subtitle}</p>}
          </div>
          {showClose && <button
            type="button"
            className="dialog-close"
            aria-label="Close"
            disabled={busy}
            onClick={() => { if (!busy) props.onClose(); }}
          >
            <Icon name="close" size={16} />
          </button>}
        </div>
        <div className="dialog-body">{props.children}</div>
        <div className="dialog-footer">
          <div className="dialog-footer-leading">
            {props.leadingActions?.map((action, index) => actionButton(action, `leading-${index}-${action.label}`))}
            {props.footerNote !== undefined && <span className="dialog-footer-note">{props.footerNote}</span>}
          </div>
          <div className="dialog-footer-actions">
            {props.actions.map((action, index) => actionButton(action, `${index}-${action.label}`))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
