// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState, type JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '../src/renderer/teams/Dialog';

afterEach(cleanup);

const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8').replace(/\s+/g, ' ');

function Harness(props: { busy?: boolean; width?: number; noInitialFocus?: boolean; disabledInitialFocus?: boolean; disabledSave?: boolean; onOpen?(): void; onSave?(): void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const disabled = useRef<HTMLButtonElement>(null);
  return <div data-testid="app">
    <button ref={opener} type="button" onClick={() => { props.onOpen?.(); setOpen(true); }}>Open dialog</button>
    {open && <Dialog
      title="Edit member settings"
      width={props.width}
      initialFocus={props.noInitialFocus === true ? undefined : props.disabledInitialFocus === true ? disabled : first}
      busy={props.busy}
      footerNote="Applies on next team start"
      actions={[
        { label: 'Cancel', onClick: () => setOpen(false) },
        { label: 'Save', variant: 'primary', disabled: props.disabledSave, onClick: () => { props.onSave?.(); setOpen(false); } },
      ]}
      onClose={() => setOpen(false)}
    >
      <label>Display name <input ref={first} defaultValue="lead" /></label>
      <button ref={disabled} type="button" disabled>Disabled start</button>
      <button type="button">Middle action</button>
    </Dialog>}
  </div>;
}

const open = async (props: { busy?: boolean } = {}) => {
  const user = userEvent.setup();
  render(<Harness {...props} />);
  await user.click(screen.getByRole('button', { name: 'Open dialog' }));
  return user;
};

describe('Dialog', () => {
  it('is a modal dialog labelled by its title with note and footer actions', async () => {
    await open();
    const dialog = screen.getByRole('dialog', { name: 'Edit member settings' });
    expect(screen.getByTestId('app').contains(dialog)).toBe(false);
    expect(dialog.parentElement?.className).toBe('dialog-backdrop');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Edit member settings');
    expect(screen.getByText('Applies on next team start')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' }).className).toContain('dialog-action-primary');
  });

  it('defaults to 520px wide and never grows past the window', async () => {
    await open();
    expect(screen.getByRole('dialog').getAttribute('style')).toContain('width: min(520px, 100%)');
  });

  it('takes a custom width and still caps it at the window', async () => {
    const user = userEvent.setup();
    render(<Harness width={640} />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    expect(screen.getByRole('dialog').getAttribute('style')).toContain('width: min(640px, 100%)');
  });

  it('focuses the first focusable control when no initialFocus is given', async () => {
    const user = userEvent.setup();
    render(<Harness noInitialFocus />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  it('falls back to the first focusable control when initialFocus cannot take focus', async () => {
    const user = userEvent.setup();
    render(<Harness disabledInitialFocus />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  it('uses its own title group class instead of the legacy dialog-heading class', async () => {
    await open();
    const header = screen.getByRole('dialog').querySelector('.dialog-header')!;
    expect(header.querySelector('.dialog-heading')).toBeNull();
    expect(header.querySelector('.dialog-title-group')).not.toBeNull();
    expect(css).toContain('.dialog-title-group { min-width: 0; }');
  });

  it('does not inherit the legacy dialog divider above the footer buttons', async () => {
    await open();
    const actions = screen.getByRole('button', { name: 'Cancel' }).parentElement!;
    expect(actions.className).toBe('dialog-footer-actions');
    expect(actions.className).not.toContain('dialog-actions');
    expect(css).toContain('.dialog-footer-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 0 auto; padding: 0; border: 0; }');
  });

  it('moves focus to the initial focus and traps Tab and Shift+Tab', async () => {
    const user = await open();
    expect(document.activeElement).toBe(screen.getByLabelText('Display name'));
    await user.tab(); // Middle action
    await user.tab(); // Cancel
    await user.tab(); // Save
    await user.tab(); // wraps to the first control, the close button
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }));
  });

  it('wraps Shift+Tab from the first control to the last', async () => {
    const user = await open();
    const close = screen.getByRole('button', { name: 'Close' });
    close.focus();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }));
  });

  it('honours an individually disabled action and does not call it', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<Harness disabledSave onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('closes on Escape and returns focus to the opener', async () => {
    const user = await open();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open dialog' }));
  });

  it('ignores Escape and the close button while busy', async () => {
    const user = await open({ busy: true });
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeTruthy();
    const close = screen.getByRole('button', { name: 'Close' });
    expect((close as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(close);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.click(cancel);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('does not close when the backdrop is clicked', async () => {
    await open();
    fireEvent.click(document.querySelector('.dialog-backdrop')!);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('keeps Escape working after a backdrop click drops focus to the document', async () => {
    const user = await open();
    const backdrop = document.querySelector('.dialog-backdrop')!;
    // Pressing the backdrop is prevented from moving focus out of the dialog…
    expect(fireEvent.mouseDown(backdrop)).toBe(false);
    fireEvent.click(backdrop);
    // …and even if focus does end up on <body>, Escape is handled at document level.
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape when the panel background itself has focus', async () => {
    const user = await open();
    const dialog = screen.getByRole('dialog');
    dialog.focus();
    expect(document.activeElement).toBe(dialog);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open dialog' }));
  });

  it('pulls Tab and Shift+Tab back into the panel when focus is outside it', async () => {
    const user = await open();
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }));
  });

  it('treats the panel itself as a Tab boundary', async () => {
    const user = await open();
    const dialog = screen.getByRole('dialog');
    dialog.focus();
    expect(document.activeElement).toBe(dialog);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    dialog.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }));
  });

  it('keeps the body scrollable while header and footer stay outside it', async () => {
    await open();
    const dialog = screen.getByRole('dialog');
    const body = dialog.querySelector('.dialog-body')!;
    expect(body).toBeTruthy();
    expect(body.contains(screen.getByLabelText('Display name'))).toBe(true);
    expect(dialog.querySelector('.dialog-header')!.contains(body)).toBe(false);
    expect(dialog.querySelector('.dialog-footer')!.contains(body)).toBe(false);
    expect(css).toContain('.dialog-body { min-height: 0; padding: 20px; overflow-y: auto; }');
    expect(css).toContain('.dialog-panel { display: flex; flex-direction: column; box-sizing: border-box; max-width: 100%; max-height: calc(100vh - 120px);');
  });

  it('makes the app behind inert and clears it on close', async () => {
    const user = await open();
    expect(screen.getByTestId('app').closest('[inert]')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('app').closest('[inert]')).toBeNull();
  });

  it('closes with the close button and restores focus', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open dialog' }));
  });
});
