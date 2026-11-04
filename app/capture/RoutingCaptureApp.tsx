// Operator-only capture page: renders the real Routing screen through WorkspaceShell
// with the routing v1 sample fixture. It is never part of the production bundle.
import { useEffect, useMemo, type JSX } from 'react';
import { WorkspaceShell } from '../src/renderer/shell/WorkspaceShell';
import { TEAMS_V4_CONNECTION } from './teamsOverviewV4Fixture';
import { ROUTING_V1_WORKSPACE, createRoutingV1Apis } from './routingV1Fixture';

/** Opens Routing from the real sidebar; false when the nav button is not there yet. */
export function openRoutingSection(root: ParentNode): boolean {
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>('.workspace-nav .workflow-nav-item'))
    .find(candidate => candidate.textContent === 'Routing');
  if (button === undefined || button.disabled) return false;
  button.click();
  return true;
}

/** True once the Routing screen has rendered its rules table. */
export function isRoutingScreenReady(root: ParentNode): boolean {
  return root.querySelector('[data-section="routing"] .routing-rules-list') !== null;
}

export function RoutingCaptureApp(): JSX.Element {
  const apis = useMemo(() => createRoutingV1Apis(), []);

  useEffect(() => {
    let opened = false;
    let done = false;
    let cancelled = false;

    const timer = window.setInterval(() => {
      if (!opened) {
        opened = openRoutingSection(document);
        return;
      }
      if (!done && isRoutingScreenReady(document)) {
        done = true;
        window.clearInterval(timer);
        void markReady();
      }
    }, 50);

    const timeout = window.setTimeout(() => {
      if (!done) {
        window.clearInterval(timer);
        document.documentElement.dataset.captureError = 'The Routing screen did not render the fixture rules.';
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
      workspace={ROUTING_V1_WORKSPACE}
      dashboard={apis.dashboard}
      management={apis.management}
      connection={TEAMS_V4_CONNECTION}
      onSwitchWorkspace={() => undefined}
    />
  );
}
