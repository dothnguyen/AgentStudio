import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiError, InitResult, Result, Workspace, WorkspaceList, WorkspacesApi } from './api';
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog';

export const LOADING_TEXT = 'Loading workspaces…';
export const EMPTY_TITLE = 'No workspaces yet';
export const EMPTY_TEXT = 'A workspace is a project folder Agent Studio works in.';
export const LIST_TITLE = 'Workspaces';
export const ERROR_TITLE = 'Could not load workspaces';
export const BAD_RESPONSE_MESSAGE = 'workspace.list returned no workspaces array.';
export const CREATED_WORKSPACE_MISSING_MESSAGE = 'workspace.list did not return the created workspace.';
export const MISSING_BADGE = 'folder missing';

export function missingMessage(w: Workspace): string {
  return `The folder for "${w.name}" no longer exists (${w.path}). It cannot be opened.`;
}

export function toLoadResult(r: unknown): Result<WorkspaceList> {
  if (typeof r === 'object' && r !== null) {
    const o = r as { ok?: unknown; error?: unknown; data?: { workspaces?: unknown } | null };
    if (o.ok === false && typeof o.error === 'object' && o.error !== null) return r as Result<WorkspaceList>;
    if (o.ok === true && Array.isArray(o.data?.workspaces)) return r as Result<WorkspaceList>;
  }
  return { ok: false, error: { code: 'BAD_RESPONSE', message: BAD_RESPONSE_MESSAGE, retryable: false } };
}

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; workspaces: Workspace[] }
  | { kind: 'error'; error: ApiError };

function SelectedView(props: { w: Workspace; onBack: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <section data-view="selected">
      <h1>{props.w.name}</h1>
      <p className="ws-path">{props.w.path}</p>
      <button type="button" className="link" data-action="back" ref={ref} onClick={props.onBack}>
        Back
      </button>
    </section>
  );
}

function WorkspaceRow(props: { w: Workspace; focusOnMount: boolean; onSelect: (w: Workspace) => void }) {
  const { w, onSelect } = props;
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.focusOnMount) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <button
      type="button"
      className="ws-row"
      data-action="select"
      data-id={w.id}
      ref={ref}
      onClick={() => onSelect(w)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(w);
        }
      }}
    >
      <span className="ws-name">{w.name}</span>
      <span className="ws-path">{w.path}</span>
      {w.exists === false && (
        <span className="badge-missing" data-role="missing-badge">
          {MISSING_BADGE}
        </span>
      )}
    </button>
  );
}

export function WorkspacesScreen(props: { api: WorkspacesApi }) {
  const { api } = props;
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Workspace | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const seq = useRef(0);
  const active = useRef(true);

  const reload = useCallback(
    async (showLoading: boolean): Promise<void> => {
      const my = ++seq.current;
      if (showLoading) setLoad({ kind: 'loading' });
      else setRefreshing(true);
      let r: Result<WorkspaceList>;
      try {
        r = toLoadResult(await api.list());
      } catch (e) {
        r = {
          ok: false,
          error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e), retryable: false },
        };
      }
      if (!active.current || my !== seq.current) return;
      setRefreshing(false);
      setNotice(null);
      setLoad(r.ok ? { kind: 'ready', workspaces: r.data.workspaces } : { kind: 'error', error: r.error });
    },
    [api],
  );

  useEffect(() => {
    active.current = true;
    void reload(true);
    return () => {
      active.current = false;
    };
  }, [reload]);

  const refreshAfterCreate = useCallback(
    async (created: InitResult): Promise<void> => {
      setDialogOpen(false);
      const my = ++seq.current;
      setRefreshing(true);
      let r: Result<WorkspaceList>;
      try {
        r = toLoadResult(await api.list());
      } catch (e) {
        r = {
          ok: false,
          error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e), retryable: false },
        };
      }
      if (!active.current || my !== seq.current) return;
      setRefreshing(false);
      setNotice(null);
      if (!r.ok) {
        setLoad({ kind: 'error', error: r.error });
        return;
      }
      const match =
        r.data.workspaces.find((workspace) => workspace.id === created.id) ??
        r.data.workspaces.find((workspace) => workspace.path === created.path);
      if (match === undefined) {
        setLoad({
          kind: 'error',
          error: { code: 'BAD_RESPONSE', message: CREATED_WORKSPACE_MISSING_MESSAGE, retryable: false },
        });
        return;
      }
      setLoad({ kind: 'ready', workspaces: r.data.workspaces });
      setSelected(match);
    },
    [api],
  );

  const openCreateDialog = () => {
    ++seq.current;
    setRefreshing(false);
    setDialogOpen(true);
  };

  if (load.kind === 'loading') {
    return (
      <section data-view="loading">
        <p role="status">{LOADING_TEXT}</p>
      </section>
    );
  }

  if (load.kind === 'error') {
    const { error } = load;
    return (
      <section data-view="error">
        <h1>{ERROR_TITLE}</h1>
        <p role="alert" data-role="error-message">{`${error.code}: ${error.message}`}</p>
        {typeof error.remediation === 'string' && error.remediation !== '' && (
          <p data-role="error-remediation">{error.remediation}</p>
        )}
        <button type="button" onClick={() => void reload(true)}>
          Try again
        </button>
      </section>
    );
  }

  if (selected !== null) {
    return (
      <SelectedView
        w={selected}
        onBack={() => {
          setFocusId(selected.id);
          setSelected(null);
          setNotice(null);
        }}
      />
    );
  }

  const dialog = dialogOpen ? (
    <CreateWorkspaceDialog
      api={api}
      onCancel={() => setDialogOpen(false)}
      onCreated={(created) => void refreshAfterCreate(created)}
    />
  ) : null;

  if (load.workspaces.length === 0) {
    return (
      <>
        <section data-view="empty" className="empty">
          <h1>{EMPTY_TITLE}</h1>
          <p>{EMPTY_TEXT}</p>
          <button type="button" className="primary" data-action="create" onClick={openCreateDialog}>
            Create workspace
          </button>
        </section>
        {dialog}
      </>
    );
  }

  const onSelect = (w: Workspace) => {
    if (w.exists) {
      setNotice(null);
      setSelected(w);
    } else {
      setNotice(missingMessage(w));
    }
  };

  return (
    <>
      <section data-view="list">
        <h1>{LIST_TITLE}</h1>
        <div className="toolbar">
          <button type="button" className="secondary" data-action="create" onClick={openCreateDialog}>
            Create workspace
          </button>
          <button
            type="button"
            data-action="refresh"
            disabled={refreshing}
            onClick={() => {
              if (!refreshing) void reload(false);
            }}
          >
            Refresh
          </button>
        </div>
        {notice && (
          <p role="alert" data-role="notice">
            {notice}
          </p>
        )}
        <ul aria-label="Workspaces">
          {load.workspaces.map((w) => (
            <li key={w.id}>
              <WorkspaceRow w={w} focusOnMount={focusId === w.id} onSelect={onSelect} />
            </li>
          ))}
        </ul>
      </section>
      {dialog}
    </>
  );
}
