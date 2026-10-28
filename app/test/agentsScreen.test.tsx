// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentsScreen } from '../src/renderer/agents/AgentsScreen';
import { catalogFixture, fakeManagement, member, overviewFixture, team } from './teamsFixtures';
import type { Workspace } from '../src/renderer/api';
const workspace: Workspace = { id: 'a', name: 'A', path: '/a', exists: true, missing: false };
afterEach(cleanup);
describe('AgentsScreen', () => {
  it('loads_catalog_and_overview_once_and_renders_one_main_h1', async () => {
    const fake = fakeManagement(); const view = render(<main><AgentsScreen workspace={workspace} management={fake.api} /></main>);
    await view.findByRole('list', { name: 'Saved agents' });
    expect(fake.agents).toHaveBeenCalledTimes(1); expect(fake.overview).toHaveBeenCalledTimes(1); expect(within(view.getByRole('main')).getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
  it('search_and_combined_filters_keep_catalog_order_and_show_no_match_state', async () => {
    const fake = fakeManagement(); const view = render(<AgentsScreen workspace={workspace} management={fake.api} />); await view.findByRole('list', { name: 'Saved agents' });
    fireEvent.change(view.getByLabelText('Provider'), { target: { value: 'codex' } }); expect(view.getByText('1 agent')).toBeTruthy();
    fireEvent.change(view.getByLabelText('Search agents'), { target: { value: 'missing' } }); expect(view.getByText('No agents match the current search and filters.')).toBeTruthy();
    fireEvent.change(view.getByLabelText('Provider'), { target: { value: '' } }); fireEvent.change(view.getByLabelText('Search agents'), { target: { value: '' } }); expect(within(view.getByRole('list', { name: 'Saved agents' })).getAllByRole('button')).toHaveLength(3);
  });
  it('selection_is_retained_while_visible_and_falls_back_after_filtering', async () => {
    const fake = fakeManagement(); const view = render(<AgentsScreen workspace={workspace} management={fake.api} />); await view.findByRole('list', { name: 'Saved agents' });
    fireEvent.click(view.getByRole('button', { name: /Codex GPT/ })); expect(view.getByRole('button', { name: /Codex GPT/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(view.getByLabelText('Provider'), { target: { value: 'claude' } }); expect(view.getByRole('button', { name: /Spare agent/ }).getAttribute('aria-pressed')).toBe('true');
  });
  it('details_and_used_by_show_saved_non_default_references_not_live_agent', async () => {
    const m = member(); const opt = { ...m.agentOptions[0]!, id: 'codex-gpt' }; const fake = fakeManagement({ overview: [{ ok: true, data: overviewFixture([team({ members: [member({ agentOptions: [m.agentOptions[0]!, opt, opt], runtime: { ...m.runtime!, activeAgent: 'live-only' } })] })]) }] });
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />); await view.findByRole('list', { name: 'Saved agents' }); fireEvent.click(view.getByRole('button', { name: /Codex GPT/ }));
    expect(view.getAllByText('Dev Team — dev (Developer)')).toHaveLength(1); expect(view.getAllByText('Used by 1 member in 1 team').length).toBeGreaterThan(0);
    expect(view.queryByText(/live-only/)).toBeNull();
  });
  it('catalog_problems_keep_invalid_rows_inspectable', async () => {
    const fake = fakeManagement({ agents: [{ ok: true, data: catalogFixture({ agents: [{ id: '', name: '', provider: '' }, { id: '', name: '', provider: '' }], problems: [{ path: 'agents[0]', message: 'invalid' }] }) }] });
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />); await view.findByText('agents.json has problems:'); expect(view.getAllByRole('button', { name: /Unnamed agent/ })).toHaveLength(2);
  });
  it('catalog_and_usage_errors_retry_independently', async () => {
    const error = { ok: false as const, error: { code: 'FAIL', message: 'failed', retryable: true } }; const fake = fakeManagement({ agents: [error, { ok: true, data: catalogFixture() }], overview: [error, { ok: true, data: overviewFixture([]) }] });
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />); await view.findByRole('button', { name: 'Retry catalog' }); fireEvent.click(view.getByRole('button', { name: 'Retry catalog' })); await view.findByRole('list', { name: 'Saved agents' }); expect(fake.overview).toHaveBeenCalledTimes(1); expect(view.getAllByText('Usage unavailable').length).toBeGreaterThan(0); fireEvent.click(view.getByRole('button', { name: 'Retry usage' })); await waitFor(() => expect(fake.overview).toHaveBeenCalledTimes(2)); expect(fake.agents).toHaveBeenCalledTimes(2);
  });
  it('catalog_and_overview_loading_are_independent', async () => {
    const never = new Promise<never>(() => {});
    const fake = fakeManagement({ overview: [never] });
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    await view.findByRole('list', { name: 'Saved agents' });
    expect(view.getAllByText('Loading usage…').length).toBeGreaterThan(0);
  });
  it('native_row_buttons_support_keyboard_selection', async () => {
    const fake = fakeManagement(); const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    await view.findByRole('list', { name: 'Saved agents' });
    const button = view.getByRole('button', { name: /Codex GPT/ }) as HTMLButtonElement;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.type).toBe('button'); button.focus(); expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: 'Enter', code: 'Enter' }); fireEvent.keyUp(button, { key: 'Enter', code: 'Enter' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    const other = view.getByRole('button', { name: /Spare agent/ }) as HTMLButtonElement;
    expect(other.getAttribute('aria-pressed')).toBe('false');
    other.focus(); expect(document.activeElement).toBe(other);
    fireEvent.keyDown(other, { key: ' ', code: 'Space' }); fireEvent.keyUp(other, { key: ' ', code: 'Space' });
    expect(other.getAttribute('aria-pressed')).toBe('true'); expect(button.getAttribute('aria-pressed')).toBe('false');
  });

});

describe('Agents browser edge cases', () => {
  it('renders the required browser heading, breadcrumb and search control', async () => {
    const view = render(<AgentsScreen workspace={workspace} management={fakeManagement().api} />);
    await view.findByRole('list', { name: 'Saved agents' });
    expect(view.container.querySelector('[data-section="agents"]')).toBeTruthy();
    const breadcrumb = view.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByText('Workspace')).toBeTruthy();
    expect(within(breadcrumb).getByText('Agents').getAttribute('aria-current')).toBe('page');
    expect(view.getByRole('heading', { level: 1, name: 'Agents' })).toBeTruthy();
    expect(view.getByText('Browse reusable agent configurations saved in this workspace.')).toBeTruthy();
    const search = view.getByLabelText('Search agents') as HTMLInputElement;
    expect(search.type).toBe('search');
    expect(search.placeholder).toBe('Search agents…');
  });

  it('uses a singular overflow label for one additional catalog problem', async () => {
    const problems = Array.from({ length: 6 }, (_, i) => ({ path: `path${i}`, message: `problem${i}` }));
    const fake = fakeManagement({ agents: [{ ok: true, data: catalogFixture({ problems }) }] });
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    await view.findByText('agents.json has problems:');
    expect(view.getByText('path4: problem4')).toBeTruthy();
    expect(view.queryByText('path5: problem5')).toBeNull();
    expect(view.getByText('…and 1 more problem')).toBeTruthy();
    expect(view.getByRole('list', { name: 'Saved agents' })).toBeTruthy();
  });

  it('selects rows with duplicate non-empty ids independently', async () => {
    const data = catalogFixture({ agents: [
      { id: 'duplicate', name: 'First duplicate', provider: 'p', description: 'First details' },
      { id: 'duplicate', name: 'Second duplicate', provider: 'p', description: 'Second details' },
    ], problems: [{ path: 'agents', message: 'duplicate id' }] });
    const view = render(<AgentsScreen workspace={workspace} management={fakeManagement({ agents: [{ ok: true, data }] }).api} />);
    await view.findByText('agents.json has problems:');
    const first = view.getByRole('button', { name: /First duplicate/ });
    const second = view.getByRole('button', { name: /Second duplicate/ });
    fireEvent.click(second);
    expect(first.getAttribute('aria-pressed')).toBe('false');
    expect(second.getAttribute('aria-pressed')).toBe('true');
    const details = view.getByRole('heading', { name: 'Agent details' }).closest('section')!;
    expect(within(details).getByText('Second details')).toBeTruthy();
    fireEvent.click(first);
    expect(first.getAttribute('aria-pressed')).toBe('true');
    expect(within(details).getByText('First details')).toBeTruthy();
  });

  it('shows safe fallbacks for whitespace-only catalog fields', async () => {
    const data = catalogFixture({ agents: [{ id: ' ', name: ' ', provider: ' ', model: ' ', reasoning: ' ', description: ' ' }] });
    const view = render(<AgentsScreen workspace={workspace} management={fakeManagement({ agents: [{ ok: true, data }] }).api} />);
    const row = within(await view.findByRole('list', { name: 'Saved agents' })).getByRole('button');
    for (const text of ['Unnamed agent', 'Provider unavailable', 'Model not set', 'Reasoning not set', 'Usage unavailable']) expect(row.textContent).toContain(text);
    const details = view.getByRole('heading', { name: 'Agent details' }).closest('section')!;
    for (const text of ['Unnamed agent', 'ID unavailable', 'No description', 'Provider unavailable', 'Model not set', 'Reasoning not set']) expect(details.textContent).toContain(text);
  });

  it('renders catalog values in the row and selected details without editor-only filters', async () => {
    const data = catalogFixture({ agents: [{ id: 'saved-id', name: 'Saved name', provider: 'custom', model: 'saved-model', reasoning: 'deep', description: 'Saved description' }] });
    const view = render(<AgentsScreen workspace={workspace} management={fakeManagement({ agents: [{ ok: true, data }] }).api} />);
    const list = await view.findByRole('list', { name: 'Saved agents' });
    const row = within(list).getByRole('button');
    for (const value of ['Saved name', 'custom', 'saved-model', 'deep']) expect(row.textContent).toContain(value);
    const details = view.getByRole('heading', { name: 'Agent details' }).closest('section')!;
    for (const value of ['Saved name', 'saved-id', 'Saved description', 'custom', 'saved-model', 'deep']) expect(details.textContent).toContain(value);
    expect(within(view.getByLabelText('Provider')).getAllByRole('option').map(o => o.textContent)).toEqual(['All providers', 'custom']);
    expect(within(view.getByLabelText('Reasoning')).getAllByRole('option').map(o => o.textContent)).toEqual(['All reasoning', 'deep']);
  });

  it('resets filters and selection when switching between populated workspaces', async () => {
    const data = catalogFixture({ agents: [
      { id: 'first', name: 'First', provider: 'p', reasoning: 'high' },
      { id: 'second', name: 'Second', provider: 'p', reasoning: 'high' },
    ] });
    const fake = fakeManagement({ agents: [{ ok: true, data }] });
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    await view.findByRole('list', { name: 'Saved agents' });
    fireEvent.click(view.getByRole('button', { name: /Second/ }));
    fireEvent.change(view.getByLabelText('Provider'), { target: { value: 'p' } });
    fireEvent.change(view.getByLabelText('Reasoning'), { target: { value: 'high' } });
    fireEvent.change(view.getByLabelText('Search agents'), { target: { value: 'Second' } });
    view.rerender(<AgentsScreen workspace={{ ...workspace, id: 'b' }} management={fake.api} />);
    await waitFor(() => expect(fake.agents).toHaveBeenCalledWith('b'));
    await view.findByRole('button', { name: /First/ });
    expect((view.getByLabelText('Provider') as HTMLSelectElement).value).toBe('');
    expect((view.getByLabelText('Reasoning') as HTMLSelectElement).value).toBe('');
    expect((view.getByLabelText('Search agents') as HTMLInputElement).value).toBe('');
    expect(view.getByRole('button', { name: /First/ }).getAttribute('aria-pressed')).toBe('true');
    expect(view.getByRole('button', { name: /Second/ }).getAttribute('aria-pressed')).toBe('false');
  });

  it('shows lower bound usage and missing reference labels in details', async () => {
    const data = overviewFixture([team({ id: null, name: ' ', membersTruncated: true, members: [member({ memberId: null, name: ' ', role: ' ' })] })]);
    const fake = fakeManagement({ overview: [{ ok: true, data }] });
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    await view.findByText('Unnamed team — Unnamed member');
    const details = view.getByRole('heading', { name: 'Agent details' }).closest('section')!;
    expect(within(details).getByText('Used by at least 1 member in at least 1 team')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: /Codex GPT/ }));
    expect(within(details).getByText('Usage incomplete — no saved references are visible in the loaded teams.')).toBeTruthy();
  });

  it('shows error details and allows usage to finish while catalog is loading', async () => {
    const never = new Promise<never>(() => {});
    const fake = fakeManagement({ agents: [never], overview: [{ ok: false, error: { code: 'USAGE_FAIL', message: 'usage failed', remediation: 'Check teams.', retryable: true } }] });
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    await view.findByText('Check teams.');
    expect(view.getByRole('alert').textContent).toContain('USAGE_FAIL: usage failed');
    expect(view.getByText('Loading agent catalog…')).toBeTruthy();
    expect(view.queryByRole('list', { name: 'Saved agents' })).toBeNull();
    expect(fake.agents).toHaveBeenCalledTimes(1);
    expect(fake.overview).toHaveBeenCalledTimes(1);
  });

  it('shows catalog error code, message and remediation', async () => {
    const fake = fakeManagement({ agents: [{ ok: false, error: { code: 'CATALOG_FAIL', message: 'catalog failed', remediation: 'Check agents.json.', retryable: true } }] });
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    await view.findByRole('button', { name: 'Retry catalog' });
    expect(view.getByRole('alert').textContent).toContain('CATALOG_FAIL: catalog failed');
    expect(view.getByText('Check agents.json.')).toBeTruthy();
    expect(view.queryByRole('list', { name: 'Saved agents' })).toBeNull();
  });
  it('shows saved details and the live-controls note without mutation controls', async () => {
    const fake = fakeManagement();
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    await view.findByRole('list', { name: 'Saved agents' });
    const details = view.getByRole('heading', { name: 'Agent details' }).closest('section')!;
    expect(within(details).getByRole('heading', { name: 'Used by' })).toBeTruthy();
    expect(within(details).getByText('Saved configuration only. Changes do not switch a running team member; live agent controls remain in Teams.')).toBeTruthy();
    expect(view.queryByRole('button', { name: /^(new agent|edit|duplicate|delete|save|activate|resume|switch|cancel)$/i })).toBeNull();
  });

  it('retains a selected row when a filter leaves it visible', async () => {
    const fake = fakeManagement();
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    await view.findByRole('list', { name: 'Saved agents' });
    const selected = view.getByRole('button', { name: /Codex GPT/ });
    fireEvent.click(selected);
    fireEvent.change(view.getByLabelText('Search agents'), { target: { value: 'codex' } });
    expect(view.getByRole('button', { name: /Codex GPT/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('combines real catalog filter values in order and clears them without commands', async () => {
    const data = catalogFixture({ agents: [
      { id: 'one', name: 'Alpha', provider: 'p', reasoning: 'high' },
      { id: 'two', name: 'Beta', provider: 'p', reasoning: 'low' },
      { id: 'three', name: 'Gamma', provider: 'p', reasoning: 'high' },
      { id: 'four', name: 'Blank', provider: ' ', reasoning: ' ' },
    ] });
    const fake = fakeManagement({ agents: [{ ok: true, data }] });
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    const list = await view.findByRole('list', { name: 'Saved agents' });
    expect(within(view.getByLabelText('Provider')).getAllByRole('option').map(o => o.textContent)).toEqual(['All providers', 'p']);
    expect(within(view.getByLabelText('Reasoning')).getAllByRole('option').map(o => o.textContent)).toEqual(['All reasoning', 'high', 'low']);
    fireEvent.change(view.getByLabelText('Provider'), { target: { value: 'p' } });
    fireEvent.change(view.getByLabelText('Reasoning'), { target: { value: 'high' } });
    expect(within(list).getAllByRole('button').map(b => b.textContent)).toEqual([expect.stringContaining('Alpha'), expect.stringContaining('Gamma')]);
    fireEvent.change(view.getByLabelText('Search agents'), { target: { value: 'no match' } });
    expect(view.getByText('No agents match the current search and filters.')).toBeTruthy();
    expect(view.queryByRole('heading', { name: 'Agent details' })).toBeNull();
    fireEvent.change(view.getByLabelText('Search agents'), { target: { value: '' } });
    fireEvent.change(view.getByLabelText('Provider'), { target: { value: '' } });
    fireEvent.change(view.getByLabelText('Reasoning'), { target: { value: '' } });
    expect(within(view.getByRole('list', { name: 'Saved agents' })).getAllByRole('button')).toHaveLength(4);
    expect(fake.agents).toHaveBeenCalledTimes(1); expect(fake.overview).toHaveBeenCalledTimes(1);
  });

  it('selects duplicate invalid ids separately and limits displayed problems', async () => {
    const problems = Array.from({ length: 7 }, (_, i) => ({ path: `path${i}`, message: `problem${i}` }));
    const fake = fakeManagement({ agents: [{ ok: true, data: catalogFixture({ agents: [{ id: '', name: 'First', provider: '' }, { id: '', name: 'Second', provider: '' }], problems }) }] });
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    await view.findByText('agents.json has problems:');
    expect(view.getByText('path4: problem4')).toBeTruthy(); expect(view.queryByText('path5: problem5')).toBeNull();
    expect(view.getByText('…and 2 more problems')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: /Second/ }));
    const details = view.getByRole('heading', { name: 'Agent details' }).closest('section')!;
    expect(within(details).getByText('Second')).toBeTruthy();
    expect(within(details).getByText('ID unavailable')).toBeTruthy();
    expect(within(details).getByText('No description')).toBeTruthy();
    expect(within(details).getByText('Usage unavailable')).toBeTruthy();
  });

  it('shows an empty catalog and resets browser state on workspace change', async () => {
    const fake = fakeManagement({ agents: [{ ok: true, data: catalogFixture() }, { ok: true, data: catalogFixture({ agents: [] }) }] });
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    await view.findByRole('list', { name: 'Saved agents' });
    fireEvent.change(view.getByLabelText('Search agents'), { target: { value: 'Codex' } });
    view.rerender(<AgentsScreen workspace={{ ...workspace, id: 'b' }} management={fake.api} />);
    await view.findByText('No reusable agents are defined in this workspace.');
    expect((view.getByLabelText('Search agents') as HTMLInputElement).value).toBe('');
    expect(view.queryByRole('heading', { name: 'Agent details' })).toBeNull();
    expect(fake.agents).toHaveBeenCalledWith('b'); expect(fake.overview).toHaveBeenCalledWith('b');
  });
});
