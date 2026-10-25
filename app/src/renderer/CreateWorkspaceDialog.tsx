import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ApiError, CreateArgs, InitResult, WorkspacesApi } from './api';

export interface CreateWorkspaceDialogProps {
  api: Pick<WorkspacesApi, 'create' | 'pickFolder'>;
  onCancel(): void;
  onCreated(created: InitResult): void;
}

function internalError(error: unknown): ApiError {
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

export function CreateWorkspaceDialog(props: CreateWorkspaceDialogProps) {
  const [folder, setFolder] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [creating, setCreating] = useState(false);
  const folderRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const creatingRef = useRef(false);
  const createdRef = useRef(false);
  const headingId = useId();

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    mountedRef.current = true;
    folderRef.current?.focus();
    return () => {
      mountedRef.current = false;
      if (!createdRef.current && opener?.isConnected) opener.focus();
    };
  }, []);

  const browse = async () => {
    setError(null);
    try {
      const result = await props.api.pickFolder();
      if (!mountedRef.current) return;
      if (result.ok) {
        if (result.data !== null) setFolder(result.data);
      } else {
        setError(result.error);
      }
    } catch (e) {
      if (mountedRef.current) setError(internalError(e));
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creatingRef.current) return;
    if (folder.trim() === '') {
      setError({ code: '', message: 'Folder is required.', retryable: false });
      return;
    }

    creatingRef.current = true;
    setCreating(true);
    setError(null);
    const args: CreateArgs = { path: folder };
    if (name.trim() !== '') args.name = name;

    try {
      const result = await props.api.create(args);
      if (!mountedRef.current) return;
      if (result.ok) {
        createdRef.current = true;
        props.onCreated(result.data);
        return;
      }
      creatingRef.current = false;
      setCreating(false);
      setError(result.error);
    } catch (e) {
      if (!mountedRef.current) return;
      creatingRef.current = false;
      setCreating(false);
      setError(internalError(e));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!creatingRef.current) props.onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? [],
    );
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!controls.includes(document.activeElement as HTMLElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal-overlay">
      <div
        className="create-workspace-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <h2 id={headingId}>Create workspace</h2>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor={`${headingId}-folder`}>Folder</label>
          <div className="folder-control">
            <input
              id={`${headingId}-folder`}
              ref={folderRef}
              type="text"
              value={folder}
              disabled={creating}
              onChange={(event) => {
                setFolder(event.target.value);
                setError(null);
              }}
            />
            <button type="button" disabled={creating} onClick={() => void browse()}>
              Browse…
            </button>
          </div>
          <label htmlFor={`${headingId}-name`}>Name (optional)</label>
          <input
            id={`${headingId}-name`}
            type="text"
            value={name}
            disabled={creating}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
          />
          {error !== null && (
            <div className="dialog-error">
              {error.code === '' ? (
                <p role="alert">{error.message}</p>
              ) : (
                <p role="alert">
                  <code>{error.code}</code>: {error.message}
                </p>
              )}
              {typeof error.remediation === 'string' && error.remediation !== '' && (
                <p className="dialog-remediation">{error.remediation}</p>
              )}
            </div>
          )}
          {creating && <p role="status">Creating workspace…</p>}
          <div className="dialog-actions">
            <button type="button" disabled={creating} onClick={props.onCancel}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={creating}>
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
