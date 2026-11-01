// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SectionCard } from '../src/renderer/teams/SectionCard';

afterEach(cleanup);

describe('SectionCard', () => {
  it('is a section labelled by its own title heading', () => {
    render(<SectionCard title="Live status"><p>Body</p></SectionCard>);
    const region = screen.getByRole('region', { name: 'Live status' });
    const heading = within(region).getByRole('heading', { name: 'Live status', level: 2 });
    expect(region.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(within(region).getByText('Body')).toBeTruthy();
  });

  it('renders an optional subtitle and the body slot', () => {
    render(<SectionCard title="Member settings" subtitle="Saved options apply on next start"><p>Body text</p></SectionCard>);
    const region = screen.getByRole('region', { name: 'Member settings' });
    expect(within(region).getByText('Saved options apply on next start')).toBeTruthy();
    expect(within(region).getByText('Body text')).toBeTruthy();
  });

  it('renders the pencil action with the caller aria-label and calls it', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <SectionCard
        title="Member settings"
        action={{ label: 'Edit', ariaLabel: 'Edit member settings', onClick }}
      >
        <p>Body</p>
      </SectionCard>,
    );
    const button = screen.getByRole('button', { name: 'Edit member settings' });
    expect(button.textContent).toContain('Edit');
    expect(button.querySelector('svg')!.getAttribute('data-icon')).toBe('pencil');
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('disables the action when asked and renders no action button by default', () => {
    const { rerender } = render(
      <SectionCard
        title="Live"
        action={{ label: 'Edit', ariaLabel: 'Edit live agent', onClick: () => undefined, disabled: true }}
      >
        Body
      </SectionCard>,
    );
    expect((screen.getByRole('button', { name: 'Edit live agent' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<SectionCard title="Live">Body</SectionCard>);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
