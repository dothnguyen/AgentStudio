import { useEffect, useId, useRef, type JSX, type KeyboardEvent } from 'react';
import type { AgentDef, ManagementError } from '../api';

export interface AgentDeleteDialogProps {
  agent: Pick<AgentDef, 'id' | 'name'>;
  pending: boolean;
  error: ManagementError | null;
  onCancel(): void;
  onConfirm(): void;
}
export function AgentDeleteDialog({ agent, pending, error, onCancel, onConfirm }: AgentDeleteDialogProps): JSX.Element {
  const heading = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); if (!pending) onCancel(); return; }
    if (event.key !== 'Tab') return;
    const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!buttons.length) { event.preventDefault(); return; }
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === buttons.length - 1)) {
      event.preventDefault(); (event.shiftKey ? buttons[buttons.length - 1] : buttons[0])?.focus();
    }
  };
  return <div className="modal-overlay"><div className="create-workspace-dialog" role="dialog" aria-modal="true" aria-labelledby={heading} ref={dialog} onKeyDown={keyDown}>
    <h2 id={heading}>Delete saved agent</h2>
    <p>Delete saved agent "{agent.name?.trim() || agent.id}" (<code>{agent.id}</code>)?</p>
    <p>Only the saved definition will be deleted. Team membership and live runtime will not be changed.</p>
    {error && <div className="dialog-error" role="alert"><p><code>{error.code}</code>: {error.message}</p>{error.remediation?.trim() && <p>{error.remediation}</p>}</div>}
    <div className="dialog-actions"><button ref={cancel} type="button" disabled={pending} onClick={onCancel}>Cancel</button><button type="button" disabled={pending} onClick={onConfirm}>{pending ? 'Deleting…' : 'Delete saved agent'}</button></div>
  </div></div>;
}
