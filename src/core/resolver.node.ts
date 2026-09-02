import { realpathSync } from 'node:fs';
import type { PathResolver } from './derive.ts';

/**
 * Filesystem-backed resolution. Kept in its own module so the browser bundle
 * never reaches `node:fs` — importing this from UI code is the mistake it is
 * designed to make obvious.
 */
export const nodeResolver: PathResolver = {
  realpath(path: string): string | null {
    try {
      return realpathSync(path);
    } catch {
      // Missing, permission-denied, or a broken link. Unknown, not safe.
      return null;
    }
  },
};
