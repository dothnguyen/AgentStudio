// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Icon } from '../src/renderer/icons/Icon';

afterEach(cleanup);

describe('Icon', () => {
  it('icon_renders_decorative_svg', () => {
    const { container } = render(<Icon name="ticket" tone="warning" size={20} className="x" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('class')).toBe('icon icon-warning x');
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.getAttribute('data-icon')).toBe('ticket');
    expect(svg.hasAttribute('role')).toBe(false);
    expect(svg.hasAttribute('tabindex')).toBe(false);
    expect(svg.textContent).toBe('');
  });

  it('icon_renders_every_name_including_roles_as_decorative_svg', () => {
    for (const name of ['home', 'teams', 'agents', 'roles', 'boards', 'configuration', 'switch', 'chevron', 'refresh', 'item'] as const) {
      const { container } = render(<Icon name={name} />);
      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('data-icon')).toBe(name);
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('focusable')).toBe('false');
      expect(svg.querySelector('path')!.getAttribute('d')).toBeTruthy();
      cleanup();
    }
  });

  it('icon_without_tone_has_no_tone_class', () => {
    const { container } = render(<Icon name="clock" />);
    expect(container.querySelector('svg')!.getAttribute('class')).toBe('icon');
  });
});
