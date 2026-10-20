// -----------------------------------------------------------------------------
// The System Bridge client: one WebSocket to `ws://<host>:<port>/api/websocket`,
// the protocol of timmo001/system-bridge-connector, ported to JavaScript.
//
//   every request   { token, id, event, data } as one JSON text message (the
//                   token travels in each message: System Bridge has no
//                   session); its answer carries the same id
//   getData         GET_DATA { modules } -> DATA_GET, then one DATA_UPDATE
//                   per module (id "system", `module` names it)
//   command         POWER_LOCK / _SLEEP / _HIBERNATE / _RESTART / _SHUTDOWN
//                   -> POWER_LOCKING / ..., OPEN { url } -> OPENED
//   a wrong token   ERROR with subtype BAD_TOKEN (the connection stays open)
//
// The socket is opened on demand and kept between readings; a closed socket
// is opened again by the next request (the caller paces them). Nothing is
// ever logged with the request: it holds the token.
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { LIMITS, TIMEOUTS, WEBSOCKET_PATH } from '../constants.js';
import { BridgeError, CODES, TOKEN_SUBTYPES } from './errors.js';
import { openWebSocket } from './ws.js';

const DATA_SETTLE_MS = 5_000;

export class BridgeClient {
  /**
   * @param {object} options
   * @param {{ hostname: string, port: number }} options.address
   * @param {string} options.token
   * @param {Function} [options.connect] openWebSocket (tests)
   * @param {() => number} [options.now]
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   */
  constructor({ address, token, connect = openWebSocket, now = Date.now, timers = globalThis }) {
    this.address = address;
    // Not enumerable: never printed with the client.
    Object.defineProperty(this, 'token', { value: token, enumerable: false });
    this.connect = connect;
    this.now = now;
    this.timers = timers;
    this.socket = null;
    this.opening = null;
    this.disposed = false;
    /** id -> { answer, resolve, reject, handle } */
    this.pending = new Map();
    /** The readings waiting for their module updates. */
    this.collections = new Set();
    /** Messages received while nothing waited for one (see LIMITS.UNSOLICITED_*). */
    this.unsolicited = { messages: 0, bytes: 0 };
  }

  get connected() {
    return Boolean(this.socket?.open);
  }

  /** The socket open now, or null: a verified command is written on it and nowhere else. */
  currentSocket() {
    return this.socket?.open ? this.socket : null;
  }

  /** Open the socket, or fail at `limit` (the caller's own deadline, even when sharing an opening). */
  async #openBy(limit) {
    if (this.socket?.open && !this.disposed) return this.socket;
    const opening = this.ensureOpen(limit);
    if (limit === undefined) return opening;
    let handle = null;
    const late = new Promise((_, reject) => {
      handle = this.timers.setTimeout(
        () => reject(new BridgeError(CODES.TIMEOUT, 'no connection in time', { sent: false })),
        Math.max(0, limit - this.now()),
      );
    });
    opening.catch(() => {}); // a late failure of a shared opening is the opener's business
    try {
      return await Promise.race([opening, late]);
    } finally {
      this.timers.clearTimeout(handle);
    }
  }

  /** Open the socket if needed (shared by concurrent callers). */
  async ensureOpen(deadline) {
    if (this.disposed) throw new BridgeError(CODES.CLOSED, 'configuration changed');
    if (this.socket?.open) return this.socket;
    if (!this.opening) {
      // Bound once open: the close handler of an older socket changes nothing.
      let socket = null;
      const timeoutMs = Math.max(
        1,
        Math.min(TIMEOUTS.CONNECT, (deadline ?? Infinity) - this.now()),
      );
      this.opening = this.connect({
        hostname: this.address.hostname,
        port: this.address.port,
        path: WEBSOCKET_PATH,
        timeoutMs,
        maxMessageBytes: LIMITS.MESSAGE_BYTES,
        onMessage: (text) => this.#message(text),
        onClose: (err) => this.#closed(socket, err),
      })
        .then((opened) => {
          socket = opened;
          if (this.disposed) {
            opened.close();
            throw new BridgeError(CODES.CLOSED, 'configuration changed');
          }
          this.socket = opened;
          return opened;
        })
        .finally(() => {
          this.opening = null;
        });
    }
    return this.opening;
  }

  /** Close the socket (the client stays usable: the next request opens a new one). */
  disconnect() {
    this.socket?.close();
    this.socket = null;
  }

  /** Close for good: a new configuration made a new client. */
  dispose() {
    this.disposed = true;
    this.disconnect();
    this.#rejectAll(new BridgeError(CODES.CLOSED, 'configuration changed'));
  }

  /**
   * Send one request; resolves with the answer of type `answer` (same id),
   * rejects with a BridgeError: BAD_TOKEN, REFUSED (an ERROR answer), TIMEOUT
   * or CLOSED (`sent` tells whether the request was written).
   *
   * `sendBy`: nothing is written after this instant (an opening that ends
   * later fails, sent: false). `socket`: written on this socket only, never
   * on a new connection (a command verified on it).
   */
  async request(event, data, answer, { deadline, sendBy, socket: only, onSent } = {}) {
    let socket;
    if (only !== undefined) {
      if (this.disposed || !only?.open || this.socket !== only) {
        throw new BridgeError(CODES.CLOSED, 'connection closed', { sent: false });
      }
      socket = only;
    } else {
      socket = await this.#openBy(sendBy ?? deadline);
    }
    if (sendBy !== undefined && this.now() > sendBy) {
      throw new BridgeError(CODES.TIMEOUT, 'too late to send', { sent: false });
    }
    if (this.pending.size >= LIMITS.PENDING) {
      throw new BridgeError(CODES.BUSY, 'too many requests waiting');
    }
    this.unsolicited = { messages: 0, bytes: 0 };
    const id = randomUUID();
    const message = JSON.stringify({ token: this.token, id, event, data });
    return new Promise((resolve, reject) => {
      const entry = { answer, resolve, reject, handle: null, sent: false };
      const settle = (fn, value) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.timers.clearTimeout(entry.handle);
        fn(value);
      };
      entry.resolve = (value) => settle(resolve, value);
      entry.reject = (err) => {
        if (err instanceof BridgeError && entry.sent && !err.sent) {
          err = new BridgeError(err.code, err.message, { ...err, sent: true });
        }
        settle(reject, err);
      };
      this.pending.set(id, entry);
      entry.handle = this.timers.setTimeout(
        () =>
          entry.reject(new BridgeError(CODES.TIMEOUT, 'no answer in time', { sent: entry.sent })),
        Math.max(0, (deadline ?? this.now() + TIMEOUTS.READ) - this.now()),
      );
      socket.send(message).then((written) => {
        if (!written) {
          entry.reject(new BridgeError(CODES.CLOSED, 'connection closed', { sent: false }));
          return;
        }
        entry.sent = true;
        onSent?.();
      });
    });
  }

  /**
   * Read data modules. Resolves { <module>: data } with every module
   * received; at least `system` (else TIMEOUT). A module System Bridge does
   * not have (it never answers it) is left out after a short wait.
   */
  async getData(modules, { deadline } = {}) {
    deadline ??= this.now() + TIMEOUTS.READ;
    const collection = { modules: new Set(modules), data: Object.create(null), done: null };
    const complete = new Promise((resolve) => {
      collection.done = resolve;
    });
    this.collections.add(collection);
    let handle = null;
    try {
      await this.request('GET_DATA', { modules: [...modules] }, 'DATA_GET', { deadline });
      if (Object.keys(collection.data).length < collection.modules.size) {
        const wait = Math.max(0, Math.min(deadline, this.now() + DATA_SETTLE_MS) - this.now());
        const timeout = new Promise((resolve) => {
          handle = this.timers.setTimeout(resolve, wait);
        });
        await Promise.race([complete, timeout]);
      }
    } finally {
      this.timers.clearTimeout(handle);
      this.collections.delete(collection);
    }
    if (collection.failed) throw collection.failed;
    if (!('system' in collection.data)) {
      throw new BridgeError(CODES.TIMEOUT, 'no system data in time');
    }
    return collection.data;
  }

  /** Send a command; resolves once System Bridge answered `answer`. */
  command(event, data, answer, options = {}) {
    return this.request(event, data, answer, options);
  }

  #message(text) {
    if (this.pending.size === 0 && this.collections.size === 0) {
      // Nothing asked: a server that floods is cut off (the next reading reconnects).
      this.unsolicited.messages += 1;
      this.unsolicited.bytes += text.length;
      if (
        this.unsolicited.messages > LIMITS.UNSOLICITED_MESSAGES ||
        this.unsolicited.bytes > LIMITS.UNSOLICITED_BYTES
      ) {
        this.unsolicited = { messages: 0, bytes: 0 };
        this.disconnect();
        return;
      }
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return; // Not JSON: ignored (System Bridge only sends JSON).
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const type = typeof message.type === 'string' ? message.type : null;
    const id = typeof message.id === 'string' ? message.id : null;
    // Only a plain constant name is kept (it ends up in a status and an error).
    const subtype =
      typeof message.subtype === 'string' && /^[A-Z_]{1,40}$/.test(message.subtype)
        ? message.subtype
        : null;
    if (type === 'DATA_UPDATE') {
      const module = typeof message.module === 'string' ? message.module : null;
      for (const collection of this.collections) {
        if (!module || !collection.modules.has(module)) continue;
        // null: the PC has nothing for this module (a desktop without GPU): received all the same.
        if (message.data !== null && typeof message.data !== 'object') continue;
        collection.data[module] = message.data;
        if (Object.keys(collection.data).length >= collection.modules.size) collection.done();
      }
    }
    const entry = id ? this.pending.get(id) : undefined;
    if (type === 'ERROR' && TOKEN_SUBTYPES.includes(subtype)) {
      // The token is refused: every request waiting fails the same way.
      this.#rejectAll(new BridgeError(CODES.BAD_TOKEN, 'token refused', { subtype }));
      return;
    }
    if (!entry) return;
    if (type === entry.answer) {
      entry.resolve({ type, subtype });
    } else if (type === 'ERROR') {
      entry.reject(
        new BridgeError(CODES.REFUSED, `refused (${subtype ?? 'error'})`, {
          subtype: subtype ?? undefined,
          sent: true,
        }),
      );
    }
  }

  #closed(socket, err) {
    if (socket && this.socket !== socket) return;
    this.socket = null;
    this.#rejectAll(err instanceof BridgeError ? err : new BridgeError(CODES.CLOSED, 'closed'));
  }

  #rejectAll(err) {
    for (const entry of [...this.pending.values()]) {
      entry.reject(new BridgeError(err.code, err.message, { subtype: err.subtype }));
    }
    for (const collection of this.collections) {
      collection.failed ??= err;
      collection.done();
    }
  }
}
