import { useState, type JSX } from 'react';
import type { BoardSettings, ManagementApi } from '../api';
import { Dialog } from '../teams/Dialog';

export function todoOptions(settings: Pick<BoardSettings, 'todoEntry' | 'workflowStatuses'>): Array<{ id: string; name: string }> {
  return settings.todoEntry.map(id => ({ id, name: settings.workflowStatuses.find(status => status.id === id)?.name || id }));
}

export function MoveToTodoDialog(props: { ticketKey: string; settings: BoardSettings; management: ManagementApi; workspaceId: string; force?: boolean; onClose(): void; onSuccess(): void }): JSX.Element {
  const options = todoOptions(props.settings);
  const [selected, setSelected] = useState(props.settings.todoDefault ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function move(): Promise<void> {
    setBusy(true); setError(null);
    try {
      const result = await props.management.ticketMove(props.workspaceId, { key: props.ticketKey, to: 'todo', workflowStatus: selected, ...(props.force ? { force: true } : {}) });
      if (result.ok) props.onSuccess(); else setError(result.error.message);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <Dialog title={props.force ? 'Reopen ticket' : 'Move to Todo'} onClose={props.onClose} busy={busy} actions={[
    { label: 'Cancel', onClick: props.onClose },
    { label: props.force ? 'Reopen' : 'Move to Todo', variant: 'primary', disabled: !options.some(option => option.id === selected), onClick: () => { void move(); } },
  ]}>
    <label>Workflow status <select value={selected} onChange={event => setSelected(event.target.value)}>{options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
    {error && <p role="alert">{error}</p>}
  </Dialog>;
}
