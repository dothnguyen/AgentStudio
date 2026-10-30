import { useEffect, useRef, type JSX, type KeyboardEvent } from 'react';
import { TeamNameForm, WriteFeedbackView } from './TeamEditForms';
import type { WriteFeedback } from './teamEditModel';

export interface TeamCreateDialogProps {
  pending: boolean;
  readOnly: boolean;
  error: Extract<WriteFeedback, { kind: 'error' }> | null;
  onSubmit(name: string): void;
  onCancel(): void;
  onDismissError(): void;
}

const CONTROLS = 'input:not([disabled]), button:not([disabled])';

export function TeamCreateDialog(props: TeamCreateDialogProps): JSX.Element {
  const { pending, readOnly, error, onSubmit, onCancel, onDismissError } = props;
  const dialogRef = useRef<HTMLDivElement>(null);

  // A backend error is announced while the typed name stays put; return focus to the field for a retry.
  useEffect(() => {
    if (error !== null) dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [error]);

  function trapTab(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape' && !pending) {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(CONTROLS) ?? []);
    if (controls.length === 0) { event.preventDefault(); return; }
    const first = controls[0]!;
    const last = controls[controls.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !controls.includes(active as HTMLElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !controls.includes(active as HTMLElement))) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="modal-overlay teams-create-modal">
      <div ref={dialogRef} className="teams-create-dialog" role="dialog" aria-modal="true" aria-label="New team" onKeyDown={trapTab}>
        <WriteFeedbackView
          feedback={error}
          onDismiss={() => {
            onDismissError();
            dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
          }}
        />
        <TeamNameForm
          heading="New team"
          submitLabel="Create team"
          initialName=""
          pending={pending}
          readOnly={readOnly}
          cancelDisabled={pending}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      </div>
    </div>
  );
}
