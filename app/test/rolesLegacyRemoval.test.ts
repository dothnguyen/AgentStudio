import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appDir = resolve(__dirname, '..');
const read = (relativePath: string): string => readFileSync(resolve(appDir, relativePath), 'utf8');
const css = read('src/renderer/styles.css');

/** Every renderer source file, so a deleted component cannot linger in an import. */
function rendererSources(): string[] {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(dir, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return /\.(ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
  return walk(resolve(appDir, 'src/renderer'));
}

/**
 * The values of `className=` attributes only. Matching raw source text would
 * treat an `id="roles-delete-reason"` (an id, not a class) as a used class and
 * hide a stale stylesheet selector.
 */
function classNameSources(source: string): string {
  const attributes: string[] = [];
  const needle = 'className';
  let index = source.indexOf(needle);
  while (index !== -1) {
    let cursor = index + needle.length;
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    if (source[cursor] === '=') {
      cursor += 1;
      while (/\s/.test(source[cursor] ?? '')) cursor += 1;
      const start = cursor;
      if (source[cursor] === '{') {
        let depth = 0;
        for (; cursor < source.length; cursor += 1) {
          if (source[cursor] === '{') depth += 1;
          else if (source[cursor] === '}') {
            depth -= 1;
            if (depth === 0) { cursor += 1; break; }
          }
        }
      } else if (source[cursor] === '"' || source[cursor] === "'") {
        const quote = source[cursor];
        cursor += 1;
        while (cursor < source.length && source[cursor] !== quote) cursor += 1;
        cursor += 1;
      }
      attributes.push(source.slice(start, cursor));
    }
    index = source.indexOf(needle, cursor);
  }
  return attributes.join('\n');
}

/**
 * T-115 removes the old master-detail Roles screen after the table, role page
 * and edit dialogs replaced it. These assertions read the production files
 * because the removal itself is the behaviour: deleted components cannot be
 * exercised through the UI.
 */
describe('roles v2 legacy layout removal', () => {
  it('deletes the old editor components and the two-pane layout', () => {
    for (const file of ['RoleForm.tsx', 'RoleSkillEditor.tsx', 'RoleDetails.tsx']) {
      expect(existsSync(resolve(appDir, 'src/renderer/roles', file)), `${file} must be removed`).toBe(false);
    }
    const screen = read('src/renderer/roles/RolesScreen.tsx');
    expect(screen).not.toMatch(/\bRoleDetails\b|\bRoleForm\b|\bRoleSkillEditor\b/);
    expect(screen).not.toMatch(/roles-layout|roles-detail|roles-list/);
    for (const file of rendererSources()) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} still mentions the removed role editor`).not.toMatch(/\bRoleForm\b|\bRoleSkillEditor\b|\bRoleDetails\b/);
    }
  });

  it('keeps the v2 table, role page and dialogs wired', () => {
    const screen = read('src/renderer/roles/RolesScreen.tsx');
    for (const part of ['roles-table-card', 'roles-table-scroll', '<RolePage', '<RoleCreateDialog', '<RoleOverviewDialog', '<RoleSkillsDialog', '<RolePageInstructionsDialog', '<RoleDeleteDialog']) {
      expect(screen).toContain(part);
    }
    const page = read('src/renderer/roles/RolePage.tsx');
    for (const part of ['roles-overview-card', 'roles-instructions-card', 'roles-skills-card', 'roles-usedby-card']) {
      expect(page).toContain(part);
    }
  });

  it('removes the styles that only the old layout and form used', () => {
    for (const selector of [
      '.roles-layout',
      '.roles-list',
      '.roles-detail-pane',
      '.roles-details',
      '.roles-edit-row',
      '.roles-actions',
      '.roles-saved',
      '.roles-delete-trigger',
      '.roles-delete-confirm',
      '.roles-delete-name',
      '.roles-delete-actions',
      '.roles-form',
      '.roles-field',
      '.roles-form-alert',
      '.roles-field-error',
      '.roles-form-actions',
      '.roles-skill-add',
      '.roles-skill-actions',
      '.roles-skill-list',
      '.roles-skill-row',
      '.roles-conflict',
      '.roles-instructions-input',
    ]) {
      expect(css, `${selector} must be removed`).not.toContain(selector);
    }
    // Match the old class alone, not the new roles-skill-chips / roles-skill-chip-missing.
    expect(css).not.toMatch(/\.roles-instructions(?![-a-z])/);
    expect(css).not.toMatch(/\.roles-skill-missing(?![-a-z])/);
  });

  it('leaves_no_roles_stylesheet_class_unused_by_the_v2_screen', () => {
    // The old layout was removed selector by selector; this catches a class
    // that is deleted from the components but forgotten in styles.css.
    const classes = Array.from(new Set(Array.from(css.matchAll(/\.(roles-[a-zA-Z0-9_-]+)/g), match => match[1]!)));
    expect(classes.length).toBeGreaterThan(50);
    const classNames = classNameSources(rendererSources().map(file => readFileSync(file, 'utf8')).join('\n'));
    const unused = classes.filter(name => !new RegExp(`(^|[^\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`).test(classNames));
    expect(unused).toEqual([]);
    // The delete-reason id stays (aria-describedby), but it must not come back
    // as a stylesheet class: the element is styled by roles-role-reason.
    expect(classNames).not.toMatch(/\broles-delete-reason\b/);
  });

  it('drops the model helpers only the old master-detail editor used', () => {
    const rolesModel = read('src/renderer/roles/rolesModel.ts');
    for (const name of ['selectedRoleId', 'requestedRoleSelection', 'selectionAfterRoleDeletion']) {
      expect(rolesModel, `${name} must be removed from rolesModel`).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
    const editModel = read('src/renderer/roles/roleEditModel.ts');
    for (const name of ['ROLE_FIELDS', 'emptyRoleForm', 'editRoleForm']) {
      expect(editModel, `${name} must be removed from roleEditModel`).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
    // The dialogs still need these shared helpers.
    expect(editModel).toContain('validateRoleForm');
    expect(editModel).toContain('buildRoleSavePlan');
    expect(rolesModel).toContain('roleUsageSummary');
  });
});
