import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-111 Part 3: responsive behaviour of the member details page.
 *
 * The page cannot be laid out at a real viewport width in jsdom, so these
 * tests read the stylesheet the same way the other style tests do and assert
 * the effective rules at the two required widths:
 *  - 900px and below: one column, the aside below the main column.
 *  - 700px and below: a dialog fills the viewport minus 24px and scrolls
 *    inside its own body; nothing is allowed to overflow horizontally.
 */
const rawCss = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8');
const css = rawCss.replace(/\s+/g, ' ');

interface MediaBlock {
  maxWidth: number;
  body: string;
}

function mediaBlocks(source: string): MediaBlock[] {
  const blocks: MediaBlock[] = [];
  const marker = '@media (max-width:';
  let at = source.indexOf(marker);
  while (at !== -1) {
    const headerEnd = source.indexOf('{', at);
    const header = source.slice(at, headerEnd);
    let depth = 0;
    let end = headerEnd;
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const width = /@media \(max-width: (\d+)px\)/.exec(header);
    if (width) blocks.push({ maxWidth: Number(width[1]), body: source.slice(headerEnd + 1, end) });
    at = source.indexOf(marker, end + 1);
  }
  return blocks;
}

const blocks = mediaBlocks(css);

function declarations(source: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A rule may be preceded by the end of an earlier rule or a comment block.
  const pattern = new RegExp(`(?:^|[};])\\s*(?:/\\*[\\s\\S]*?\\*/\\s*)?${escaped}\\s*\\{([^}]*)\\}`, 'g');
  return Array.from(source.matchAll(pattern), (match) => match[1] ?? '');
}

function declaration(selector: string): string {
  return declarations(css, selector).join(' ');
}

describe('member details responsive layout', () => {
  it('is one column with the aside below the main column at 900px and below', () => {
    // A rule that applies at 900px must switch the layout to a column.
    const stacking = blocks.filter((block) => block.maxWidth >= 900
      && declarations(block.body, '.teams-member-layout').some((rule) => /flex-direction:\s*column/.test(rule)));
    expect(stacking.length, 'a stacking rule must apply at 900px').toBeGreaterThan(0);

    // No narrower rule may turn the page back into a row.
    const rows = blocks.filter((block) => block.maxWidth <= 900
      && declarations(block.body, '.teams-member-layout').some((rule) => /flex-direction:\s*row/.test(rule)));
    expect(rows).toEqual([]);

    // In the stacking rule both columns take the full width and the aside
    // loses its 400px cap, so it sits below the main column.
    const block = stacking.find((candidate) => /width:\s*100%/.test(declarations(candidate.body, '.teams-member-main').join(' '))
      && /width:\s*100%/.test(declarations(candidate.body, '.teams-member-aside').join(' '))
      && /max-width:\s*none/.test(declarations(candidate.body, '.teams-member-aside').join(' ')));
    expect(block, 'main and aside must both become full width').toBeTruthy();

    // The base layout still wraps before the breakpoint, so a narrow shell
    // does not squeeze the two columns into the viewport.
    expect(declaration('.teams-member-layout')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('fills the viewport minus 24px with dialogs at 700px and scrolls the body inside', () => {
    const backdropRules = blocks.filter((block) => block.maxWidth <= 700
      && declarations(block.body, '.dialog-backdrop').some((rule) => /padding:\s*24px 12px/.test(rule)));
    expect(backdropRules.length, 'the 12px side padding rule must apply at 700px').toBeGreaterThan(0);

    const panelRules = blocks.filter((block) => block.maxWidth <= 700
      && declarations(block.body, '.dialog-panel').some((rule) => /max-height:\s*calc\(100vh - 48px\)/.test(rule)));
    expect(panelRules.length, 'the panel must stay inside the shortened viewport').toBeGreaterThan(0);

    // 12px on each side of a 100% panel is the viewport minus 24px.
    expect(declaration('.dialog-backdrop')).toMatch(/box-sizing:\s*border-box/);
    expect(declaration('.dialog-panel')).toMatch(/box-sizing:\s*border-box/);
    expect(declaration('.dialog-panel')).toMatch(/max-width:\s*100%/);
    expect(declaration('.dialog-body')).toMatch(/overflow-y:\s*auto/);
    // The panel itself clips instead of scrolling the whole dialog.
    expect(declaration('.dialog-panel')).toMatch(/overflow:\s*hidden/);
  });

  it('keeps the member page and dialogs from overflowing horizontally', () => {
    for (const selector of ['.teams-member-detail', '.teams-member-layout', '.teams-member-main', '.teams-member-aside', '.section-card']) {
      expect(declaration(selector), `${selector} must be allowed to shrink`).toMatch(/min-width:\s*0/);
      for (const rule of declarations(css, selector)) {
        for (const part of rule.split(';')) {
          const [property, value] = part.split(':');
          if (property?.trim() === 'min-width') {
            expect(value?.trim(), `${selector} must not set a fixed minimum width`).toBe('0');
          }
        }
      }
    }
    // Long names, ids and notes wrap instead of widening their card.
    expect(css).toMatch(/\.teams-member-title-row h1 \{[^}]*overflow-wrap:\s*anywhere;/);
    expect(css).toMatch(/\.teams-member-notice \{[^}]*overflow-wrap:\s*anywhere;/);
    expect(css).toMatch(/\.teams-member-subline \{[^}]*overflow-wrap:\s*anywhere;/);
    // The page is capped at a readable width rather than given a fixed one.
    expect(declaration('.teams-member-detail')).toMatch(/max-width:\s*1120px/);
    expect(declaration('.teams-member-detail')).not.toMatch(/(?:^|[^-])width:\s*\d+px/);
  });
});
