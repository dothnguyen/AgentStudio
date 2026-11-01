// Operator-only capture page: renders the real Roles screen through WorkspaceShell
// with the design sample fixture. It is never part of the production bundle.
import { useEffect, useMemo, type JSX } from 'react';
import { WorkspaceShell } from '../src/renderer/shell/WorkspaceShell';
import { TEAMS_V4_CONNECTION, TEAMS_V4_WORKSPACE } from './teamsOverviewV4Fixture';
import { createRolesCatalogV2Apis } from './rolesCatalogV2Fixture';

/** Opens Roles from the real sidebar; false when the nav button is not there yet. */
export function openRolesSection(root: ParentNode): boolean {
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>('.workspace-nav .nav-item'))
    .find(candidate => candidate.querySelector('.nav-label')?.textContent === 'Roles');
  if (button === undefined || button.disabled) return false;
  button.click();
  return true;
}

/** True once the Roles list has rendered a role row. */
export function isRolesListReady(root: ParentNode): boolean {
  return root.querySelector('[data-section="roles"] .roles-table-list [data-role-id]') !== null;
}

export function RolesCaptureApp(): JSX.Element {
  const apis = useMemo(() => createRolesCatalogV2Apis(), []);

  useEffect(() => {
    let opened = false;
    let done = false;
    let cancelled = false;

    const timer = window.setInterval(() => {
      if (!opened) {
        opened = openRolesSection(document);
        return;
      }
      if (!done && isRolesListReady(document)) {
        done = true;
        window.clearInterval(timer);
        void markReady();
      }
    }, 50);

    const timeout = window.setTimeout(() => {
      if (!done) {
        window.clearInterval(timer);
        document.documentElement.dataset.captureError = 'The Roles list did not render the fixture catalog.';
      }
    }, 10000);

    async function markReady(): Promise<void> {
      if ('fonts' in document) await document.fonts.ready;
      await new Promise<void>((resolve) => { window.setTimeout(() => resolve(), 150); });
      if (cancelled) return;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      document.documentElement.dataset.captureReady = 'true';
    }

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearTimeout(timeout);
    };
  }, []);

  return (
    <WorkspaceShell
      workspace={TEAMS_V4_WORKSPACE}
      dashboard={apis.dashboard}
      management={apis.management}
      connection={TEAMS_V4_CONNECTION}
      onSwitchWorkspace={() => undefined}
    />
  );
}
