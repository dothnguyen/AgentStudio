// Operator-only capture page: renders the real Teams overview through WorkspaceShell
// with the v4 sample fixture. It is never part of the production bundle.
import { useEffect, useMemo, type JSX } from 'react';
import { WorkspaceShell } from '../src/renderer/shell/WorkspaceShell';
import {
  TEAMS_V4_CONNECTION,
  TEAMS_V4_MEMBER_IDS,
  TEAMS_V4_TEAM_NAME,
  TEAMS_V4_WORKSPACE,
  createTeamsOverviewV4Apis,
} from './teamsOverviewV4Fixture';

/** Opens the fixture team from the real sidebar; false when the row is not there yet. */
export function openFixtureTeam(root: ParentNode): boolean {
  const row = root.querySelector<HTMLButtonElement>('ul[aria-label="Workspace teams"] button');
  if (row === null || row.disabled) return false;
  row.click();
  return true;
}

/** True once the team detail heading and every fixture member row are rendered. */
export function isFixtureScreenReady(root: Document): boolean {
  return (root.getElementById('teams-detail-title')?.textContent ?? '').includes(TEAMS_V4_TEAM_NAME)
    && root.querySelectorAll('[data-member-row]').length === TEAMS_V4_MEMBER_IDS.length;
}

export function TeamsCaptureApp(): JSX.Element {
  const apis = useMemo(() => createTeamsOverviewV4Apis(), []);

  useEffect(() => {
    let opened = false;
    let done = false;
    let cancelled = false;

    const timer = window.setInterval(() => {
      if (!opened) {
        opened = openFixtureTeam(document);
        return;
      }
      if (!done && isFixtureScreenReady(document)) {
        done = true;
        window.clearInterval(timer);
        void markReady();
      }
    }, 50);

    const timeout = window.setTimeout(() => {
      if (!done) {
        window.clearInterval(timer);
        document.documentElement.dataset.captureError = 'The Teams overview did not render the fixture team.';
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
