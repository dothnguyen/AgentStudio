import type { PromptDetail } from '../api';

export const PLACEHOLDERS = {
  task: 'The ticket being worked', validation: 'Results of the previous check step',
  summary: 'Summary from the previous step', findings: 'Findings from earlier rounds',
  delegated_commands: 'Commands this step may ask the coordinator to run', diff: 'The change on the branch (large)',
  stage: 'This step id', visit: 'Which attempt of this step this is',
} as const;

export function groupPrompts(prompts: PromptDetail[], filter: string): { board: PromptDetail[]; other: PromptDetail[] } {
  const query = filter.trim().toLowerCase();
  const matching = prompts.filter(p => `${p.name}.md`.toLowerCase().includes(query));
  return { board: matching.filter(p => p.name.startsWith('board-')), other: matching.filter(p => !p.name.startsWith('board-')) };
}
export function usedBy(users: PromptDetail['users'], titles: Record<string, string>): string {
  return users.map(user => `${titles[user.workflow] ?? user.workflow} · ${user.step}`).join(', ');
}
export function wordCount(text: string): number { return text.trim() ? text.trim().split(/\s+/u).length : 0; }
export function tokenCount(text: string): number { return Math.round(wordCount(text) * 1.33); }
export function detectPlaceholders(text: string): { used: string[]; unknown: string[] } {
  const names = Array.from(new Set(Array.from(text.matchAll(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g), match => match[1])));
  return { used: names.filter(name => Object.hasOwn(PLACEHOLDERS, name)), unknown: names.filter(name => !Object.hasOwn(PLACEHOLDERS, name)) };
}
export function insertPlaceholder(text: string, name: string, start: number, end: number): { text: string; cursor: number } {
  const value = `{{${name}}}`;
  return { text: text.slice(0, start) + value + text.slice(end), cursor: start + value.length };
}
