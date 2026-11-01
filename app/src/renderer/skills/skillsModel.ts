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
