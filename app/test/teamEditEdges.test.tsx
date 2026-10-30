// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamsHarness } from './teamsHarness';
import { workspaceA } from './dashboardFixtures';
import { deferred, fakeManagement, overviewFixture, team, teamDefinition } from './teamsFixtures';

afterEach(cleanup);

const flush = () => act(async () => {});
const click = async (name: string | RegExp) => {
  fireEvent.click(screen.getByRole('button', { name }));
  await flush();
};
const ok = <T,>(data: T) => ({ ok: true as const, data });

describe('team editing edge cases', () => {
  it('rename_to_same_name_is_not_sent', async () => {
    const renameTeam = vi.fn();
    const fake = fakeManagement({ calls: { renameTeam } });
    render(<TeamsHarness workspace={workspaceA} management={fake.api} />);
    await flush();
    await click('Rename team');
    await click('Save name');
    expect(screen.getByText('Enter a different name.')).toBeTruthy();
    expect(renameTeam).not.toHaveBeenCalled();
  });

  it('compact_team_actions_disable_stale_writes_and_restore_focus_after_failed_mutation', async () => {
    const stale = fakeManagement({ overview: [ok(overviewFixture([team()])), { ok: false, error: { code: 'INTERNAL', message: 'down', retryable: true } }] });
    render(<TeamsHarness workspace={workspaceA} management={stale.api} />);
    await flush();
    await click('Refresh');
    expect((screen.getByRole('button', { name: 'Rename team' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Delete team' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    const renameTeam = vi.fn(async () => ({ ok: false as const, error: { code: 'TEAM_EXISTS', message: 'Name taken.', retryable: false } }));
    const deleteTeam = vi.fn(async () => ({ ok: false as const, error: { code: 'TEAM_ALREADY_RUNNING', message: 'Team is running.', retryable: false } }));
    const fake = fakeManagement({ calls: { renameTeam, deleteTeam } });
    render(<TeamsHarness workspace={workspaceA} management={fake.api} />);
    await flush();
    await click('Rename team');
    fireEvent.change(screen.getByLabelText('Team name'), { target: { value: 'Other' } });
    await click('Save name');
    expect(screen.getByRole('alert').textContent).toContain('TEAM_EXISTS: Name taken.');
    expect(screen.getByRole('form', { name: 'Rename team' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save name' }));
    expect(screen.getByRole('region', { name: 'Dev Team' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await click('Delete team');
    await click('Confirm delete');
    expect(screen.getByRole('alert').textContent).toContain('TEAM_ALREADY_RUNNING: Team is running.');
    expect(deleteTeam).toHaveBeenCalledWith('ws-a', 'dev-team');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm delete' }));
    expect(screen.getByRole('region', { name: 'Dev Team' })).toBeTruthy();
  });

  it('compact_team_actions_keep_runtime_only_and_unreadable_definitions_uneditable', async () => {
    const cases = [
      { t: team({ id: null, name: null, definition: { state: 'missing', problems: [] }, runtime: { state: 'running', teamId: 'rt-9', status: 'running' } }), note: 'This team has no definition file; it cannot be edited here.' },
      { t: team({ definition: { state: 'unreadable', problems: [] } }), note: /could not be read; fix the file/ },
    ];
    for (const c of cases) {
      const fake = fakeManagement({ overview: [ok(overviewFixture([c.t]))] });
      const view = render(<TeamsHarness workspace={workspaceA} management={fake.api} />);
      await flush();
      const panel = within(screen.getByRole('tabpanel', { name: 'Overview' }));
      expect(panel.getByText(c.note)).toBeTruthy();
      expect(panel.queryByRole('button', { name: 'Rename team' })).toBeNull();
      expect(panel.queryByRole('button', { name: 'Delete team' })).toBeNull();
      view.unmount();
    }
  });

  it('unreadable_team_shows_note_and_no_controls', async () => {
    const fake = fakeManagement({
      overview: [ok(overviewFixture([team({ definition: { state: 'unreadable', problems: [] } })]))],
    });
    render(<TeamsHarness workspace={workspaceA} management={fake.api} />);
    await flush();
    const panel = within(screen.getByRole('tabpanel', { name: 'Overview' }));
    expect(panel.getByText(/could not be read; fix the file/)).toBeTruthy();
    expect(panel.getByText('Definition: Unreadable')).toBeTruthy();
    expect(panel.queryByRole('button', { name: 'Delete team' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename team' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add member' })).toBeNull();
  });

  it('write_result_after_unmount_is_ignored', async () => {
    const gate = deferred<ReturnType<typeof ok>>();
    const createTeam = vi.fn(() => gate.promise);
    const fake = fakeManagement({ calls: { createTeam } });
    const view = render(<TeamsHarness workspace={workspaceA} management={fake.api} />);
    await flush();
    await click('New team');
    fireEvent.change(screen.getByLabelText('Team name'), { target: { value: 'QA Team' } });
    fireEvent.submit(screen.getByRole('form', { name: 'New team' }));
    await flush();
    view.unmount();
    gate.resolve(ok({ team: teamDefinition({ id: 'qa-team', name: 'QA Team' }), problems: [] }));
    await flush();
    expect(fake.overview).toHaveBeenCalledTimes(1);
  });
});
