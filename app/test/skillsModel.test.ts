import { describe, expect, it } from 'vitest';
import type { SkillItem } from '../src/renderer/api';
import {
  filterSkills,
  formatSkillBytes,
  formatSkillLimit,
  skillRoleNames,
  skillSize,
  skillSummary,
} from '../src/renderer/skills/skillsModel';
import { skillItem } from './skillFixtures';

function item(overrides: Partial<SkillItem> = {}): SkillItem {
  return skillItem({
    id: 'alpha',
    state: 'ok',
    title: 'Alpha',
    bytes: 100,
    sha256: 'a'.repeat(64),
    roles: [],
    ...overrides,
  });
}

describe('filterSkills', () => {
  const skills = [
    item({ id: 'alpha', title: 'Deploy notes' }),
    item({ id: 'Beta-skill', title: null }),
    item({ id: 'gamma', title: 'Alpha helper' }),
  ];

  it('matches the id and title case-insensitively in catalog order', () => {
    expect(filterSkills(skills, 'ALPHA').map((skill) => skill.id)).toEqual(['alpha', 'gamma']);
    expect(filterSkills(skills, 'beta').map((skill) => skill.id)).toEqual(['Beta-skill']);
    expect(filterSkills(skills, 'helper').map((skill) => skill.id)).toEqual(['gamma']);
    expect(filterSkills(skills, 'zzz')).toEqual([]);
  });

  it('trims the query and treats a whitespace-only query as no filter', () => {
    expect(filterSkills(skills, '  beta  ').map((skill) => skill.id)).toEqual(['Beta-skill']);
    expect(filterSkills(skills, '   ').map((skill) => skill.id)).toEqual(['alpha', 'Beta-skill', 'gamma']);
    expect(filterSkills([], 'anything')).toEqual([]);
  });
});

describe('formatSkillBytes', () => {
  it('uses bytes below one KiB and one decimal above it', () => {
    expect(formatSkillBytes(0)).toBe('0 B');
    expect(formatSkillBytes(4)).toBe('4 B');
    expect(formatSkillBytes(839)).toBe('839 B');
    expect(formatSkillBytes(1023)).toBe('1023 B');
    expect(formatSkillBytes(1024)).toBe('1.0 KB');
    expect(formatSkillBytes(1331)).toBe('1.3 KB');
    expect(formatSkillBytes(2048)).toBe('2.0 KB');
    expect(formatSkillBytes(40960)).toBe('40.0 KB');
  });

  it('renders a dash for a missing or invalid size', () => {
    expect(formatSkillBytes(null)).toBe('—');
    expect(formatSkillBytes(-1)).toBe('—');
    expect(formatSkillBytes(Number.NaN)).toBe('—');
    expect(formatSkillBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatSkillLimit', () => {
  it('shows whole KiB without a decimal and part KiB with one', () => {
    expect(formatSkillLimit(1024)).toBe('1 KiB');
    expect(formatSkillLimit(32768)).toBe('32 KiB');
    expect(formatSkillLimit(33280)).toBe('32.5 KiB');
  });
});

describe('skillSummary', () => {
  it('explains a missing and an unreadable SKILL.md as warnings', () => {
    expect(skillSummary(item({ state: 'missing', title: null, bytes: null }))).toEqual({
      text: 'No SKILL.md found. Roles still list it.',
      warning: true,
    });
    expect(skillSummary(item({ state: 'unreadable', title: null, bytes: null }))).toEqual({
      text: 'The file cannot be read.',
      warning: true,
    });
  });

  it('trims the title and falls back to No title when it is empty', () => {
    expect(skillSummary(item({ title: '  Searching the code  ' }))).toEqual({ text: 'Searching the code', warning: false });
    expect(skillSummary(item({ title: null }))).toEqual({ text: 'No title', warning: false });
    expect(skillSummary(item({ title: '   ' }))).toEqual({ text: 'No title', warning: false });
  });
});

describe('skillSize', () => {
  it('shows the size against the configured limit for a readable skill', () => {
    expect(skillSize(item({ bytes: 839 }), 32768)).toEqual({
      primary: '839 B',
      secondary: 'of 32 KiB',
      warning: false,
      noteWarning: false,
    });
    expect(skillSize(item({ bytes: 2048 }), 32768).primary).toBe('2.0 KB');
  });

  it('shows the real size in amber with the exceeded limit for a truncated skill', () => {
    expect(skillSize(item({ state: 'truncated', bytes: 40960 }), 32768)).toEqual({
      primary: '40.0 KB',
      secondary: 'Over the 32 KiB limit',
      warning: true,
      noteWarning: true,
    });
  });

  it('replaces the size for a missing and an unreadable skill', () => {
    expect(skillSize(item({ state: 'missing', bytes: null }), 32768)).toEqual({
      primary: 'Missing',
      secondary: 'File not found',
      warning: true,
      noteWarning: false,
    });
    expect(skillSize(item({ state: 'unreadable', bytes: null }), 32768)).toEqual({
      primary: 'Unreadable',
      secondary: null,
      warning: true,
      noteWarning: false,
    });
  });
});

describe('skillRoleNames', () => {
  it('uses trimmed names and falls back to the id for a missing or blank name', () => {
    expect(skillRoleNames(item({
      roles: [
        { id: 'alpha', name: ' Alpha ', contextBytes: 100 },
        { id: 'beta', name: null, contextBytes: 200 },
        { id: 'gamma', name: '   ', contextBytes: 300 },
      ],
    }))).toEqual(['Alpha', 'beta', 'gamma']);
  });
});
