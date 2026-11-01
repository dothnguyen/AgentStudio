// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState, type JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../src/renderer/ui/ConfirmDialog';

afterEach(cleanup);

const flush = () => act(async () => {});

function Harness(props: { busy?: boolean; reasonLabel?: string; onConfirm?(reason?: string): void }): JSX.Element {
  const [open, setOpen] = useState(true);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" ref={opener} onClick={() => setOpen(true)}>Open</button>
      {open && (
        <ConfirmDialog
          title="Delete ticket?"
          body="This removes the ticket."
          details={['T-090 · blocked', 'T-091 · paused']}
          confirmLabel="Delete ticket"
          danger
          busy={props.busy}
          reasonLabel={props.reasonLabel}
          maxReasonLength={12}
          returnFocusRef={opener}
          onCancel={() => setOpen(false)}
          onConfirm={(reason) => { props.onConfirm?.(reason); setOpen(false); }}
        />
      )}
    </>
  );
}

describe('ConfirmDialog', () => {
  it('is a described alertdialog with its initial focus on Cancel', async () => {
    render(<Harness />);
    const dialog = screen.getByRole('alertdialog', { name: 'Delete ticket?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('This removes the ticket.')).toBeTruthy();
    expect(screen.getByRole('list')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('describes the details list together with the body', () => {
    render(<Harness />);
    const dialog = screen.getByRole('alertdialog', { name: 'Delete ticket?' });
    const describedBy = dialog.getAttribute('aria-describedby')!.split(/\s+/);
    const described = describedBy.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(described).toContain('This removes the ticket.');
    expect(described).toContain('T-090 · blocked');
    expect(described).toContain('T-091 · paused');
    const list = screen.getByRole('list');
    expect(describedBy).toContain(list.id);
  });

  it('cancels on Escape and returns focus to the opener', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.keyboard('{Escape}'); await flush();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open' }));
  });

  it('confirms with the optional reason', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness reasonLabel="Reason (optional)" onConfirm={onConfirm} />);
    await user.type(screen.getByLabelText('Reason (optional)'), 'not needed');
    await user.click(screen.getByRole('button', { name: 'Delete ticket' })); await flush();
    expect(onConfirm).toHaveBeenCalledWith('not needed');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('limits the reason to 500 characters by default', () => {
    render(<ConfirmDialog title="Reject?" body="Reject it." reasonLabel="Reason (optional)" confirmLabel="Reject" onConfirm={() => undefined} onCancel={() => undefined} />);
    expect((screen.getByLabelText('Reason (optional)') as HTMLInputElement).maxLength).toBe(500);
  });

  it('keeps Tab inside the dialog', async () => {
    const user = userEvent.setup();
    render(<Harness reasonLabel="Reason (optional)" />);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Delete ticket' });
    expect(document.activeElement).toBe(cancel);
    await user.tab();
    expect(document.activeElement).toBe(confirm);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText('Reason (optional)'));
    await user.tab({ shift: true });
    expect(screen.getByRole('alertdialog').contains(document.activeElement)).toBe(true);
  });

  it('keeps Tab inside the dialog when there is no reason field', async () => {
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        title="Delete ticket?"
        body="This removes the ticket."
        confirmLabel="Delete ticket"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Delete ticket' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.activeElement).toBe(cancel);
    await user.tab();
    expect(document.activeElement).toBe(confirm);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);
  });

  it('disables actions and ignores Escape while busy', async () => {
    const user = userEvent.setup();
    render(<Harness busy />);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Delete ticket' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Delete ticket' }).getAttribute('aria-busy')).toBe('true');
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    void user;
  });

  it('confirms without a reason when the optional field is blank', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness reasonLabel="Reason (optional)" onConfirm={onConfirm} />);
    await user.type(screen.getByLabelText('Reason (optional)'), '   ');
    await user.click(screen.getByRole('button', { name: 'Delete ticket' })); await flush();
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it('returns focus to the element focused before it opened when no ref is given', async () => {
    function NoRefHarness(): JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Show</button>
          {open && (
            <ConfirmDialog
              title="Delete ticket?"
              body="This removes the ticket."
              confirmLabel="Delete ticket"
              onConfirm={() => setOpen(false)}
              onCancel={() => setOpen(false)}
            />
          )}
        </>
      );
    }
    render(<NoRefHarness />);
    const opener = screen.getByRole('button', { name: 'Show' });
    opener.focus();
    fireEvent.click(opener); await flush();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); await flush();
    expect(document.activeElement).toBe(opener);
  });

  it('reuses the modal overlay and marks a danger confirmation', () => {
    render(
      <ConfirmDialog
        title="Delete team?"
        body="This removes the team."
        confirmLabel="Delete team"
        danger
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const dialog = screen.getByRole('alertdialog', { name: 'Delete team?' });
    expect(dialog.className).toContain('ui-confirm-danger-dialog');
    expect(dialog.closest('.teams-live-modal')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Delete team' }).className).toContain('ui-confirm-confirm-danger');
  });
});
