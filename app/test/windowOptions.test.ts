import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CSP, buildWindowOptions, isAllowedNavigation } from '../src/main/windowOptions';

describe('window options', () => {
  it('returns the fixed window configuration', () => {
    expect(buildWindowOptions('/x/preload.js')).toEqual({
      width: 1100,
      height: 750,
      minWidth: 640,
      minHeight: 480,
      title: 'Agent Studio',
      autoHideMenuBar: true,
      webPreferences: {
        preload: '/x/preload.js',
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        spellcheck: false,
      },
    });
  });

  it('locks down webPreferences', () => {
    const wp = buildWindowOptions('/x/preload.js').webPreferences!;
    expect(wp.nodeIntegration).toBe(false);
    expect(wp.contextIsolation).toBe(true);
    expect(wp.sandbox).toBe(true);
    expect(wp.webSecurity).toBe(true);
    expect(wp.allowRunningInsecureContent).toBe(false);
    expect(wp.webviewTag).toBe(false);
    expect(wp.nodeIntegrationInWorker).toBe(false);
    expect(wp.nodeIntegrationInSubFrames).toBe(false);
    expect(wp.preload).toBe('/x/preload.js');
  });

  it('has a strict CSP', () => {
    for (const s of ["default-src 'none'", "script-src 'self'", "connect-src 'none'", "object-src 'none'", "base-uri 'none'"]) {
      expect(CSP).toContain(s);
    }
    for (const s of ['unsafe-inline', 'unsafe-eval', 'http:', 'https:', '*']) {
      expect(CSP).not.toContain(s);
    }
  });

  it('sets every required CSP directive with no permissive sources', () => {
    expect(CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
  });

  it('index.html carries the CSP and no remote or inline content', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
    expect(html).toContain(`content="${CSP}"`);
    for (const s of ['http://', 'https://', '<script', 'style=']) expect(html).not.toContain(s);
  });

  it('allows only the index url for navigation', () => {
    expect(isAllowedNavigation('file:///x/index.html', 'file:///x/index.html')).toBe(true);
    expect(isAllowedNavigation('https://example.com', 'file:///x/index.html')).toBe(false);
  });
});
