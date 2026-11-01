import { describe, expect, it } from 'vitest';
import { textByteCountText, textBytes, textCharacters, textLines } from '../src/renderer/shared/textStats';

describe('textStats', () => {
  it('counts UTF-8 bytes rather than characters', () => {
    expect(textBytes('abc')).toBe(3);
    expect(textBytes('é')).toBe(2);
    expect(textBytes('漢字')).toBe(6);
    expect(textBytes('😀')).toBe(4);
    expect(textCharacters('😀é')).toBe(2);
  });

  it('counts an empty text as no lines', () => {
    expect(textLines('')).toBe(0);
    expect(textLines('one line')).toBe(1);
    expect(textLines('one\ntwo')).toBe(2);
    expect(textLines('one\n')).toBe(2);
  });

  it('formats line and grouped byte counts against the limit', () => {
    expect(textByteCountText('', 32768)).toBe('0 lines · 0 / 32,768 bytes');
    expect(textByteCountText('é'.repeat(100), 32768)).toBe('1 lines · 200 / 32,768 bytes');
    expect(textByteCountText('a'.repeat(32768), 32768)).toBe('1 lines · 32,768 / 32,768 bytes');
    expect(textByteCountText('a', 16384)).toBe('1 lines · 1 / 16,384 bytes');
  });
});
