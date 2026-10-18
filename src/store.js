// -----------------------------------------------------------------------------
// The state kept in /data (the only writable place of the container): the
// reference of the billed index, the value held back and the tariffs, so that
// a restart never forgets a jump the user has not accepted; and the refusal
// of the Smile ID (a hash, never the ID) and an HTTP 429 pause, so that a
// restart never hammers the Smile. A small JSON file, written through a
// temporary file and a rename. Failures are logged, never fatal.
// (From gladys-p1-monitor.)
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';

export const DEFAULT_STATE_FILE = '/data/plugwise-state.json';

export function createFileStore(file = DEFAULT_STATE_FILE) {
  return {
    load() {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      } catch {
        return {};
      }
    },
    async save(data) {
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(data), 'utf8');
      await rename(tmp, file);
    },
  };
}

/** The same in memory (tests). */
export function createMemoryStore(initial = {}) {
  let data = structuredClone(initial);
  return {
    load: () => structuredClone(data),
    async save(next) {
      data = structuredClone(next);
    },
    get data() {
      return data;
    },
  };
}
