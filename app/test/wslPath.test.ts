import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toWslPath, WslPathError } from '../src/main/wslPath';

function rejects(input: unknown, distro: string | null, code: string, message: string) {
  let err: unknown;
  try {
    toWslPath(input as string, distro);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(WslPathError);
  expect((err as WslPathError).code).toBe(code);
  expect((err as WslPathError).message).toBe(message);
}

const U = 'Ubuntu';

describe('toWslPath', () => {
  it('converts drive paths in any letter case', () => {
    const t: [string, string][] = [
      ['C:\\Works\\x', '/mnt/c/Works/x'],
      ['c:\\Works\\x', '/mnt/c/Works/x'],
      ['D:\\data', '/mnt/d/data'],
      ['z:\\', '/mnt/z'],
      ['c:\\works\\X', '/mnt/c/works/X'],
    ];
    for (const [i, o] of t) expect(toWslPath(i, U)).toBe(o);
  });

  it('accepts forward, mixed and repeated separators and trailing slashes', () => {
    const t: [string, string][] = [
      ['C:/Works/x', '/mnt/c/Works/x'],
      ['C:\\Works/x', '/mnt/c/Works/x'],
      ['C:\\\\Works\\\\\\\\x', '/mnt/c/Works/x'],
      ['C:\\Works\\x\\', '/mnt/c/Works/x'],
      ['C:\\Works\\x\\\\', '/mnt/c/Works/x'],
      ['C:\\', '/mnt/c'],
      ['C:/', '/mnt/c'],
      ['C:\\Works\\.\\x', '/mnt/c/Works/x'],
    ];
    for (const [i, o] of t) expect(toWslPath(i, U)).toBe(o);
  });

  it('keeps spaces and non-ASCII characters exactly', () => {
    expect(toWslPath('C:\\My Projects\\a b', U)).toBe('/mnt/c/My Projects/a b');
    expect(toWslPath('C:\\Users\\Zoë\\プロジェクト', U)).toBe('/mnt/c/Users/Zoë/プロジェクト');
    expect(toWslPath('\\\\wsl$\\Ubuntu\\home\\me\\über ordner', U)).toBe('/home/me/über ordner');
    expect(toWslPath('/home/me/данные', U)).toBe('/home/me/данные');
  });

  it('trims surrounding whitespace', () => {
    expect(toWslPath('  C:\\Works\\x  ', U)).toBe('/mnt/c/Works/x');
    expect(toWslPath('\t/home/me\n', U)).toBe('/home/me');
  });

  it('converts \\\\wsl$ and \\\\wsl.localhost paths of the connected distro', () => {
    const t: [string, string, string][] = [
      ['\\\\wsl$\\Ubuntu\\home\\me\\x', U, '/home/me/x'],
      ['\\\\wsl.localhost\\Ubuntu\\home\\me\\x', U, '/home/me/x'],
      ['\\\\WSL$\\ubuntu\\home\\me', U, '/home/me'],
      ['\\\\WSL.LOCALHOST\\UBUNTU\\home', U, '/home'],
      ['\\\\wsl$\\Ubuntu', U, '/'],
      ['\\\\wsl$\\Ubuntu\\', U, '/'],
      ['//wsl.localhost/Ubuntu/home/me/', U, '/home/me'],
      ['\\\\wsl$\\Ubuntu\\mnt\\c\\Works', U, '/mnt/c/Works'],
      ['\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\x', 'Ubuntu-24.04', '/home/me/x'],
    ];
    for (const [i, d, o] of t) expect(toWslPath(i, d)).toBe(o);
  });

  it('rejects a \\\\wsl$ path of another distro', () => {
    rejects(
      '\\\\wsl$\\Debian\\home\\me',
      U,
      'DISTRO_MISMATCH',
      "'\\\\wsl$\\Debian\\home\\me' is in WSL distro 'Debian', but Agent Studio is connected to 'Ubuntu'.",
    );
    rejects(
      '\\\\wsl.localhost\\Ubuntu-22.04\\x',
      'Ubuntu-24.04',
      'DISTRO_MISMATCH',
      "'\\\\wsl.localhost\\Ubuntu-22.04\\x' is in WSL distro 'Ubuntu-22.04', but Agent Studio is connected to 'Ubuntu-24.04'.",
    );
  });

  it('rejects \\\\wsl$ paths when the distro is unknown', () => {
    const p = '\\\\wsl$\\Ubuntu\\home\\me';
    rejects(
      p,
      null,
      'DISTRO_UNKNOWN',
      `Cannot check the WSL distro of '${p}' because the connected distro is not known. Type the WSL path instead, for example /home/you/project.`,
    );
    expect(toWslPath('C:\\Works\\x', null)).toBe('/mnt/c/Works/x');
    expect(toWslPath('/home/me', null)).toBe('/home/me');
  });

  it('rejects \\\\wsl$ without a distro name', () => {
    for (const p of ['\\\\wsl$', '\\\\wsl.localhost\\']) {
      rejects(p, U, 'NO_DISTRO', `WSL path has no distro name: '${p.trim()}'.`);
    }
  });

  it('passes WSL absolute paths through, normalized', () => {
    const t: [string, string][] = [
      ['/home/me/x', '/home/me/x'],
      ['/mnt/c/Works/x', '/mnt/c/Works/x'],
      ['/home/me/x/', '/home/me/x'],
      ['/home//me/./x', '/home/me/x'],
      ['/', '/'],
      ['/home/me/a\\b', '/home/me/a\\b'],
      ['/home/Me', '/home/Me'],
    ];
    for (const [i, o] of t) expect(toWslPath(i, U)).toBe(o);
  });

  it('rejects other UNC shares', () => {
    for (const p of ['\\\\server\\share\\x', '//server/share', '\\\\192.168.1.5\\c$', '\\\\', '//home/me']) {
      rejects(p, U, 'UNC_SHARE', `Network shares are not supported: '${p}'. Pick a folder on a local drive or in WSL.`);
    }
  });

  it('rejects relative paths', () => {
    for (const p of ['x', './x', 'Works\\x', '~', '~/x', 'C:', 'C:Works', '\\Works\\x', '.']) {
      rejects(
        p,
        U,
        'RELATIVE',
        `Relative paths are not supported: '${p}'. Use a full path such as C:\\Works\\project or /home/you/project.`,
      );
    }
  });

  it('rejects empty input', () => {
    for (const p of ['', '   ', undefined, null, 42]) rejects(p, U, 'EMPTY', 'Folder path is required.');
  });

  it('rejects device paths', () => {
    for (const p of ['\\\\?\\C:\\Works', '\\\\.\\PhysicalDrive0', '//?/C:/x', '//./COM1', '\\??\\C:\\x']) {
      rejects(p, U, 'DEVICE', `Device paths are not supported: '${p}'.`);
    }
  });

  it('rejects NUL characters', () => {
    for (const p of ['C:\\Works\\a\u0000b', '/home/me\u0000', '\u0000']) {
      rejects(p, U, 'NUL', 'Folder path contains a NUL character.');
    }
  });

  it('rejects .. segments', () => {
    for (const p of ['C:\\Works\\..\\x', '/home/me/../x', '\\\\wsl$\\Ubuntu\\home\\..\\x', '/..']) {
      rejects(p, U, 'DOT_DOT', `Folder path must not contain '..': '${p}'.`);
    }
    expect(toWslPath('/home/me/..x', U)).toBe('/home/me/..x');
    expect(toWslPath('C:\\a..b', U)).toBe('/mnt/c/a..b');
  });

  it('rejects Windows-forbidden characters in drive paths', () => {
    for (const p of ['C:\\Works\\a:b', 'C:\\Works\\x?', 'C:\\a|b', 'C:\\a*', 'C:\\"a"']) {
      rejects(
        p,
        U,
        'BAD_CHAR',
        `Folder path contains a character Windows does not allow in names (< > : " | ? *): '${p}'.`,
      );
    }
    expect(toWslPath('/home/me/a:b', U)).toBe('/home/me/a:b');
  });

  it('throws WslPathError with name WslPathError', () => {
    let err: unknown;
    try {
      toWslPath('', U);
    } catch (e) {
      err = e;
    }
    expect((err as Error).name).toBe('WslPathError');
    expect(err).toBeInstanceOf(Error);
  });

  it('is a pure module without Electron or Node imports', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'wslPath.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/require\(/);
  });
});
