import type { SkillItem } from '../api';

export interface SkillSummaryView {
  text: string;
  warning: boolean;
}

export interface SkillSizeView {
  primary: string;
  secondary: string | null;
  warning: boolean;
  noteWarning: boolean;
}

/** Case-insensitive match over a skill id and its title; whitespace-only queries match everything. */
export function filterSkills(skills: readonly SkillItem[], query: string): SkillItem[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [...skills];
  return skills.filter(skill => [skill.id, skill.title ?? ''].some(value => value.toLocaleLowerCase().includes(q)));
}

/** "839 B" below 1 KiB, "1.2 KB" at or above it. */
export function formatSkillBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—';
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** The configured limit as a whole or one-decimal KiB value, e.g. 32768 -> "32 KiB". */
export function formatSkillLimit(bytes: number): string {
  const kib = bytes / 1024;
  return Number.isInteger(kib) ? `${kib} KiB` : `${kib.toFixed(1)} KiB`;
}

export function skillSummary(skill: SkillItem): SkillSummaryView {
  if (skill.state === 'missing') return { text: 'No SKILL.md found. Roles still list it.', warning: true };
  if (skill.state === 'unreadable') return { text: 'The file cannot be read.', warning: true };
  const title = skill.title?.trim();
  return { text: title ? title : 'No title', warning: false };
}

export function skillSize(skill: SkillItem, limit: number): SkillSizeView {
  if (skill.state === 'missing') return { primary: 'Missing', secondary: 'File not found', warning: true, noteWarning: false };
  if (skill.state === 'unreadable') return { primary: 'Unreadable', secondary: null, warning: true, noteWarning: false };
  if (skill.state === 'truncated') {
    return { primary: formatSkillBytes(skill.bytes), secondary: `Over the ${formatSkillLimit(limit)} limit`, warning: true, noteWarning: true };
  }
  return { primary: formatSkillBytes(skill.bytes), secondary: `of ${formatSkillLimit(limit)}`, warning: false, noteWarning: false };
}

/** Role display names in catalog order: `name` when present, otherwise the id. */
export function skillRoleNames(skill: SkillItem): string[] {
  return skill.roles.map(role => {
    const name = role.name?.trim();
    return name ? name : role.id;
  });
}

export type SkillUsageTone = 'used' | 'muted' | 'missing';

export interface SkillUsageView {
  text: string;
  tone: SkillUsageTone;
}

/** Header pill: amber for a missing file, blue when used, grey when no role lists it. */
export function skillUsage(skill: SkillItem): SkillUsageView {
  if (skill.state === 'missing') return { text: 'Missing', tone: 'missing' };
  const count = skill.roles.length;
  if (count === 0) return { text: 'Not used', tone: 'muted' };
  return { text: `Used by ${count} ${count === 1 ? 'role' : 'roles'}`, tone: 'used' };
}

/** Muted header line: the skill title, or the missing-file explanation. */
export function skillHeaderNote(skill: SkillItem): string {
  if (skill.state === 'missing') {
    const count = skill.roles.length;
    return `Referenced by ${count} ${count === 1 ? 'role' : 'roles'}, but there is no file.`;
  }
  const title = skill.title?.trim();
  return title ? title : 'No title';
}

/** Text shown under "Title" in the Details card. */
export function skillDetailsTitle(skill: SkillItem): string {
  if (skill.state === 'missing') return 'No SKILL.md found';
  if (skill.state === 'unreadable') return 'The file cannot be read.';
  const title = skill.title?.trim();
  return title ? title : 'No title';
}

/** Text shown under "Size" in the Details card. */
export function skillDetailsSize(skill: SkillItem, limit: number): string {
  if (skill.state === 'missing') return 'File not found';
  if (skill.state === 'unreadable') return 'File cannot be read';
  return `${formatSkillBytes(skill.bytes)} of ${formatSkillLimit(limit)}`;
}

/** "11 lines · 839 / 32,768 bytes" for a loaded preview. */
export function formatSkillStats(text: string, bytes: number, limit: number): string {
  return `${text === '' ? 0 : text.split('\n').length} lines · ${bytes.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')} bytes`;
}

export interface RoleContextView {
  text: string;
  warning: boolean;
}

/** "Context 9.4 KB of 96 KiB"; amber once the context is above 80% of the limit. */
export function formatRoleContext(bytes: number, limit: number): RoleContextView {
  const kib = Number.isFinite(bytes) && bytes > 0 ? bytes / 1024 : 0;
  return {
    text: `Context ${kib.toFixed(1)} KB of ${formatSkillLimit(limit)}`,
    warning: limit > 0 && bytes > limit * 0.8,
  };
}

/** The amber note for a skill that roles list without a file. */
export function skillMissingNote(path: string): string {
  return `Roles refer to this skill but ${path} does not exist, so it is skipped when assignments start. Create it, or remove it from the roles that list it.`;
}

/** The note shown under a preview that stopped at the configured limit. */
export function skillTruncatedNote(limit: number): string {
  return `This file is larger than ${formatSkillLimit(limit)}, so only the start is shown and it cannot be edited here. Shorten it outside the app.`;
}

/** First letter for the role avatar in Used by roles. */
export function roleInitial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}
