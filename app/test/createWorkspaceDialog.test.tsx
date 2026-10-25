// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import { CreateWorkspaceDialog } from '../src/renderer/CreateWorkspaceDialog';
import type { InitResult, Result, WorkspacesApi } from '../src/renderer/api';

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeApi(overrides: Partial<WorkspacesApi> = {}): WorkspacesApi {
  return {
    list: vi.fn(),
    create: vi.fn(),
    pickFolder: vi.fn(async () => ({ ok: true, data: null })),
    ...overrides,
  } as WorkspacesApi;
}

const created: InitResult = { id: 'p', name: 'Project', path: '/home/me/project', existed: false };

describe('CreateWorkspaceDialog', () => {
  it('requires a folder and sends typed WSL path with optional name omitted', async () => {
    const create = vi.fn(async () => ({ ok: true as const, data: created }));
    const result = render(<CreateWorkspaceDialog api={fakeApi({ create })} onCancel={vi.fn()} onCreated={vi.fn()} />);
    const folder = result.getByLabelText('Folder');
    const form = result.container.querySelector('form')!;

    fireEvent.change(folder, { target: { value: '   ' } });
    fireEvent.submit(form);
    expect(result.getByRole('alert').textContent).toBe('Folder is required.');
    expect(create).not.toHaveBeenCalled();

    fireEvent.change(folder, { target: { value: '/home/me/project' } });
    fireEvent.change(result.getByLabelText('Name (optional)'), { target: { value: '  ' } });
    fireEvent.submit(form);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ path: '/home/me/project' });
  });

  it('sends a non-empty optional name exactly as typed', () => {
    const pending = deferred<Result<InitResult>>();
    const create = vi.fn(() => pending.promise);
    const result = render(<CreateWorkspaceDialog api={fakeApi({ create })} onCancel={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(result.getByLabelText('Folder'), { target: { value: '/home/me/project' } });
    fireEvent.change(result.getByLabelText('Name (optional)'), { target: { value: ' My Project ' } });
    fireEvent.submit(result.container.querySelector('form')!);
    expect(create).toHaveBeenCalledWith({ path: '/home/me/project', name: ' My Project ' });
  });

  it('does not normalize or validate a non-blank folder path', () => {
    const pending = deferred<Result<InitResult>>();
    const create = vi.fn(() => pending.promise);
    const result = render(<CreateWorkspaceDialog api={fakeApi({ create })} onCancel={vi.fn()} onCreated={vi.fn()} />);
    const typedPath = '  not/a/validated/path  ';
    fireEvent.change(result.getByLabelText('Folder'), { target: { value: typedPath } });
    fireEvent.submit(result.container.querySelector('form')!);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ path: typedPath });
  });

  it('Browse fills the returned WSL path and cancel leaves the prior value', async () => {
    const pickFolder = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: '/mnt/c/Works/project' })
      .mockResolvedValueOnce({ ok: true, data: null });
    const result = render(
      <CreateWorkspaceDialog api={fakeApi({ pickFolder })} onCancel={vi.fn()} onCreated={vi.fn()} />,
    );
    const folder = result.getByLabelText('Folder') as HTMLInputElement;
    await act(async () => fireEvent.click(result.getByRole('button', { name: 'Browse…' })));
    expect(folder.value).toBe('/mnt/c/Works/project');
    await act(async () => fireEvent.click(result.getByRole('button', { name: 'Browse…' })));
    expect(folder.value).toBe('/mnt/c/Works/project');
  });

  it('shows picker errors inline without changing the folder', async () => {
    const pickFolder = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'PICK_FAILED', message: 'Could not pick.', retryable: false, remediation: 'Type a path.' },
      })
      .mockRejectedValueOnce(new Error('picker broke'));
    const result = render(
      <CreateWorkspaceDialog api={fakeApi({ pickFolder })} onCancel={vi.fn()} onCreated={vi.fn()} />,
    );
    const folder = result.getByLabelText('Folder') as HTMLInputElement;
    fireEvent.change(folder, { target: { value: '/prior' } });
    await act(async () => fireEvent.click(result.getByRole('button', { name: 'Browse…' })));
    expect(result.getByRole('alert').textContent).toBe('PICK_FAILED: Could not pick.');
    expect(result.getByText('Type a path.')).toBeTruthy();
    expect(folder.value).toBe('/prior');
    await act(async () => fireEvent.click(result.getByRole('button', { name: 'Browse…' })));
    expect(result.getByRole('alert').textContent).toBe('INTERNAL: picker broke');
    expect(folder.value).toBe('/prior');
  });

  it('converts non-Error picker rejections to INTERNAL text', async () => {
    const pickFolder = vi.fn().mockRejectedValue('picker unavailable');
    const result = render(
      <CreateWorkspaceDialog api={fakeApi({ pickFolder })} onCancel={vi.fn()} onCreated={vi.fn()} />,
    );
    const folder = result.getByLabelText('Folder') as HTMLInputElement;
    fireEvent.change(folder, { target: { value: '/prior' } });

    await act(async () => fireEvent.click(result.getByRole('button', { name: 'Browse…' })));

    expect(result.getByRole('alert').textContent).toBe('INTERNAL: picker unavailable');
    expect(folder.value).toBe('/prior');
    expect(result.queryByText('picker unavailable', { selector: '.dialog-remediation' })).toBeNull();
  });

  it('renders backend error content as text', async () => {
    const create = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: '<img src=x>',
        message: '<script>broken</script>',
        retryable: false,
        remediation: '<b>Type a valid path.</b>',
      },
    }));
    const result = render(
      <CreateWorkspaceDialog api={fakeApi({ create })} onCancel={vi.fn()} onCreated={vi.fn()} />,
    );
    fireEvent.change(result.getByLabelText('Folder'), { target: { value: '/project' } });

    await act(async () => fireEvent.submit(result.container.querySelector('form')!));

    expect(result.getByRole('alert').textContent).toBe('<img src=x>: <script>broken</script>');
    expect(result.getByText('<b>Type a valid path.</b>').textContent).toBe('<b>Type a valid path.</b>');
    expect(result.container.querySelector('img, script, b')).toBeNull();
  });

  it('clears inline errors when browsing starts or either field is edited', async () => {
    const picker = deferred<Result<string | null>>();
    const create = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'NO_FOLDER', message: 'Folder does not exist.', retryable: false },
    }));
    const result = render(
      <CreateWorkspaceDialog
        api={fakeApi({ create, pickFolder: vi.fn(() => picker.promise) })}
        onCancel={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    const folder = result.getByLabelText('Folder');
    const name = result.getByLabelText('Name (optional)');

    fireEvent.change(folder, { target: { value: '/bad' } });
    await act(async () => fireEvent.submit(result.container.querySelector('form')!));
    expect(result.getByRole('alert').textContent).toBe('NO_FOLDER: Folder does not exist.');

    fireEvent.click(result.getByRole('button', { name: 'Browse…' }));
    expect(result.queryByRole('alert')).toBeNull();
    await act(async () => picker.resolve({ ok: true, data: null }));

    await act(async () => fireEvent.submit(result.container.querySelector('form')!));
    expect(result.getByRole('alert')).toBeTruthy();
    fireEvent.change(folder, { target: { value: '/corrected' } });
    expect(result.queryByRole('alert')).toBeNull();

    await act(async () => fireEvent.submit(result.container.querySelector('form')!));
    expect(result.getByRole('alert')).toBeTruthy();
    fireEvent.change(name, { target: { value: 'New name' } });
    expect(result.queryByRole('alert')).toBeNull();
  });

  it('shows progress and suppresses double submit', async () => {
    const pending = deferred<Result<InitResult>>();
    const create = vi.fn(() => pending.promise);
    const onCreated = vi.fn();
    const result = render(<CreateWorkspaceDialog api={fakeApi({ create })} onCancel={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(result.getByLabelText('Folder'), { target: { value: '/home/me/project' } });
    const form = result.container.querySelector('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(create).toHaveBeenCalledTimes(1);
    expect((result.getByRole('button', { name: 'Creating…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(result.getByRole('status').textContent).toBe('Creating workspace…');
    for (const control of result.getAllByRole('button')) expect((control as HTMLButtonElement).disabled).toBe(true);
    expect((result.getByLabelText('Folder') as HTMLInputElement).disabled).toBe(true);
    expect((result.getByLabelText('Name (optional)') as HTMLInputElement).disabled).toBe(true);
    await act(async () => pending.resolve({ ok: true, data: created }));
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('shows create errors inline and permits retry without closing', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'NO_FOLDER', message: 'Folder does not exist.', retryable: false, remediation: 'Choose one.' },
      })
      .mockRejectedValueOnce(new Error('create broke'));
    const onCreated = vi.fn();
    const result = render(<CreateWorkspaceDialog api={fakeApi({ create })} onCancel={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(result.getByLabelText('Folder'), { target: { value: '/bad' } });
    await act(async () => fireEvent.submit(result.container.querySelector('form')!));
    expect(result.getByRole('alert').textContent).toBe('NO_FOLDER: Folder does not exist.');
    expect(result.getByText('Choose one.')).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect((result.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => fireEvent.submit(result.container.querySelector('form')!));
    expect(create).toHaveBeenCalledTimes(2);
    expect(result.getByRole('alert').textContent).toBe('INTERNAL: create broke');
  });

  it('converts non-Error create rejections to INTERNAL text without remediation', async () => {
    const create = vi.fn().mockRejectedValue('backend unavailable');
    const result = render(
      <CreateWorkspaceDialog api={fakeApi({ create })} onCancel={vi.fn()} onCreated={vi.fn()} />,
    );
    fireEvent.change(result.getByLabelText('Folder'), { target: { value: '/project' } });

    await act(async () => fireEvent.submit(result.container.querySelector('form')!));

    expect(result.getByRole('alert').textContent).toBe('INTERNAL: backend unavailable');
    expect(result.queryByText('backend unavailable', { selector: '.dialog-remediation' })).toBeNull();
    expect(result.getByRole('dialog')).toBeTruthy();
  });

  it('traps focus and handles Escape only while idle', async () => {
    const pending = deferred<Result<InitResult>>();
    const create = vi.fn(() => pending.promise);
    const onCancel = vi.fn();
    const result = render(<CreateWorkspaceDialog api={fakeApi({ create })} onCancel={onCancel} onCreated={vi.fn()} />);
    const dialog = result.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(result.container.querySelector(`#${labelledBy}`)?.textContent).toBe('Create workspace');
    const folder = result.getByLabelText('Folder');
    const createButton = result.getByRole('button', { name: 'Create' });
    expect(document.activeElement).toBe(folder);
    createButton.focus();
    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(folder);
    expect(fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(createButton);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.change(folder, { target: { value: '/project' } });
    fireEvent.submit(result.container.querySelector('form')!);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    dialog.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('restores opener focus on cancel but not after successful selection', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    function CancelParent() {
      const [open, setOpen] = useState(true);
      return open ? (
        <CreateWorkspaceDialog api={fakeApi()} onCancel={() => setOpen(false)} onCreated={vi.fn()} />
      ) : null;
    }
    const first = render(<CancelParent />);
    expect(document.activeElement).toBe(first.getByLabelText('Folder'));
    fireEvent.click(first.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(opener);
    first.unmount();
    opener.remove();

    const create = vi.fn(async () => ({ ok: true as const, data: created }));
    function Parent() {
      const [open, setOpen] = useState(true);
      const destination = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={destination}>Back</button>
          {open && (
            <CreateWorkspaceDialog
              api={fakeApi({ create })}
              onCancel={() => setOpen(false)}
              onCreated={() => {
                destination.current?.focus();
                setOpen(false);
              }}
            />
          )}
        </>
      );
    }
    const second = render(<Parent />);
    fireEvent.change(second.getByLabelText('Folder'), { target: { value: '/home/me/project' } });
    await act(async () => fireEvent.submit(second.container.querySelector('form')!));
    expect(second.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(second.getByRole('button', { name: 'Back' }));
  });

  it('ignores pending picker and create results after unmount', async () => {
    const picker = deferred<Result<string | null>>();
    const first = render(
      <CreateWorkspaceDialog
        api={fakeApi({ pickFolder: vi.fn(() => picker.promise) })}
        onCancel={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    fireEvent.click(first.getByRole('button', { name: 'Browse…' }));
    first.unmount();
    await expect(
      act(async () => picker.resolve({ ok: true, data: '/late' })),
    ).resolves.toBeUndefined();

    const createRequest = deferred<Result<InitResult>>();
    const onCreated = vi.fn();
    const second = render(
      <CreateWorkspaceDialog
        api={fakeApi({ create: vi.fn(() => createRequest.promise) })}
        onCancel={vi.fn()}
        onCreated={onCreated}
      />,
    );
    fireEvent.change(second.getByLabelText('Folder'), { target: { value: '/project' } });
    fireEvent.submit(second.container.querySelector('form')!);
    second.unmount();
    await act(async () => createRequest.resolve({ ok: true, data: created }));
    expect(onCreated).not.toHaveBeenCalled();
  });
});
