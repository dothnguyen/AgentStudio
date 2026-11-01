// @vitest-environment jsdom
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { SkillsCaptureApp, isSkillsListReady, openSkillsSection } from '../capture/SkillsCaptureApp';
import { skillsV1Catalog, skillsV1Detail } from '../capture/skillsV1Fixture';

const appDir = path.join(__dirname, '..');
const designDir = path.join(appDir, '..', 'design', 'skills-v1');
const captureDir = path.join(designDir, 'captures');
const read = (absolutePath: string) => fs.readFileSync(absolutePath, 'utf8');

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.captureReady;
  delete document.documentElement.dataset.captureError;
});

function pngSize(file: string): { width: number; height: number } {
  const data = fs.readFileSync(file);
  expect([...data.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('skills v1 capture fixture', () => {
  it('matches the design sample skills, states and role usage', () => {
    const catalog = skillsV1Catalog();
    expect(catalog.skills.map(skill => skill.id)).toEqual(['code-search', 'python-testing', 'story-format', 'ts-testing', 'legacy-notes']);
    expect(catalog.skills.map(skill => skill.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'missing']);
    expect(catalog.skills[0]!.roles.map(role => role.id)).toEqual(['TeamLead', 'Developer', 'QA', 'Reviewer']);
    expect(catalog.skills[3]!.roles).toEqual([]);
    expect(catalog.limits).toEqual({ skillBytes: 32768, roleContextBytes: 98304 });
    expect(skillsV1Detail('code-search').text).toContain('# Searching the code cheaply');
    expect(skillsV1Detail('legacy-notes').text).toBeNull();
  });

  it('opens Skills in the real shell and marks the list ready', async () => {
    render(<SkillsCaptureApp />);
    await waitFor(() => expect(document.documentElement.dataset.captureReady).toBe('true'), { timeout: 3000 });
    expect(isSkillsListReady(document)).toBe(true);
    expect(document.querySelectorAll('[data-skill-id]')).toHaveLength(5);
    expect(document.querySelector('[data-section="skills"]')?.textContent).toContain('code-search');
    expect(openSkillsSection(document)).toBe(true);
  });
});

describe('skills v1 capture evidence', () => {
  const names = ['list', 'detail', 'detail-missing', 'edit-content', 'edit-roles', 'new-skill', 'delete-skill'];
  const manifest = JSON.parse(read(path.join(captureDir, 'manifest.json'))) as {
    width: number;
    height: number;
    files: Record<string, string>;
  };

  it.each(names)('captures/%s.png is a real 1440x1160 screenshot matching its checksum', (name) => {
    const file = path.join(captureDir, `${name}.png`);
    expect(fs.existsSync(file), `${file} is missing`).toBe(true);
    expect(fs.statSync(file).size).toBeGreaterThan(10_000);
    expect(pngSize(file)).toEqual({ width: manifest.width, height: manifest.height });
    expect(manifest.files[`${name}.png`]).toBeTruthy();
    expect(sha256(file)).toBe(manifest.files[`${name}.png`]);
  });

  it('names each capture like its design file and keeps the design size', () => {
    for (const name of names) {
      const design = path.join(designDir, `${name}.png`);
      expect(fs.existsSync(design), `${design} is missing`).toBe(true);
      expect(pngSize(design), `${name}.png must use the design size`).toEqual({
        width: manifest.width,
        height: manifest.height,
      });
      expect(pngSize(path.join(captureDir, `${name}.png`))).toEqual(pngSize(design));
    }
  });

  it('wires the skills capture command and documents the generated files', () => {
    const pkg = JSON.parse(read(path.join(appDir, 'package.json'))) as { scripts: Record<string, string> };
    expect(pkg.scripts['capture:skills']).toContain('electron dist/live/captureSkills.js');
    const capture = read(path.join(appDir, 'src/live/captureSkills.ts'));
    expect(capture).toContain("'design', 'skills-v1', 'captures'");
    for (const name of names) expect(capture).toContain(`file: '${name}.png'`);
    const readme = read(path.join(designDir, 'README.md'));
    expect(readme).toContain('npm --prefix app run capture:skills');
    for (const name of names) expect(readme).toContain(`captures/${name}.png`);
  });

  it('lists_every_deliberate_difference_from_the_design', () => {
    const readme = read(path.join(designDir, 'README.md'));
    for (const difference of [
      "the app's own sidebar",
      'real workspace values',
      'Skill catalog problems',
      'Save to file is disabled',
      'Context bytes',
    ]) expect(readme, `README must list: ${difference}`).toContain(difference);
  });
});
