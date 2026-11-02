// Operator-only capture page: renders the real Current Phase board and ticket page
// through WorkspaceShell with the Boards v1 sample fixture. It is never part of the
// production bundle.
import { useEffect, useMemo, type JSX } from 'react';
import { WorkspaceShell } from '../src/renderer/shell/WorkspaceShell';
import { TEAMS_V4_CONNECTION } from './teamsOverviewV4Fixture';
import { BOARDS_V1_WORKSPACE, createBoardsV1Apis } from './boardsV1Fixture';

export type BoardsCaptureMode = 'board' | 'board-all' | 'ticket-working' | 'ticket-waiting' | 'ticket-blocked' | 'ticket-done' | 'backlog' | 'backlog-filtered' | 'backlog-collapsed' | 'phases';

export const BOARDS_CAPTURE_TICKETS: Record<'ticket-working' | 'ticket-waiting' | 'ticket-blocked' | 'ticket-done', string> = {
  'ticket-working': 'T-114',
  'ticket-waiting': 'T-118',
  'ticket-blocked': 'T-136',
  'ticket-done': 'T-112',
};

/** Parses the `view` query used by capture:boards; defaults to the plain board. */
export function boardsCaptureMode(search: string): BoardsCaptureMode {
  const value = new URLSearchParams(search).get('view');
  switch (value) {
    case 'backlog':
    case 'backlog-filtered':
    case 'backlog-collapsed':
    case 'phases':
    case 'board-all':
    case 'ticket-working':
    case 'ticket-waiting':
    case 'ticket-blocked':
    case 'ticket-done':
      return value;
    default:
      return 'board';
  }
}

/** Opens Boards from the real sidebar; false when the nav button is not there yet. */
export function openBoardsSection(root: ParentNode): boolean {
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>('.workspace-nav .nav-item'))
    .find(candidate => candidate.querySelector('.nav-label')?.textContent === 'Boards');
  if (button === undefined || button.disabled) return false;
  button.click();
  return true;
}

/** True once the Current Phase board has rendered its lanes. */
export function isBoardReady(root: ParentNode): boolean {
  return root.querySelector('[data-section="boards/current"] .boards-board-lanes') !== null;
}

/** True once one ticket page has rendered its heading. */
export function isTicketReady(root: ParentNode): boolean {
  return root.querySelector('[data-section="boards/ticket"] .boards-ticket-heading h1') !== null;
}

export function BoardsCaptureApp(): JSX.Element {
  const apis = useMemo(() => createBoardsV1Apis(boardsCaptureMode(window.location.search) === 'phases'), []);

  useEffect(() => {
    let cancelled = false;
    const mode = boardsCaptureMode(window.location.search);

    async function waitFor(check: () => boolean, label: string): Promise<void> {
      for (let attempt = 0; attempt < 240; attempt++) {
        if (cancelled) return;
        if (check()) return;
        await new Promise<void>((resolve) => { window.setTimeout(() => resolve(), 50); });
      }
      throw new Error(`${label} was not ready.`);
    }

    function clickButton(name: string): boolean {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find(candidate => (candidate.getAttribute('aria-label') ?? candidate.textContent ?? '').trim() === name);
      if (button === undefined || button.disabled) return false;
      button.click();
      return true;
    }

    async function run(): Promise<void> {
      await waitFor(() => openBoardsSection(document), 'the Boards navigation item');
      await waitFor(() => isBoardReady(document), 'the Current Phase board');

      if (mode.startsWith('backlog') || mode === 'phases') {
        const target = mode === 'phases' ? 'Phases' : 'Backlog';
        await waitFor(() => {
          const nav = Array.from(document.querySelectorAll<HTMLButtonElement>('.boards-nav-item')).find(button => button.textContent?.trim().startsWith(target));
          if (!nav) return false;
          nav.click();
          return true;
        }, `${target} navigation`);
        await waitFor(() => document.querySelector(`[data-section="boards/${target.toLowerCase()}"] ${mode === 'phases' ? '.boards-milestone-card' : '.boards-backlog-group'}`) !== null, target);
        if (mode === 'backlog-filtered') {
          const input = document.querySelector<HTMLInputElement>('[data-section="boards/backlog"] input[placeholder="Search tickets"]')!;
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'T-136');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await waitFor(() => document.querySelector('.boards-backlog-active') !== null, 'filtered backlog');
        } else if (mode === 'backlog-collapsed') {
          document.querySelectorAll<HTMLButtonElement>('.boards-backlog-group-header[aria-expanded="true"]').forEach(button => button.click());
          await waitFor(() => document.querySelector('.boards-backlog-row') === null, 'collapsed backlog');
        }
      } else if (mode === 'board-all') {
        const chip = document.querySelector<HTMLButtonElement>('.boards-filter-chip[aria-pressed="true"]');
        if (chip !== null && (chip.textContent ?? '').trim() === 'Hide empty columns') chip.click();
        await waitFor(() => document.querySelector<HTMLButtonElement>('.boards-lane-toggle[aria-label="Expand Finished lane"]') !== null, 'the Finished lane toggle');
        clickButton('Expand Finished lane');
      } else if (mode.startsWith('ticket-')) {
        const ticketMode = mode as keyof typeof BOARDS_CAPTURE_TICKETS;
        const key = BOARDS_CAPTURE_TICKETS[ticketMode];
        if (document.querySelector(`[data-ticket-key="${key}"]`) === null) {
          clickButton('Expand Finished lane');
          await new Promise<void>((resolve) => { window.setTimeout(() => resolve(), 50); });
        }
        await waitFor(() => {
          const card = document.querySelector<HTMLButtonElement>(`[data-ticket-key="${key}"]`);
          if (card === null) return false;
          card.click();
          return true;
        }, `the ${key} ticket card`);
        await waitFor(() => isTicketReady(document), `the ${key} ticket page`);
      }

      if ('fonts' in document) await document.fonts.ready;
      await new Promise<void>((resolve) => { window.setTimeout(() => resolve(), 150); });
      if (cancelled) return;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      document.documentElement.dataset.captureReady = 'true';
    }

    run().catch((error: unknown) => {
      if (!cancelled) {
        document.documentElement.dataset.captureError = error instanceof Error ? error.message : String(error);
      }
    });

    return () => { cancelled = true; };
  }, []);

  return (
    <WorkspaceShell
      workspace={BOARDS_V1_WORKSPACE}
      dashboard={apis.dashboard}
      management={apis.management}
      connection={TEAMS_V4_CONNECTION}
      onSwitchWorkspace={() => undefined}
    />
  );
}
