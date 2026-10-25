import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLiveCheck } from '../src/live/liveCheck';

describe('runLiveCheck platform guard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses to run outside Windows before creating evidence or contacting WSL', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      runLiveCheck({ distro: null, entry: null, repoWsl: null, out: null, keep: false }),
    ).resolves.toBe(2);
    expect(log).toHaveBeenCalledWith(
      'The live check must run on Windows (PowerShell): it drives wsl.exe from Windows.',
    );
  });
});
