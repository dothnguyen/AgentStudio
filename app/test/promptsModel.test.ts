import { describe, expect, it } from 'vitest';
import { detectPlaceholders, groupPrompts, insertPlaceholder, tokenCount, usedBy, wordCount } from '../src/renderer/workflow/promptsModel';
import type { PromptDetail } from '../src/renderer/api';

const prompt = (name: string): PromptDetail => ({ name, text: '', words: 0, sha256: '', users: [] });
describe('prompt model', () => {
  it('groups and filters filenames', () => {
    expect(groupPrompts([prompt('board-qa'), prompt('other')], '')).toEqual({ board: [prompt('board-qa')], other: [prompt('other')] });
    expect(groupPrompts([prompt('board-qa'), prompt('other')], 'QA.MD').board).toEqual([prompt('board-qa')]);
  });
  it('formats workflow titles and falls back to ids', () => {
    expect(usedBy([{ workflow: 'qa', step: 'verdict' }, { workflow: 'other', step: 'work' }], { qa: 'QA' })).toBe('QA · verdict, other · work');
  });
  it('counts words and estimates tokens', () => {
    expect(wordCount('  one\n two  three ')).toBe(3);
    expect(tokenCount('one two three')).toBe(4);
    expect(wordCount(' \n ')).toBe(0);
  });
  it('detects distinct used and unknown placeholders', () => {
    expect(detectPlaceholders('{{task}} {{mystery}} {{task}} {{visit}}')).toEqual({ used: ['task', 'visit'], unknown: ['mystery'] });
  });
  it('inserts at the selection and returns the cursor', () => {
    expect(insertPlaceholder('hello world', 'task', 6, 11)).toEqual({ text: 'hello {{task}}', cursor: 14 });
  });
});
