import { useEffect, useId, useRef, type JSX, type KeyboardEvent } from 'react';
import type { RoleCatalogItem } from '../api';
import { instructionDeleteDescription } from './rolesModel';

export interface RoleDeleteDialogProps {
  role: Pick<RoleCatalogItem, 'id' | 'name' | 'instructions'>;
  pending: boolean;
  blockedReason: string | null;
  shared?: boolean;
  onCancel(): void;
  onConfirm(): void;
}
export function RoleDeleteDialog({ role, pending, blockedReason, shared = false, onCancel, onConfirm }: RoleDeleteDialogProps): JSX.Element {
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
  const name = role.name?.trim() || role.id;
  return <div className="modal-overlay"><div className="create-workspace-dialog roles-delete-dialog" role="dialog" aria-modal="true" aria-labelledby={heading} aria-describedby={`${heading}-description`} ref={dialog} onKeyDown={keyDown}>
    <h2 id={heading}>Delete role</h2>
    <p className="roles-delete-name">Delete role "{name}" (<code>{role.id}</code>)?</p>
    <p id={`${heading}-description`} className="roles-delete-copy">{instructionDeleteDescription(role, shared)} The backend re-checks every reference before deleting.</p>
    {blockedReason && <p id={`${heading}-blocked`} className="roles-delete-copy" role="status">{blockedReason}</p>}
    <div className="dialog-actions roles-delete-actions">
      <button ref={cancel} type="button" disabled={pending} onClick={onCancel}>Cancel</button>
      <button type="button" className="roles-delete-confirm" aria-busy={pending} aria-describedby={blockedReason ? `${heading}-blocked` : undefined} disabled={pending || !!blockedReason} onClick={onConfirm}>Delete role</button>
    </div>
  </div></div>;
}
