// Operator-only capture page: renders the real Skills screen through WorkspaceShell
// with the design sample fixture. It is never part of the production bundle.
import { useEffect, useMemo, type JSX } from 'react';
import { WorkspaceShell } from '../src/renderer/shell/WorkspaceShell';
import { createSkillsV1Apis } from './skillsV1Fixture';
import { TEAMS_V4_CONNECTION, TEAMS_V4_WORKSPACE } from './teamsOverviewV4Fixture';

/** Opens Skills from the real sidebar; false when the nav button is not there yet. */
export function openSkillsSection(root: ParentNode): boolean {
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>('.workspace-nav .nav-item'))
    .find(candidate => candidate.querySelector('.nav-label')?.textContent === 'Skills');
  if (button === undefined || button.disabled) return false;
  button.click();
  return true;
}

/** True once the Skills list has rendered a skill row. */
export function isSkillsListReady(root: ParentNode): boolean {
  return root.querySelector('[data-section="skills"] .skills-table-list [data-skill-id]') !== null;
}

/** Optional query state for a headless screenshot: the same states the capture script clicks. */
export function skillsDialogSelector(dialog: string | null): string | null {
  switch (dialog) {
    case 'content': return 'button[aria-label="Edit skill content"]';
    case 'roles': return 'button[aria-label="Edit roles that use this skill"]';
    case 'new': return '.skills-new-button';
    case 'delete': return '.skills-delete-button';
    default: return null;
  }
}

export function SkillsCaptureApp(): JSX.Element {
  const apis = useMemo(() => createSkillsV1Apis(), []);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(window.location.search);
    const skill = params.get('skill');
    const dialog = params.get('dialog');

    async function waitFor(check: () => boolean, label: string): Promise<void> {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (cancelled) return;
        if (check()) return;
        await new Promise<void>((resolve) => { window.setTimeout(() => resolve(), 50); });
      }
      throw new Error(`${label} was not ready.`);
    }

    async function run(): Promise<void> {
      await waitFor(() => openSkillsSection(document), 'the Skills navigation item');
      await waitFor(() => isSkillsListReady(document), 'the Skills list');
      if (skill !== null) {
        const row = document.querySelector<HTMLElement>(`[data-skill-id="${skill}"]`);
        if (row === null) throw new Error(`Skill ${skill} is not in the list.`);
        row.click();
        await waitFor(() => document.querySelector('[data-section="skills"] .skills-page') !== null, `the ${skill} page`);
      }
      const selector = skillsDialogSelector(dialog);
      if (selector !== null) {
        const opener = document.querySelector<HTMLElement>(selector);
        if (opener === null) throw new Error(`The ${dialog} dialog opener is missing.`);
        opener.click();
        await waitFor(() => document.querySelector('[role="dialog"], [role="alertdialog"]') !== null, `the ${dialog} dialog`);
      }
      if ('fonts' in document) await document.fonts.ready;
      await new Promise<void>((resolve) => { window.setTimeout(() => resolve(), 400); });
      if (cancelled) return;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      document.documentElement.dataset.captureReady = 'true';
    }

    void run().catch((error: unknown) => {
      document.documentElement.dataset.captureError = error instanceof Error ? error.message : String(error);
    });
    return () => { cancelled = true; };
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
