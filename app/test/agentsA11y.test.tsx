// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { AgentsScreen } from '../src/renderer/agents/AgentsScreen';
import { catalogFixture, fakeManagement, overviewFixture } from './teamsFixtures';
import type { Workspace } from '../src/renderer/api';

const workspace: Workspace = { id: 'a', name: 'A', path: '/a', exists: true, missing: false };
afterEach(cleanup);

it('cancel_delete_while_disconnected_restores_its_opener_after_reconnect', async () => {
  const connection = (state: 'connected' | 'lost') => ({ state, error: null, distro: null, command: null });
  const fake = fakeManagement({ overview: [{ ok: true, data: overviewFixture([]) }] });
  const view = render(<AgentsScreen workspace={workspace} management={fake.api} connection={connection('connected')} />);
  const opener = await view.findByRole('button', { name: 'Delete' });
  await waitFor(() => expect((opener as HTMLButtonElement).disabled).toBe(false));
  opener.focus();
  await userEvent.keyboard('{Enter}');
  view.rerender(<AgentsScreen workspace={workspace} management={fake.api} connection={connection('lost')} />);
  await userEvent.keyboard('{Escape}');
  expect(view.queryByRole('dialog')).toBeNull();
  view.rerender(<AgentsScreen workspace={workspace} management={fake.api} connection={connection('connected')} />);
  await waitFor(() => expect(document.activeElement).toBe(view.getByRole('button', { name: 'Delete' })));
  expect(fake.api.deleteAgent).not.toHaveBeenCalled();
});

it('catalog_rows_and_controls_are_native_and_named', async () => {
  const view = render(<main><AgentsScreen workspace={workspace} management={fakeManagement().api} /></main>);
  const list = await view.findByRole('list', { name: 'Saved agents' });
  expect(view.getAllByRole('main')).toHaveLength(1); expect(view.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(view.getByRole('navigation', { name: 'Breadcrumb' })).toBeTruthy();
  const headings = view.getAllByRole('heading', { level: 2 }).map(h => h.textContent);
  expect(headings.findIndex(h => /catalog/i.test(h ?? ''))).toBeLessThan(headings.findIndex(h => /details/i.test(h ?? '')));
  for (const label of ['Search agents', 'Provider', 'Reasoning']) expect(view.getByLabelText(label).closest('label')).toBeTruthy();
  const rows = within(list).getAllByRole('button'); expect(rows.every(b => b.tagName === 'BUTTON')).toBe(true);
  expect(rows.filter(b => b.getAttribute('aria-current') === 'true')).toHaveLength(1);
  expect(view.container.querySelector('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])')).toBeNull();
});

it.each([['New agent', 'Name'], ['Edit', 'Name'], ['Duplicate', 'Agent id'], ['Delete', 'Cancel']])('keyboard_flow_opens_and_closes_%s_dialog', async (action, focusName) => {
  const fake = fakeManagement({ overview: [{ ok: true, data: overviewFixture([]) }] });
  const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
  const opener = await view.findByRole('button', { name: action });
  opener.focus(); await userEvent.keyboard('{Enter}');
  const dialog = view.getByRole('dialog');
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(dialog.getAttribute('aria-labelledby')).toBeTruthy(); expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
  expect(document.activeElement).toBe(action === 'Delete' ? within(dialog).getByRole('button', { name: focusName }) : within(dialog).getByLabelText(focusName));
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await new Promise(r => requestAnimationFrame(r));
  expect(view.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(opener);
  expect(fake.api.createAgent).not.toHaveBeenCalled(); expect(fake.api.updateAgent).not.toHaveBeenCalled(); expect(fake.api.deleteAgent).not.toHaveBeenCalled();
});

it.each(['New agent', 'Edit', 'Duplicate', 'Delete'])('space_opens_%s_and_keyboard_cancel_restores_focus', async action => {
  const fake = fakeManagement({ overview: [{ ok: true, data: overviewFixture([]) }] });
  const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
  const opener = await view.findByRole('button', { name: action });
  opener.focus();
  await userEvent.keyboard(' ');
  const dialog = view.getByRole('dialog');
  within(dialog).getByRole('button', { name: 'Cancel' }).focus();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(view.queryByRole('dialog')).toBeNull();
  expect(fake.api.createAgent).not.toHaveBeenCalled();
  expect(fake.api.updateAgent).not.toHaveBeenCalled();
  expect(fake.api.deleteAgent).not.toHaveBeenCalled();
});

it('keyboard_selects_catalog_entries_with_enter_and_space', async () => {
  const view = render(<AgentsScreen workspace={workspace} management={fakeManagement().api} />);
  const first = await view.findByRole('button', { name: /Codex GPT/ });
  first.focus(); await userEvent.keyboard('{Enter}');
  expect(first.getAttribute('aria-current')).toBe('true');
  const second = view.getByRole('button', { name: /Spare agent/ });
  second.focus(); await userEvent.keyboard(' ');
  expect(second.getAttribute('aria-current')).toBe('true');
  expect(first.getAttribute('aria-current')).not.toBe('true');
});

it('keyboard_search_filters_clear_and_retry_restore_focus', async () => {
  const failure = { ok: false as const, error: { code: 'BROKEN', message: 'Failed', retryable: true } };
  const data = catalogFixture(); data.agents[1] = { ...data.agents[1]!, reasoning: 'high' };
  const fake = fakeManagement({ agents: [failure, { ok: true, data }], overview: [failure, { ok: true, data: overviewFixture([]) }] });
  const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
  const retry = await view.findByRole('button', { name: 'Retry loading agents' });
  retry.focus(); await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(document.activeElement).toBe(view.getByRole('heading', { name: 'Agent catalog' })));
  const usageRetry = view.getByRole('button', { name: 'Retry loading usage' });
  usageRetry.focus(); await userEvent.keyboard(' ');
  await waitFor(() => expect(document.activeElement).toBe(view.getByRole('heading', { name: 'Used by' })));
  const search = view.getByLabelText('Search agents');
  search.focus(); await userEvent.keyboard('missing');
  const clear = view.getByRole('button', { name: 'Clear filters' });
  clear.focus(); await userEvent.keyboard('{Enter}');
  expect(document.activeElement).toBe(search);
  const provider = view.getByLabelText('Provider'); const reasoning = view.getByLabelText('Reasoning');
  provider.focus(); await userEvent.selectOptions(provider, 'codex');
  expect(view.getByText('1 agent')).toBeTruthy();
  reasoning.focus(); await userEvent.selectOptions(reasoning, (reasoning as HTMLSelectElement).options[1]!.value);
  expect(document.activeElement).toBe(reasoning);
});

it('cancel_restores_opener_after_pending_write_or_disconnection', async () => {
  let finish!: (result: { ok: false; error: { code: string; message: string; retryable: boolean } }) => void;
  const fake = fakeManagement({ calls: { createAgent: vi.fn(() => new Promise(resolve => { finish = resolve; })) } });
  const connection = (state: 'connected' | 'lost') => ({ state, error: null, distro: null, command: null });
  const view = render(<AgentsScreen workspace={workspace} management={fake.api} connection={connection('connected')} />);
  const opener = await view.findByRole('button', { name: 'New agent' });
  opener.focus(); await userEvent.keyboard('{Enter}');
  const dialog = view.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Agent id'), { target: { value: 'new-id' } });
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Name' } });
  fireEvent.submit(dialog);
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(document.activeElement).toBe(view.getByLabelText('Search agents')));
  finish({ ok: false, error: { code: 'FAIL', message: 'failed', retryable: true } });
  await waitFor(() => expect(document.activeElement).toBe(opener));
  await userEvent.keyboard('{Enter}');
  view.rerender(<AgentsScreen workspace={workspace} management={fake.api} connection={connection('lost')} />);
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(document.activeElement).toBe(view.getByLabelText('Search agents')));
  view.rerender(<AgentsScreen workspace={workspace} management={fake.api} connection={connection('connected')} />);
  await waitFor(() => expect(document.activeElement).toBe(view.getByRole('button', { name: 'New agent' })));
});

it('long_content_remains_available', async () => {
  const long = 'unbroken'.repeat(40); const description = 'd'.repeat(4000);
  const data = catalogFixture({ agents: [{ id: long + 'id', name: long + 'name', provider: long + 'provider', model: long + 'model', reasoning: long + 'reasoning', description }] });
  const view = render(<AgentsScreen workspace={workspace} management={fakeManagement({ agents: [{ ok: true, data }] }).api} />);
  await view.findByRole('list', { name: 'Saved agents' });
  for (const value of [long + 'id', long + 'name', long + 'provider', long + 'model', long + 'reasoning', description]) expect(view.container.textContent).toContain(value);
});

it('agents_css_reflows_without_clipping', () => {
  const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8');
  const flat = css.replace(/\s+/g, ' ');
  expect(flat).toMatch(/\.agents-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*[^)]+\)\s+minmax\(0,\s*[^)]+\)/);
  expect(flat).toMatch(/\.agents-layout\s*\{[^}]*min-width:\s*0/);
  expect(flat).toMatch(/@media\s*\(max-width:\s*900px\)[\s\S]*?\.agents-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  expect(flat).toMatch(/@media\s*\(max-width:\s*560px\)[\s\S]*?\.agent(?:s|-form)[^{]*(?:actions|form)[^{]*\{/);
  expect(flat).toMatch(/\.agents-filters\s*\{[^}]*flex-wrap:\s*wrap/);
  expect(flat).toMatch(/\.agent-form\s*\{[^}]*max-height:\s*100%[^}]*overflow:\s*auto/);
  const rules = css.split('}').filter(rule => /\.agents?-/.test(rule.split('{')[0] ?? ''));
  expect(rules.join('}')).toContain('overflow-wrap: anywhere');
  for (const rule of rules) expect(rule).not.toMatch(/white-space:\s*nowrap|overflow-x:\s*hidden|text-overflow:\s*ellipsis|minmax\(\s*[1-9]\d*px|(?:min-)?width:\s*[1-9]\d*px/);
});

it('agents_css_has_visible_focus_and_reduced_motion', () => {
  const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8').replace(/\s+/g, ' ');
  for (const element of ['button', 'a', 'input', 'select', 'textarea']) expect(css).toMatch(new RegExp(`\\.agents[^{}]*${element}:focus-visible`));
  expect(css).toMatch(/\.agents[^{}]*:focus-visible[^{}]*\{[^}]*outline:\s*2px solid var\(--focus\)[^}]*outline-offset:/);
  expect(css).toContain('@media (prefers-reduced-motion: reduce)');
});

it('validation_failure_is_announced_once_and_focuses_first_invalid_field', async () => {
  const fake = fakeManagement();
  const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
  fireEvent.click(await view.findByRole('button', { name: 'New agent' }));
  const dialog = view.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create agent' }));
  expect(within(dialog).getAllByRole('alert')).toHaveLength(1);
  expect(document.activeElement).toBe(within(dialog).getByLabelText('Name'));
  expect(fake.api.createAgent).not.toHaveBeenCalled();
});

it('status_is_not_color_only', async () => {
  const fake = fakeManagement({ agents: [{ ok: true, data: catalogFixture({ problems: [{ path: 'agents[0]', message: 'bad provider' }] }) }] });
  const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
  const list = await view.findByRole('list', { name: 'Saved agents' });
  const row = within(list).getAllByRole('button')[0]!;
  expect(row.textContent).toContain('opencode');
  expect(row.textContent).toContain('sonnet');
  expect(view.getByRole('alert').textContent).toContain('bad provider');
  for (const icon of view.container.querySelectorAll('svg, [class*="dot"], [class*="icon"]')) expect(icon.getAttribute('aria-hidden')).toBe('true');
});


it('request_results_are_announced_once_and_focus_returns_to_saved_entry', async () => {
  const agent = { id: 'new-id', name: 'New name', provider: 'codex' };
  const create = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'BROKEN', message: 'Save failed', remediation: 'Try again.', retryable: true } }).mockRejectedValueOnce(new Error('write exploded')).mockResolvedValueOnce({ ok: true, data: { workspace: 'a', agent } });
  const fake = fakeManagement({ calls: { createAgent: create }, agents: [{ ok: true, data: catalogFixture() }, { ok: true, data: catalogFixture({ agents: [...catalogFixture().agents, agent] }) }] });
  const view = render(<AgentsScreen workspace={workspace} management={fake.api} />);
  fireEvent.click(await view.findByRole('button', { name: 'New agent' }));
  const dialog = view.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Agent id'), { target: { value: agent.id } });
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: agent.name } });
  fireEvent.submit(dialog);
  await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('BROKEN: Save failed'));
  expect(within(dialog).getByText('Try again.')).toBeTruthy();
  expect(within(dialog).getAllByRole('alert')).toHaveLength(1);
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Create agent' }));
  fireEvent.submit(dialog);
  await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('INTERNAL: write exploded'));
  expect(within(dialog).getAllByRole('alert')).toHaveLength(1);
  fireEvent.submit(dialog);
  await waitFor(() => expect(document.activeElement).toBe(view.getByRole('button', { name: /New name/ })));
  expect(view.getAllByRole('status')).toHaveLength(1);
  expect(view.getByRole('status').textContent).toContain('Created saved agent');
});

it('form_validation_focuses_first_invalid_field_in_visual_order_and_traps_tab', async () => {
  const view = render(<AgentsScreen workspace={workspace} management={fakeManagement().api} />);
  fireEvent.click(await view.findByRole('button', { name: 'New agent' }));
  const dialog = view.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Agent id'), { target: { value: 'new-agent' } });
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'New agent' } });
  fireEvent.change(within(dialog).getByLabelText('Model'), { target: { value: 'invalid model' } });
  fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'x'.repeat(4001) } });
  fireEvent.submit(dialog);
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText('Model')));
  const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
  cancel.focus(); await userEvent.tab();
  expect(document.activeElement).toBe(within(dialog).getByLabelText('Agent id'));
  await userEvent.tab({ shift: true }); expect(document.activeElement).toBe(cancel);
});

it('client_validation_replaces_previous_server_error', async () => {
  const create = vi.fn().mockResolvedValue({ ok: false, error: { code: 'BROKEN', message: 'Save failed', retryable: true } });
  const view = render(<AgentsScreen workspace={workspace} management={fakeManagement({ calls: { createAgent: create } }).api} />);
  fireEvent.click(await view.findByRole('button', { name: 'New agent' }));
  const dialog = view.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Agent id'), { target: { value: 'new-id' } });
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Name' } });
  fireEvent.submit(dialog);
  await within(dialog).findByText(/Save failed/);
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '' } });
  fireEvent.submit(dialog);
  expect(within(dialog).getAllByRole('alert')).toHaveLength(1);
  expect(within(dialog).getByRole('alert').textContent).toContain('Please correct');
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText('Name')));
  expect(create).toHaveBeenCalledTimes(1);
});

it('saved_description_preserves_surrounding_whitespace', async () => {
  const description = '  saved description  ';
  const agent = { id: 'exact', name: 'Exact', provider: 'codex', description };
  const view = render(<AgentsScreen workspace={workspace} management={fakeManagement({ agents: [{ ok: true, data: catalogFixture({ agents: [agent] }) }] }).api} />);
  await view.findByRole('heading', { name: 'Agent details' });
  expect([...view.container.querySelectorAll('p')].some(p => p.textContent === description)).toBe(true);
});

it('saved_fields_preserve_surrounding_whitespace_in_details', async () => {
  const agent = { id: '  exact-id  ', name: '  Exact name  ', provider: '  provider  ', model: '  model  ', reasoning: '  reasoning  ', description: '  description  ' };
  const view = render(<AgentsScreen workspace={workspace} management={fakeManagement({ agents: [{ ok: true, data: catalogFixture({ agents: [agent] }) }] }).api} />);
  const heading = await view.findByRole('heading', { name: 'Agent details' });
  const details = heading.closest('section')!;
  expect(within(details).getByRole('heading', { level: 3, name: 'Exact name' }).textContent).toBe(agent.name);
  expect([...details.querySelectorAll('p')].some(p => p.textContent === agent.id)).toBe(true);
  expect([...details.querySelectorAll('p')].some(p => p.textContent === agent.description)).toBe(true);
  expect([...details.querySelectorAll('p')].some(p => p.textContent === `${agent.provider} · ${agent.model} · ${agent.reasoning}`)).toBe(true);
});

it.each(['Edit', 'Duplicate'])('cancel_%s_while_disconnected_restores_its_opener_after_reconnect', async action => {
  const connection = (state: 'connected' | 'lost') => ({ state, error: null, distro: null, command: null });
  const fake = fakeManagement();
  const view = render(<AgentsScreen workspace={workspace} management={fake.api} connection={connection('connected')} />);
  const opener = await view.findByRole('button', { name: action });
  opener.focus();
  await userEvent.keyboard('{Enter}');
  expect(view.getByRole('dialog')).toBeTruthy();
  view.rerender(<AgentsScreen workspace={workspace} management={fake.api} connection={connection('lost')} />);
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(document.activeElement).toBe(view.getByLabelText('Search agents')));
  view.rerender(<AgentsScreen workspace={workspace} management={fake.api} connection={connection('connected')} />);
  await waitFor(() => expect(document.activeElement).toBe(view.getByRole('button', { name: action })));
  expect(fake.api.updateAgent).not.toHaveBeenCalled();
  expect(fake.api.createAgent).not.toHaveBeenCalled();
});
