import { describe, expect, it } from 'vitest';
import type { SkillItem } from '../src/renderer/api';
import {
  filterSkills,
  formatRoleContext,
  formatSkillBytes,
  formatSkillLimit,
  formatSkillStats,
  roleInitial,
  skillDetailsSize,
  skillDetailsTitle,
  skillHeaderNote,
  skillMissingNote,
  skillRoleNames,
  skillSize,
  skillSummary,
  skillTruncatedNote,
  skillUsage,
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

describe('skill page model', () => {
  it('labels the usage pill for used, unused and missing skills', () => {
    expect(skillUsage(item({ roles: [{ id: 'a', name: 'A', contextBytes: 1 }] }))).toEqual({ text: 'Used by 1 role', tone: 'used' });
    expect(skillUsage(item({ roles: [{ id: 'a', name: 'A', contextBytes: 1 }, { id: 'b', name: 'B', contextBytes: 2 }] })))
      .toEqual({ text: 'Used by 2 roles', tone: 'used' });
    expect(skillUsage(item({ roles: [] }))).toEqual({ text: 'Not used', tone: 'muted' });
    expect(skillUsage(item({ state: 'missing', title: null, bytes: null, roles: [] }))).toEqual({ text: 'Missing', tone: 'missing' });
  });

  it('describes the header line and details values for each readable state', () => {
    expect(skillHeaderNote(item({ title: ' Alpha title ' }))).toBe('Alpha title');
    expect(skillHeaderNote(item({ title: '  ' }))).toBe('No title');
    expect(skillHeaderNote(item({ state: 'missing', title: null, bytes: null, roles: [{ id: 'a', name: 'A', contextBytes: 1 }] })))
      .toBe('Referenced by 1 role, but there is no file.');
    expect(skillHeaderNote(item({ state: 'missing', title: null, bytes: null, roles: [
      { id: 'a', name: 'A', contextBytes: 1 },
      { id: 'b', name: 'B', contextBytes: 2 },
    ] }))).toBe('Referenced by 2 roles, but there is no file.');
    expect(skillHeaderNote(item({ state: 'missing', title: null, bytes: null, roles: [] })))
      .toBe('Referenced by 0 roles, but there is no file.');
    expect(skillDetailsTitle(item({ title: 'Alpha' }))).toBe('Alpha');
    expect(skillDetailsTitle(item({ state: 'missing', title: null, bytes: null }))).toBe('No SKILL.md found');
    expect(skillDetailsTitle(item({ state: 'unreadable', title: null, bytes: null }))).toBe('The file cannot be read.');
    expect(skillDetailsSize(item({ bytes: 839 }), 32768)).toBe('839 B of 32 KiB');
    expect(skillDetailsSize(item({ state: 'missing', bytes: null }), 32768)).toBe('File not found');
    expect(skillDetailsSize(item({ state: 'unreadable', bytes: null }), 32768)).toBe('File cannot be read');
  });

  it('formats preview stats and role context sizes', () => {
    expect(formatSkillStats('one\ntwo', 839, 32768)).toBe('2 lines · 839 / 32,768 bytes');
    expect(formatSkillStats('', 0, 32768)).toBe('0 lines · 0 / 32,768 bytes');
    expect(formatRoleContext(2048, 98304)).toEqual({ text: 'Context 2.0 KB of 96 KiB', warning: false });
    expect(formatRoleContext(0, 98304)).toEqual({ text: 'Context 0.0 KB of 96 KiB', warning: false });
    expect(formatRoleContext(78644, 98304).warning).toBe(true);
    expect(formatRoleContext(78643, 98304).warning).toBe(false);
    expect(formatRoleContext(90000, 98304)).toEqual({ text: 'Context 87.9 KB of 96 KiB', warning: true });
  });

  it('builds the missing and truncation notes and the avatar initial', () => {
    expect(skillMissingNote('skills/legacy-notes/SKILL.md'))
      .toBe('Roles refer to this skill but skills/legacy-notes/SKILL.md does not exist, so it is skipped when assignments start. Create it, or remove it from the roles that list it.');
    expect(skillTruncatedNote(32768))
      .toBe('This file is larger than 32 KiB, so only the start is shown and it cannot be edited here. Shorten it outside the app.');
    expect(roleInitial('TeamLead')).toBe('T');
    expect(roleInitial('  developer')).toBe('D');
    expect(roleInitial('')).toBe('?');
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
