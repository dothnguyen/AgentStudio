import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiError, ConnectionStatus, DashboardApi, InitResult, ManagementApi, Result, Workspace, WorkspaceList, WorkspacesApi } from './api';
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog';
import { WorkspaceShell } from './shell/WorkspaceShell';

export const LOADING_TEXT = 'Loading workspaces…';
export const EMPTY_TITLE = 'No workspaces yet';
export const EMPTY_TEXT = 'A workspace is a project folder Agent Studio works in.';
export const LIST_TITLE = 'Workspaces';
export const ERROR_TITLE = 'Could not load workspaces';
export const BAD_RESPONSE_MESSAGE = 'workspace.list returned no workspaces array.';
export const CREATED_WORKSPACE_MISSING_MESSAGE = 'workspace.list did not return the created workspace.';
export const MISSING_BADGE = 'folder missing';
export const PRODUCT_SUBTITLE = 'Coordinate coding agents across your workspaces.';

export function StudioMark() {
  return (
    <svg className="studio-mark" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M7.5 8.5h7l2 2h8v13h-17z" />
      <path d="m12 15 3 3-3 3m5.5 0h3" />
    </svg>
  );
}

function WorkspaceLayout(props: { children: ReactNode }) {
  return (
    <div className="workspace-welcome">
      <header className="product-identity">
        <StudioMark />
        <div>
          <div className="product-name">Agent Studio</div>
          <p>{PRODUCT_SUBTITLE}</p>
        </div>
      </header>
      {props.children}
    </div>
  );
}

function FolderIcon() {
  return (
    <svg className="folder-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2.5 5.5h6l1.6 2h7.4v8.5h-15z" />
    </svg>
  );
}

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
      <FolderIcon />
      <span className="ws-details">
        <span className="ws-name">{w.name}</span>
        <span className="ws-path" title={w.path}>{w.path}</span>
      </span>
      <span className="ws-affordance">
        {w.exists === false && (
          <span className="badge-missing" data-role="missing-badge">
            {MISSING_BADGE}
          </span>
        )}
        <span className="row-chevron" aria-hidden="true">›</span>
      </span>
    </button>
  );
}

export function WorkspacesScreen(props: { api: WorkspacesApi; dashboard: DashboardApi; management: ManagementApi; connection: ConnectionStatus }) {
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
      <WorkspaceLayout>
        <section data-view="loading" className="workspace-panel state-panel">
          <div className="spinner" aria-hidden="true" />
          <p role="status">{LOADING_TEXT}</p>
        </section>
      </WorkspaceLayout>
    );
  }

  if (load.kind === 'error') {
    const { error } = load;
    return (
      <WorkspaceLayout>
        <section data-view="error" className="workspace-panel error-panel">
          <div className="state-icon error-icon" aria-hidden="true">!</div>
          <div className="state-content">
            <h1>{ERROR_TITLE}</h1>
            <p role="alert" data-role="error-message">{`${error.code}: ${error.message}`}</p>
            {typeof error.remediation === 'string' && error.remediation !== '' && (
              <p data-role="error-remediation">{error.remediation}</p>
            )}
            <button type="button" onClick={() => void reload(true)}>
              Try again
            </button>
          </div>
        </section>
      </WorkspaceLayout>
    );
  }

  if (selected !== null) {
    return (
      <WorkspaceShell
        workspace={selected}
        dashboard={props.dashboard}
        management={props.management}
        connection={props.connection}
        onSwitchWorkspace={() => {
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
        <WorkspaceLayout>
          <section data-view="empty" className="workspace-panel empty">
            <div className="empty-folder" aria-hidden="true">
              <FolderIcon />
            </div>
            <h1>{EMPTY_TITLE}</h1>
            <p>{EMPTY_TEXT}</p>
            <button type="button" className="primary" data-action="create" onClick={openCreateDialog}>
              Create workspace
            </button>
          </section>
        </WorkspaceLayout>
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
      <WorkspaceLayout>
        <section data-view="list" className="workspace-panel workspace-list">
          <div className="section-heading">
            <h1>{LIST_TITLE}</h1>
            <div className="toolbar">
              <button type="button" className="primary" data-action="create" onClick={openCreateDialog}>
                Create workspace
              </button>
              <button
                type="button"
                className="secondary refresh-button"
                data-action="refresh"
                disabled={refreshing}
                onClick={() => {
                  if (!refreshing) void reload(false);
                }}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M13.2 5.5A5.5 5.5 0 1 0 13 11m.2-5.5V2m0 3.5H9.7" />
                </svg>
                Refresh
              </button>
            </div>
          </div>
          {notice && (
            <p role="alert" data-role="notice" className="notice-panel">
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
      </WorkspaceLayout>
      {dialog}
    </>
  );
}
