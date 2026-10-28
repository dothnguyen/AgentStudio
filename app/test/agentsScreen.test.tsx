// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentsScreen } from '../src/renderer/agents/AgentsScreen';
import { AgentForm } from '../src/renderer/agents/AgentForm';
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
  it('shows saved details and the live-controls note with saved agent actions', async () => {
    const fake = fakeManagement();
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    await view.findByRole('list', { name: 'Saved agents' });
    const details = view.getByRole('heading', { name: 'Agent details' }).closest('section')!;
    expect(within(details).getByRole('heading', { name: 'Used by' })).toBeTruthy();
    expect(within(details).getByText('Saved configuration only. Changes do not switch a running team member; live agent controls remain in Teams.')).toBeTruthy();
    expect(view.queryByRole('button', { name: /^(delete|save|activate|resume|switch|cancel)$/i })).toBeNull();
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

describe('saved agent forms', () => {
  it('selects the saved agent when a failed refresh is retried successfully', async () => {
    const agent = { id: 'new', name: 'New', provider: 'codex' };
    const create = vi.fn(async () => ({ ok: true as const, data: { workspace: 'a', agent } }));
    const fake = fakeManagement({ calls: { createAgent: create }, agents: [
      { ok: true, data: catalogFixture() },
      { ok: false, error: { code: 'FAIL', message: 'Refresh failed', retryable: true } },
      { ok: true, data: catalogFixture({ agents: [...catalogFixture().agents, agent] }) },
    ] });
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    await view.findByRole('button', { name: 'New agent' });
    fireEvent.click(view.getByRole('button', { name: 'New agent' }));
    const form = view.container.querySelector('form')!;
    fireEvent.change(within(form).getByLabelText('Agent id'), { target: { value: 'new' } });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'New' } });
    fireEvent.submit(form);
    fireEvent.click(await view.findByRole('button', { name: 'Retry catalog' }));
    await waitFor(() => expect(view.getByRole('button', { name: /^New codex/ }).getAttribute('aria-pressed')).toBe('true'));
  });
  it('creates an agent with the exact six-field request and selects the refreshed result', async () => {
    const agent = { id: 'new-agent', name: 'New Agent', provider: 'codex', model: 'custom', reasoning: 'high', description: 'Description' };
    const create = vi.fn(async () => ({ ok: true as const, data: { workspace: 'a', agent } }));
    const fake = fakeManagement({ calls: { createAgent: create }, agents: [{ ok: true, data: catalogFixture() }, { ok: true, data: catalogFixture({ agents: [...catalogFixture().agents, agent] }) }] });
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />); await view.findByRole('list', { name: 'Saved agents' }); fireEvent.click(view.getByRole('button', { name: 'New agent' }));
    const form = view.container.querySelector('form')!; for (const [label, value] of Object.entries({ 'Agent id': agent.id, Name: agent.name, Model: agent.model, Reasoning: agent.reasoning, Description: agent.description })) fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create agent' })); await waitFor(() => expect(create).toHaveBeenCalledWith('a', agent));
    await waitFor(() => expect(view.getByRole('button', { name: /New Agent/ }).getAttribute('aria-pressed')).toBe('true'));
    expect(view.getByRole('status').textContent).toContain('Created saved agent "New Agent" (new-agent). Saved configuration applies on the next team start; running agents are unchanged. Live switching remains in Teams.');
  });
  it('does not derive or write a create id', async () => { const fake = fakeManagement(); const view = render(<AgentsScreen workspace={workspace} management={fake.api} />); await view.findByRole('list', { name: 'Saved agents' }); fireEvent.click(view.getByRole('button', { name: 'New agent' })); const form = view.container.querySelector('form')!; fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Name' } }); fireEvent.submit(form); expect(view.getByText('Enter an agent id.')).toBeTruthy(); expect(fake.api.createAgent).not.toHaveBeenCalled(); });
  it('edits with a readable immutable id and exact sparse changes', async () => { const agent = { id: 'one', name: 'One', provider: 'codex', model: 'gpt-6', reasoning: 'high', description: 'desc' }; const update = vi.fn(async () => ({ ok: false as const, error: { code: 'FAIL', message: 'failed', retryable: false } })); const fake = fakeManagement({ calls: { updateAgent: update }, agents: [{ ok: true, data: catalogFixture({ agents: [agent] }) }] }); const view = render(<AgentsScreen workspace={workspace} management={fake.api} />); await view.findByRole('button', { name: 'Edit' }); fireEvent.click(view.getByRole('button', { name: 'Edit' })); const form = view.container.querySelector('form')!; expect((within(form).getByLabelText('Agent id') as HTMLInputElement).readOnly).toBe(true); for (const [label, value] of Object.entries({ Name: 'New', Model: '', Reasoning: '', Description: '' })) fireEvent.change(within(form).getByLabelText(label), { target: { value } }); fireEvent.submit(form); await waitFor(() => expect(update).toHaveBeenCalledWith('a', 'one', { name: 'New', model: null, reasoning: null, description: null })); });
  it('does not submit an unchanged edit', async () => { const fake = fakeManagement(); const view = render(<AgentsScreen workspace={workspace} management={fake.api} />); await view.findByRole('button', { name: 'Edit' }); fireEvent.click(view.getByRole('button', { name: 'Edit' })); fireEvent.submit(view.container.querySelector('form')!); expect(view.getByText('No changes to save.')).toBeTruthy(); expect(fake.api.updateAgent).not.toHaveBeenCalled(); });
  it('prefills a duplicate without writing until submit', async () => { const create = vi.fn(async () => ({ ok: true as const, data: { workspace: 'a', agent: { id: 'opencode-sonnet-copy', name: 'OpenCode Sonnet copy', provider: 'opencode', model: 'claude-sonnet', description: 'Implements tickets.' } } })); const fake = fakeManagement({ calls: { createAgent: create } }); const view = render(<AgentsScreen workspace={workspace} management={fake.api} />); await view.findByRole('button', { name: 'Duplicate' }); fireEvent.click(view.getByRole('button', { name: 'Duplicate' })); const form = view.container.querySelector('form')!; expect((within(form).getByLabelText('Agent id') as HTMLInputElement).value).toBe('opencode-sonnet-copy'); expect(create).not.toHaveBeenCalled(); fireEvent.submit(form); await waitFor(() => expect(create).toHaveBeenCalledWith('a', { id: 'opencode-sonnet-copy', name: 'OpenCode Sonnet copy', provider: 'opencode', model: 'claude-sonnet', description: 'Implements tickets.' })); expect(view.getByRole('status').textContent).toContain('Created saved duplicate'); });
  it('blocks every mutation when the catalog has problems', async () => { const fake = fakeManagement({ agents: [{ ok: true, data: catalogFixture({ problems: [{ path: 'agents', message: 'bad' }] }) }] }); const view = render(<AgentsScreen workspace={workspace} management={fake.api} />); await view.findByRole('button', { name: 'Edit' }); for (const name of ['New agent', 'Edit', 'Duplicate']) expect((view.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true); expect(view.getByText('Saved agent changes are unavailable because agents.json has validation problems. Repair it on disk and refresh.')).toBeTruthy(); });
  it('preserves draft and announces AGENT_EXISTS', async () => { const create = vi.fn(async () => ({ ok: false as const, error: { code: 'AGENT_EXISTS', message: 'Already exists.', retryable: false, remediation: 'Choose another.' } })); const fake = fakeManagement({ calls: { createAgent: create } }); const view = render(<AgentsScreen workspace={workspace} management={fake.api} />); await view.findByRole('list', { name: 'Saved agents' }); fireEvent.click(view.getByRole('button', { name: 'New agent' })); const form = view.container.querySelector('form')!; fireEvent.change(within(form).getByLabelText('Agent id'), { target: { value: 'new' } }); fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Draft' } }); fireEvent.submit(form); await waitFor(() => expect(view.getByRole('alert').textContent).toContain('AGENT_EXISTS: Already exists.')); expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('Draft'); expect(view.getByText('Choose another.')).toBeTruthy(); expect(fake.agents).toHaveBeenCalledTimes(1); });
});

describe('saved agent form safeguards', () => {
  it('prevents duplicate submission while pending', async () => { let resolve!: (value: never) => void; const create = vi.fn(() => new Promise<never>(r => { resolve = r; })); const fake = fakeManagement({ calls: { createAgent: create } }); const view = render(<AgentsScreen workspace={workspace} management={fake.api} />); await view.findByRole('list', { name: 'Saved agents' }); fireEvent.click(view.getByRole('button', { name: 'New agent' })); const form = view.container.querySelector('form')!; fireEvent.change(within(form).getByLabelText('Agent id'), { target: { value: 'new' } }); fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'New' } }); fireEvent.submit(form); fireEvent.submit(form); expect(create).toHaveBeenCalledTimes(1); expect((within(form).getByRole('button', { name: 'Saving…' }) as HTMLButtonElement).disabled).toBe(true); void resolve; });
  it('cancel and Escape discard the draft and restore focus to the invoking action', async () => { const view = render(<AgentsScreen workspace={workspace} management={fakeManagement().api} />); const edit = await view.findByRole('button', { name: 'Edit' }); edit.focus(); fireEvent.click(edit); const form = view.container.querySelector('form')!; fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Draft' } }); fireEvent.keyDown(form, { key: 'Escape' }); await waitFor(() => expect(document.activeElement).toBe(view.getByRole('button', { name: 'Edit' }))); fireEvent.click(view.getByRole('button', { name: 'Edit' })); expect((within(view.container.querySelector('form')!).getByLabelText('Name') as HTMLInputElement).value).toBe('OpenCode Sonnet'); });
  it('blocks submit for missing or unknown provider metadata', async () => { const fake = fakeManagement({ agents: [{ ok: true, data: catalogFixture({ editorOptions: { providers: [] } }) }] }); const view = render(<AgentsScreen workspace={workspace} management={fake.api} />); await view.findByRole('button', { name: 'Edit' }); fireEvent.click(view.getByRole('button', { name: 'Edit' })); fireEvent.submit(view.container.querySelector('form')!); expect(view.getByText('Choose a provider supplied by the backend.')).toBeTruthy(); expect(fake.api.updateAgent).not.toHaveBeenCalled(); });
  it('preserves draft and maps AGENT_CATALOG_INVALID problems', async () => { const update = vi.fn(async () => ({ ok: false as const, error: { code: 'AGENT_CATALOG_INVALID', message: 'Invalid catalog', retryable: false, data: { problems: [{ path: 'changes.name', message: 'Bad name' }, { path: 'catalog', message: 'Broken' }] } } })); const fake = fakeManagement({ calls: { updateAgent: update } }); const view = render(<AgentsScreen workspace={workspace} management={fake.api} />); await view.findByRole('button', { name: 'Edit' }); fireEvent.click(view.getByRole('button', { name: 'Edit' })); const form = view.container.querySelector('form')!; fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Draft' } }); fireEvent.submit(form); await view.findByText('Bad name'); expect(within(form).getByText('catalog: Broken')).toBeTruthy(); expect(within(form).getByLabelText('Name').getAttribute('aria-invalid')).toBe('true'); expect(fake.agents).toHaveBeenCalledTimes(1); });
  it('reports a completed save even when the catalog refresh fails', async () => { const agent = { id: 'new', name: 'New', provider: 'codex' }; const create = vi.fn(async () => ({ ok: true as const, data: { workspace: 'a', agent } })); const fake = fakeManagement({ calls: { createAgent: create }, agents: [{ ok: true, data: catalogFixture() }, { ok: false, error: { code: 'FAIL', message: 'Refresh failed', retryable: true } }] }); const view = render(<AgentsScreen workspace={workspace} management={fake.api} />); await view.findByRole('list', { name: 'Saved agents' }); fireEvent.click(view.getByRole('button', { name: 'New agent' })); const form = view.container.querySelector('form')!; fireEvent.change(within(form).getByLabelText('Agent id'), { target: { value: 'new' } }); fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'New' } }); fireEvent.submit(form); await view.findByText(/Refresh failed/); expect(view.getByRole('status').textContent).toContain('Created saved agent "New" (new)'); });
});

describe('provider and failure behavior', () => {
  it('uses backend provider reasoning and configured model metadata', async () => { const data = catalogFixture({ editorOptions: { providers: [{ id: 'p', modelSelectable: true, reasoningLevels: ['high'], configuredModels: ['suggested'] }, { id: 'q', modelSelectable: false, reasoningLevels: [], configuredModels: [] }] } }); const view = render(<AgentsScreen workspace={workspace} management={fakeManagement({ agents: [{ ok: true, data }] }).api} />); await view.findByRole('button', { name: 'New agent' }); fireEvent.click(view.getByRole('button', { name: 'New agent' })); const form = view.container.querySelector('form')!; const provider = within(form).getByLabelText('Provider') as HTMLSelectElement; expect([...provider.options].map(o => o.value)).toEqual(['p', 'q']); expect([...((within(form).getByLabelText('Reasoning') as HTMLSelectElement).options)].map(o => o.value)).toEqual(['', 'high']); expect(form.querySelector('datalist option')?.getAttribute('value')).toBe('suggested'); fireEvent.change(within(form).getByLabelText('Model'), { target: { value: 'custom' } }); fireEvent.change(within(form).getByLabelText('Reasoning'), { target: { value: 'high' } }); fireEvent.change(provider, { target: { value: 'q' } }); expect((within(form).getByLabelText('Model') as HTMLInputElement).value).toBe(''); expect((within(form).getByLabelText('Model') as HTMLInputElement).disabled).toBe(true); expect((within(form).getByLabelText('Reasoning') as HTMLSelectElement).value).toBe(''); expect((within(form).getByLabelText('Reasoning') as HTMLSelectElement).disabled).toBe(true); });
  it('preserves draft for SETTING_UNSUPPORTED and rejected calls', async () => { for (const failure of [{ ok: false as const, error: { code: 'SETTING_UNSUPPORTED', message: 'Unsupported', retryable: false } }, new Error('Rejected')]) { const create = vi.fn(() => failure instanceof Error ? Promise.reject(failure) : Promise.resolve(failure)); const fake = fakeManagement({ calls: { createAgent: create } }); const view = render(<AgentsScreen workspace={workspace} management={fake.api} />); await view.findByRole('button', { name: 'New agent' }); fireEvent.click(view.getByRole('button', { name: 'New agent' })); const form = view.container.querySelector('form')!; fireEvent.change(within(form).getByLabelText('Agent id'), { target: { value: 'new' } }); fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Draft' } }); fireEvent.submit(form); await waitFor(() => expect(view.getByRole('alert').textContent).toContain(failure instanceof Error ? 'INTERNAL: Rejected' : 'SETTING_UNSUPPORTED: Unsupported')); expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('Draft'); expect(fake.agents).toHaveBeenCalledTimes(1); view.unmount(); } });
});

describe('additional form safeguards', () => {
  it('rejects invalid and duplicate ids, blank names, and over-limit descriptions without writing', async () => {
    const fake = fakeManagement();
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    await view.findByRole('button', { name: 'New agent' });
    fireEvent.click(view.getByRole('button', { name: 'New agent' }));
    const form = view.container.querySelector('form')!;
    const id = within(form).getByLabelText('Agent id');
    const name = within(form).getByLabelText('Name');
    const description = within(form).getByLabelText('Description') as HTMLTextAreaElement;
    fireEvent.change(id, { target: { value: 'BAD' } });
    fireEvent.change(description, { target: { value: 'x'.repeat(4001) } });
    fireEvent.submit(form);
    expect(within(form).getByText(/Use 1–64 lowercase/)).toBeTruthy();
    expect(within(form).getByText('Enter an agent name.')).toBeTruthy();
    expect(within(form).getByText('Use 4000 characters or fewer.')).toBeTruthy();
    expect(description.value).toHaveLength(4001);
    expect(description.getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.change(id, { target: { value: 'opencode-sonnet' } });
    fireEvent.submit(form);
    expect(within(form).getByText('That agent id already exists.')).toBeTruthy();
    expect(fake.api.createAgent).not.toHaveBeenCalled();
  });
  it('retains supported values across provider changes and submits a free-form model', async () => {
    const create = vi.fn(async () => ({ ok: false as const, error: { code: 'FAIL', message: 'failed', retryable: false } }));
    const data = catalogFixture({ editorOptions: { providers: [
      { id: 'p', modelSelectable: true, reasoningLevels: ['high', 'low'], configuredModels: ['p-model'] },
      { id: 'q', modelSelectable: true, reasoningLevels: ['high'], configuredModels: ['q-model'] },
    ] } });
    const view = render(<AgentsScreen workspace={workspace} management={fakeManagement({ calls: { createAgent: create }, agents: [{ ok: true, data }] }).api} />);
    await view.findByRole('button', { name: 'New agent' }); fireEvent.click(view.getByRole('button', { name: 'New agent' }));
    const form = view.container.querySelector('form')!;
    for (const [label, value] of Object.entries({ 'Agent id': 'new', Name: 'New', Model: 'custom/model', Reasoning: 'high', Provider: 'q' })) fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    expect((within(form).getByLabelText('Model') as HTMLInputElement).value).toBe('custom/model');
    expect((within(form).getByLabelText('Reasoning') as HTMLSelectElement).value).toBe('high');
    expect([...form.querySelectorAll('datalist option')].map(o => o.value)).toEqual(['q-model']);
    fireEvent.submit(form);
    await waitFor(() => expect(create).toHaveBeenCalledWith('a', { id: 'new', name: 'New', provider: 'q', model: 'custom/model', reasoning: 'high' }));
  });
  it('restores focus after Cancel and initializes a fresh duplicate draft', async () => {
    const view = render(<AgentsScreen workspace={workspace} management={fakeManagement().api} />);
    const duplicate = await view.findByRole('button', { name: 'Duplicate' }); duplicate.focus(); fireEvent.click(duplicate);
    let form = view.container.querySelector('form')!;
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Draft' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(view.getByRole('button', { name: 'Duplicate' })));
    fireEvent.click(view.getByRole('button', { name: 'Duplicate' })); form = view.container.querySelector('form')!;
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('OpenCode Sonnet copy');
  });
  it('ignores a pending save result after changing workspaces', async () => {
    let resolve!: (result: { ok: true; data: { workspace: string; agent: { id: string; name: string; provider: string } } }) => void;
    const create = vi.fn(() => new Promise<{ ok: true; data: { workspace: string; agent: { id: string; name: string; provider: string } } }>(r => { resolve = r; }));
    const fake = fakeManagement({ calls: { createAgent: create } });
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    await view.findByRole('button', { name: 'New agent' }); fireEvent.click(view.getByRole('button', { name: 'New agent' }));
    const form = view.container.querySelector('form')!;
    fireEvent.change(within(form).getByLabelText('Agent id'), { target: { value: 'new' } }); fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'New' } }); fireEvent.submit(form);
    fireEvent.keyDown(form, { key: 'Escape' }); expect(view.container.querySelector('form')).toBe(form);
    view.rerender(<AgentsScreen workspace={{ ...workspace, id: 'b' }} management={fake.api} />);
    await waitFor(() => expect(fake.agents).toHaveBeenCalledWith('b'));
    resolve({ ok: true, data: { workspace: 'a', agent: { id: 'new', name: 'New', provider: 'codex' } } });
    await waitFor(() => expect(view.queryByText(/Created saved agent/)).toBeNull());
    expect(fake.agents).toHaveBeenCalledTimes(2);
  });
});


describe('form metadata updates', () => {
  it('preserves the screen draft through a refresh that finds catalog problems', async () => {
    const fake = fakeManagement();
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    await view.findByRole('button', { name: 'New agent' });
    fireEvent.click(view.getByRole('button', { name: 'New agent' }));
    const form = view.container.querySelector('form')!;
    fireEvent.change(within(form).getByLabelText('Agent id'), { target: { value: 'draft' } });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Draft name' } });
    let resolve!: (result: { ok: true; data: ReturnType<typeof catalogFixture> }) => void;
    const agents = vi.fn(() => new Promise<{ ok: true; data: ReturnType<typeof catalogFixture> }>(r => { resolve = r; }));
    view.rerender(<AgentsScreen workspace={workspace} management={{ ...fake.api, agents }} />);
    await waitFor(() => expect(agents).toHaveBeenCalled());
    expect(view.container.querySelector('form')).toBe(form);
    expect((within(form).getByRole('button', { name: 'Create agent' }) as HTMLButtonElement).disabled).toBe(true);
    resolve({ ok: true, data: catalogFixture({ problems: [{ path: 'agents', message: 'invalid' }] }) });
    await view.findByText('agents.json has problems:');
    expect(view.container.querySelector('form')).toBe(form);
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('Draft name');
    expect((within(form).getByLabelText('Agent id') as HTMLInputElement).value).toBe('draft');
    expect(within(form).getByText('Saved agent changes are unavailable because agents.json has validation problems. Repair it on disk and refresh.')).toBeTruthy();
    expect((within(form).getByRole('button', { name: 'Create agent' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(form);
    expect(fake.api.createAgent).not.toHaveBeenCalled();
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(view.container.querySelector('form')).toBeNull();
  });
  it('keeps an open draft inspectable but blocks submission when catalog problems arrive', () => {
    const submit = vi.fn(); const cancel = vi.fn();
    const props = { mode: 'create' as const, source: null, existingIds: [], providers: [{ id: 'p', modelSelectable: true, reasoningLevels: [], configuredModels: [] }], pending: false, serverError: null, mutationsBlockedReason: null, onSubmit: submit, onCancel: cancel };
    const view = render(<AgentForm {...props} />);
    fireEvent.change(view.getByLabelText('Agent id'), { target: { value: 'new' } });
    fireEvent.change(view.getByLabelText('Name'), { target: { value: 'Draft' } });
    const reason = 'Saved agent changes are unavailable because agents.json has validation problems. Repair it on disk and refresh.';
    view.rerender(<AgentForm {...props} mutationsBlockedReason={reason} />);
    expect((view.getByLabelText('Name') as HTMLInputElement).value).toBe('Draft');
    expect(view.getByText(reason)).toBeTruthy();
    expect((view.getByRole('button', { name: 'Create agent' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(view.container.querySelector('form')!); expect(submit).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Cancel' })); expect(cancel).toHaveBeenCalledOnce();
  });
  it('shows an unknown saved provider as disabled and requires a backend choice', () => {
    const submit = vi.fn();
    const view = render(<AgentForm mode="edit" source={{ id: 'a', name: 'A', provider: 'unknown' }} existingIds={['a']} providers={[{ id: 'p', modelSelectable: true, reasoningLevels: [], configuredModels: [] }]} pending={false} serverError={null} mutationsBlockedReason={null} onSubmit={submit} onCancel={() => {}} />);
    const provider = view.getByLabelText('Provider') as HTMLSelectElement;
    expect([...provider.options].map(o => [o.textContent, o.disabled])).toEqual([['Unknown provider: unknown', true], ['p', false]]);
    fireEvent.submit(view.container.querySelector('form')!);
    expect(view.getByText('Choose a provider supplied by the backend.')).toBeTruthy(); expect(submit).not.toHaveBeenCalled();
    fireEvent.change(provider, { target: { value: 'p' } }); fireEvent.submit(view.container.querySelector('form')!);
    expect(submit).toHaveBeenCalledWith({ kind: 'update', agentId: 'a', changes: { provider: 'p' } });
  });
});

describe('saved agent workflow coverage', () => {
  it('duplicates all settings with the first available id and reports the saved duplicate', async () => {
    const source = { id: 'one', name: 'One', provider: 'codex', model: 'gpt-6', reasoning: 'high', description: 'A description' };
    const copy = { ...source, id: 'one-copy-3', name: 'One copy' };
    const data = catalogFixture({ agents: [source, { ...source, id: 'one-copy' }, { ...source, id: 'one-copy-2' }] });
    const create = vi.fn(async () => ({ ok: true as const, data: { workspace: 'a', agent: copy } }));
    const fake = fakeManagement({ calls: { createAgent: create }, agents: [{ ok: true, data }, { ok: true, data: catalogFixture({ agents: [...data.agents, copy] }) }] });
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    fireEvent.click(await view.findByRole('button', { name: 'Duplicate' }));
    const form = view.container.querySelector('form')!;
    for (const [label, value] of Object.entries({ 'Agent id': copy.id, Name: copy.name, Provider: copy.provider, Model: copy.model, Reasoning: copy.reasoning, Description: copy.description })) {
      expect((within(form).getByLabelText(label) as HTMLInputElement).value).toBe(value);
    }
    expect(create).not.toHaveBeenCalled();
    fireEvent.submit(form);
    await waitFor(() => expect(create).toHaveBeenCalledExactlyOnceWith('a', copy));
    await waitFor(() => expect(view.getByRole('button', { name: /One copy/ }).getAttribute('aria-pressed')).toBe('true'));
    expect(view.getByRole('status').textContent).toContain('Created saved duplicate "One copy" (one-copy-3). Saved configuration applies on the next team start; running agents are unchanged. Live switching remains in Teams.');
  });

  it('reports an edit success and selects the returned agent after refresh', async () => {
    const original = { id: 'one', name: 'One', provider: 'codex' };
    const saved = { ...original, name: 'Renamed' };
    const update = vi.fn(async () => ({ ok: true as const, data: { workspace: 'a', agent: saved } }));
    const fake = fakeManagement({ calls: { updateAgent: update }, agents: [{ ok: true, data: catalogFixture({ agents: [original] }) }, { ok: true, data: catalogFixture({ agents: [saved] }) }] });
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    fireEvent.click(await view.findByRole('button', { name: 'Edit' }));
    const form = view.container.querySelector('form')!;
    const id = within(form).getByLabelText('Agent id') as HTMLInputElement;
    expect(id.readOnly).toBe(true); expect(id.disabled).toBe(false);
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.submit(form);
    await waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith('a', 'one', { name: 'Renamed' }));
    await waitFor(() => expect(view.getByRole('button', { name: /Renamed/ }).getAttribute('aria-pressed')).toBe('true'));
    expect(view.getByRole('status').textContent).toContain('Saved agent "Renamed" (one). Saved configuration applies on the next team start; running agents are unchanged. Live switching remains in Teams.');
  });

  it('blocks creation when provider metadata is empty', async () => {
    const fake = fakeManagement({ agents: [{ ok: true, data: catalogFixture({ editorOptions: { providers: [] } }) }] });
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    fireEvent.click(await view.findByRole('button', { name: 'New agent' }));
    const form = view.container.querySelector('form')!;
    fireEvent.change(within(form).getByLabelText('Agent id'), { target: { value: 'new' } });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'New' } });
    fireEvent.submit(form);
    const provider = within(form).getByLabelText('Provider');
    expect(provider.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(provider.getAttribute('aria-describedby')!)?.textContent).toBe('Choose a provider.');
    expect(fake.api.createAgent).not.toHaveBeenCalled();
  });

  it('keeps the pending form open through Escape and Cancel until the result arrives', async () => {
    let resolve!: (result: { ok: false; error: { code: string; message: string; retryable: boolean } }) => void;
    const create = vi.fn(() => new Promise<{ ok: false; error: { code: string; message: string; retryable: boolean } }>(r => { resolve = r; }));
    const fake = fakeManagement({ calls: { createAgent: create } });
    const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
    fireEvent.click(await view.findByRole('button', { name: 'New agent' }));
    const form = view.container.querySelector('form')!;
    fireEvent.change(within(form).getByLabelText('Agent id'), { target: { value: 'new' } });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Draft' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create agent' }));
    fireEvent.keyDown(form, { key: 'Escape' });
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    fireEvent.submit(form);
    expect(create).toHaveBeenCalledTimes(1); expect(view.container.querySelector('form')).toBe(form);
    resolve({ ok: false, error: { code: 'FAIL', message: 'Failed', retryable: false } });
    await view.findByText(/FAIL/);
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('Draft');
  });
});
