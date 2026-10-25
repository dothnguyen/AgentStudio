export type WslPathErrorCode =
  | 'EMPTY'
  | 'NUL'
  | 'DEVICE'
  | 'RELATIVE'
  | 'DOT_DOT'
  | 'BAD_CHAR'
  | 'UNC_SHARE'
  | 'NO_DISTRO'
  | 'DISTRO_UNKNOWN'
  | 'DISTRO_MISMATCH';

export class WslPathError extends Error {
  name = 'WslPathError';
  constructor(
    public readonly code: WslPathErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: WslPathErrorCode, message: string): never {
  throw new WslPathError(code, message);
}

function cleanSegments(parts: string[], p: string): string[] {
  if (parts.some((s) => s === '..')) fail('DOT_DOT', `Folder path must not contain '..': '${p}'.`);
  return parts.filter((s) => s !== '' && s !== '.');
}

function join(segs: string[], prefix: string): string {
  if (segs.length === 0) return prefix === '' ? '/' : prefix;
  return prefix + '/' + segs.join('/');
}

export function toWslPath(input: string, distro: string | null): string {
  if (typeof input !== 'string') fail('EMPTY', 'Folder path is required.');
  if (input.includes('\u0000')) fail('NUL', 'Folder path contains a NUL character.');
  const p = input.trim();
  if (p === '') fail('EMPTY', 'Folder path is required.');

  if (/^[\\/]{2}[?.][\\/]/.test(p) || p.startsWith('\\??\\')) {
    fail('DEVICE', `Device paths are not supported: '${p}'.`);
  }

  if (/^[\\/]{2}/.test(p)) {
    const raw = p.split(/[\\/]+/).filter((s) => s !== '');
    const host = raw[0];
    if (host === undefined || (host.toLowerCase() !== 'wsl$' && host.toLowerCase() !== 'wsl.localhost')) {
      fail('UNC_SHARE', `Network shares are not supported: '${p}'. Pick a folder on a local drive or in WSL.`);
    }
    const d = raw[1];
    if (d === undefined) fail('NO_DISTRO', `WSL path has no distro name: '${p}'.`);
    if (distro === null) {
      fail(
        'DISTRO_UNKNOWN',
        `Cannot check the WSL distro of '${p}' because the connected distro is not known. Type the WSL path instead, for example /home/you/project.`,
      );
    }
    if (d.toLowerCase() !== distro.toLowerCase()) {
      fail('DISTRO_MISMATCH', `'${p}' is in WSL distro '${d}', but Agent Studio is connected to '${distro}'.`);
    }
    return join(cleanSegments(raw.slice(2), p), '');
  }

  if (p.startsWith('/')) return join(cleanSegments(p.split('/'), p), '');

  if (/^[A-Za-z]:[\\/]/.test(p)) {
    const letter = p[0].toLowerCase();
    const segs = cleanSegments(p.slice(3).split(/[\\/]/), p);
    if (segs.some((s) => /[<>:"|?*]/.test(s))) {
      fail('BAD_CHAR', `Folder path contains a character Windows does not allow in names (< > : " | ? *): '${p}'.`);
    }
    return join(segs, '/mnt/' + letter);
  }

  return fail(
    'RELATIVE',
    `Relative paths are not supported: '${p}'. Use a full path such as C:\\Works\\project or /home/you/project.`,
  );
}
