import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type { ConnectionStatus, DashboardApi, Workspace } from '../api';
import { DashboardHome } from '../dashboard/DashboardHome';
import { getSectionContent, SectionPlaceholder } from '../sections/SectionPlaceholder';
import { DEFAULT_SECTION, NAV_ITEMS, type NavItem } from './navModel';

export interface WorkspaceShellProps {
  workspace: Workspace;
  dashboard: DashboardApi;
  connection: ConnectionStatus;
  onSwitchWorkspace(): void;
  items?: readonly NavItem[];
  renderSection?: (
    sectionId: string,
    navigate: (sectionId: string) => void,
  ) => ReactNode | undefined;
}

export function WorkspaceShell(props: WorkspaceShellProps): JSX.Element {
  const items = props.items ?? NAV_ITEMS;
  const [sectionId, setSectionId] = useState<string>(DEFAULT_SECTION);

  useEffect(() => {
    setSectionId(DEFAULT_SECTION);
  }, [props.workspace.id]);

  const navigate = (nextId: string) => {
    const item = items.find((candidate) => candidate.id === nextId);
    if (item !== undefined && item.disabled !== true) setSectionId(nextId);
  };

  const selectedItem = items.find((item) => item.id === sectionId);
  const section = props.renderSection?.(sectionId, navigate);
  const content = getSectionContent(sectionId, selectedItem?.label ?? sectionId);
  const defaultSection = sectionId === 'home' ? (
    <DashboardHome
      workspace={props.workspace}
      dashboard={props.dashboard}
      connection={props.connection}
      onNavigate={(nextId) => navigate(nextId)}
    />
  ) : (
    <SectionPlaceholder sectionId={sectionId} title={content.title} description={content.description} />
  );

  return (
    <div className="workspace-shell">
      <aside className="workspace-sidebar" aria-label="Workspace sidebar">
        <header className="workspace-identity">
          <div className="workspace-name" title={props.workspace.name}>{props.workspace.name}</div>
          <div className="workspace-path" title={props.workspace.path}>{props.workspace.path}</div>
        </header>
        <button type="button" className="switch-workspace" onClick={props.onSwitchWorkspace}>
          Switch workspace
        </button>
        <nav aria-label="Workspace">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={item.disabled === true}
              aria-current={item.id === sectionId ? 'page' : undefined}
              onClick={() => navigate(item.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  navigate(item.id);
                }
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="workspace-content">
        {section === undefined ? defaultSection : section}
      </main>
    </div>
  );
}
