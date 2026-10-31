import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { definitionMetaText, shortRuntimeId } from '../src/renderer/teams/teamsModel';
import { team } from './teamsFixtures';

const flat = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8').replace(/\s+/g, ' ');

describe('team page header model', () => {
  it('short_runtime_id_keeps_first_and_last_eight_characters_of_long_ids', () => {
    expect(shortRuntimeId('b4597175-1111-2222-3333-4444f9548168')).toBe('b4597175…f9548168');
  });

  it('short_runtime_id_leaves_short_ids_unchanged', () => {
    expect(shortRuntimeId('rt-9')).toBe('rt-9');
    expect(shortRuntimeId('12345678901234567890')).toBe('12345678901234567890');
  });

  it('definition_meta_text_reports_each_definition_state', () => {
    const problems = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `p${i}`, message: 'x' }));
    expect(definitionMetaText(team())).toEqual({ text: 'Definition valid', tone: 'ok' });
    expect(definitionMetaText(team({ definition: { state: 'problems', problems: problems(1) } }))).toEqual({ text: 'Definition has 1 problem', tone: 'warning' });
    expect(definitionMetaText(team({ definition: { state: 'problems', problems: problems(2) } }))).toEqual({ text: 'Definition has 2 problems', tone: 'warning' });
    expect(definitionMetaText(team({ definition: { state: 'unreadable', problems: [] } }))).toEqual({ text: 'Definition unreadable', tone: 'warning' });
    expect(definitionMetaText(team({ definition: { state: 'missing', problems: [] } }))).toEqual({ text: 'No definition (runtime only)', tone: 'warning' });
  });

  it('styles_match_the_v4_header_and_tab_reference_values', () => {
    expect(flat).toContain('.teams-view-tabs .teams-view-tab[aria-selected="true"] { color: #e7e9ec; border-bottom-color: #5b9cff; }');
    expect(flat).toContain('.teams-page-title-row h1 { margin: 0; color: #e7e9ec; font-size: 22px; font-weight: 600; letter-spacing: -0.01em;');
    expect(flat).toContain('.teams-screen.teams-screen-v4 { box-sizing: content-box; max-width: 1120px;');
  });
});
