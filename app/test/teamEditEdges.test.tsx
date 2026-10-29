// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamsScreen } from '../src/renderer/teams/TeamsScreen';
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
    render(<TeamsScreen workspace={workspaceA} management={fake.api} />);
    await flush();
    await click('Rename team');
    await click('Save name');
    expect(screen.getByText('Enter a different name.')).toBeTruthy();
    expect(renameTeam).not.toHaveBeenCalled();
  });

  it('unreadable_team_shows_note_and_no_controls', async () => {
    const fake = fakeManagement({
      overview: [ok(overviewFixture([team({ definition: { state: 'unreadable', problems: [] } })]))],
    });
    render(<TeamsScreen workspace={workspaceA} management={fake.api} />);
    await flush();
    expect(screen.getByText(/could not be read; fix the file/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rename team' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add member' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    await flush();
    expect(screen.queryByRole('button', { name: 'Rename team' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add member' })).toBeNull();
  });

  it('write_result_after_unmount_is_ignored', async () => {
    const gate = deferred<ReturnType<typeof ok>>();
    const createTeam = vi.fn(() => gate.promise);
    const fake = fakeManagement({ calls: { createTeam } });
    const view = render(<TeamsScreen workspace={workspaceA} management={fake.api} />);
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
