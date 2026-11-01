import { useId, type JSX, type ReactNode, type RefObject } from 'react';
import { Icon } from '../icons/Icon';

export interface SectionCardAction {
  /** Visible button text, usually short (for example "Edit"). */
  label: string;
  /** Accessible name for the button (for example "Edit member settings"). */
  ariaLabel: string;
  onClick(): void;
  disabled?: boolean;
  /** Optional handle so the owner can return focus to the action after a dialog. */
  buttonRef?: RefObject<HTMLButtonElement | null>;
}

export interface SectionCardProps {
  /** Card heading. Plain text, or a node when the heading needs an indicator. */
  title: ReactNode;
  /** Optional one-line description under the title. */
  subtitle?: ReactNode;
  /** Optional pencil button in the header. */
  action?: SectionCardAction;
  /** Card body. */
  children: ReactNode;
  className?: string;
}

/** A dark section card from the Teams member details design. */
export function SectionCard(props: SectionCardProps): JSX.Element {
  const headingId = useId();
  const className = ['section-card', props.className].filter(Boolean).join(' ');
  return (
    <section className={className} aria-labelledby={headingId}>
      <div className="section-card-header">
        <div className="section-card-heading">
          <h2 id={headingId}>{props.title}</h2>
          {props.subtitle !== undefined && <p>{props.subtitle}</p>}
        </div>
        {props.action !== undefined && (
          <button
            type="button"
            ref={props.action.buttonRef}
            className="section-card-action"
            aria-label={props.action.ariaLabel}
            disabled={props.action.disabled}
            onClick={props.action.onClick}
          >
            <Icon name="pencil" size={13} />
            {props.action.label}
          </button>
        )}
      </div>
      <div className="section-card-body">{props.children}</div>
    </section>
  );
}
