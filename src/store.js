// -----------------------------------------------------------------------------
// A small JSON file in the writable /data volume, for what the integration
// must keep across restarts:
//   - refusals: per address, an HMAC (keyed with `meta.salt`) of the address
//     and token System Bridge refused (BAD_TOKEN), and when to try again
//     alone (`<hmac>|<ms>`): a restart (or a reconnection to Gladys) with the
//     same values does not send them again before.
//   - meta: `salt`, a random key generated once for the HMAC above, and
//     `pausedUntil|<address>`, the end of an HTTP 429 / 503 pause (ms).
// The token itself is never written here. Writes are atomic (temporary file
// + rename) and queued. When the file cannot be written (no /data during
// development), values stay in memory.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const SECTIONS = ['refusals', 'meta'];
/** Objects without a prototype: a key read from the file is never `__proto__` of anything. */
const EMPTY = () => Object.fromEntries(SECTIONS.map((section) => [section, Object.create(null)]));
/** The file is ours, but read defensively all the same. */
const MAX_FILE_BYTES = 256 * 1024;
const MAX_ENTRIES = 100;

export class Store {
  #writes = Promise.resolve();

  /** @param {{ filePath: string, logger?: { warn: Function } }} options */
  constructor({ filePath, logger }) {
    this.filePath = filePath;
    this.logger = logger;
    this.data = EMPTY();
    this.loaded = null;
  }

  /** Reads the file once; later calls share the first read. */
  load() {
    this.loaded ??= readFile(this.filePath, 'utf8')
      .then((content) => {
        if (content.length > MAX_FILE_BYTES) throw new Error('file too large');
        const parsed = JSON.parse(content);
        const data = EMPTY();
        for (const section of SECTIONS) {
          const value = parsed?.[section];
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          for (const [key, v] of Object.entries(value).slice(0, MAX_ENTRIES)) {
            if (typeof v === 'string' && v && v.length <= 512) data[section][key] = v;
          }
        }
        this.data = data;
      })
      .catch((err) => {
        if (err.code !== 'ENOENT')
          this.logger?.warn(`Store unreadable, starting empty: ${err.message}`);
        this.data = EMPTY();
      });
    return this.loaded;
  }

  get(section, key) {
    return this.data[section]?.[key] ?? null;
  }

  async set(section, key, value) {
    if (value === null || value === undefined) delete this.data[section][key];
    else this.data[section][key] = value;
    await this.#save();
  }

  /** The random key of this installation (created on first use). */
  async salt() {
    let salt = this.get('meta', 'salt');
    if (!salt) {
      salt = randomBytes(32).toString('hex');
      await this.set('meta', 'salt', salt);
    }
    return salt;
  }

  #save() {
    const write = this.#writes.then(() => this.#write());
    this.#writes = write.catch(() => {});
    return write;
  }

  async #write() {
    const tmp = `${this.filePath}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.filePath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      this.logger?.warn(`Store not saved, values kept in memory only: ${err.message}`);
    }
  }
}
