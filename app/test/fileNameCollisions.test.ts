import { readdirSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appDir = resolve(__dirname, '..');

/** Every file under a directory, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(absolute);
    return [absolute];
  });
}

/** A path with its folder and extension removed, lower-cased: the name Windows would see twice. */
function collisionKey(file: string): string {
  const name = basename(file);
  return resolve(dirname(file), name.slice(0, name.length - extname(name).length).toLowerCase());
}

/** Groups files that share a folder and whose names differ only by case and extension. */
export function findCaseInsensitiveCollisions(files: readonly string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const key = collisionKey(file);
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

describe('app source file names', () => {
  it('do not collide when ignoring case and extension', () => {
    const collisions = findCaseInsensitiveCollisions(filesUnder(resolve(appDir, 'src')));
    const descriptions = collisions.map((group) => group.sort().join(' <-> '));
    expect(
      descriptions,
      `Files collide on case-insensitive file systems:\n${descriptions.join('\n')}`,
    ).toEqual([]);
  });

  it('detects a model and component that differ only by case', () => {
    const dir = resolve(appDir, 'src/renderer/boards');
    expect(
      findCaseInsensitiveCollisions([
        resolve(dir, 'x.ts'),
        resolve(dir, 'X.tsx'),
        resolve(dir, 'other.ts'),
      ]),
    ).toEqual([[resolve(dir, 'x.ts'), resolve(dir, 'X.tsx')]]);
  });
});
