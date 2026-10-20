// -----------------------------------------------------------------------------
// A minimal WebSocket client (RFC 6455) on node:http, the only network access
// of the integration. Written here rather than taken from a library so that
// every limit is ours: the upgrade answer is checked (101 and the accept key),
// a message larger than `maxMessageBytes` closes the connection before it is
// buffered, frames from the server must not be masked, control frames are
// small, the text must be valid UTF-8, and the bytes are copied once (a queue
// of chunks, no concatenation of the whole buffer on every chunk).
//
// Text frames only: System Bridge speaks JSON. No extension, no compression
// (none is offered), no subprotocol. No custom User-Agent.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { TIMEOUTS } from '../constants.js';
import { BridgeError, CODES } from './errors.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Frames one message may be split into (empty continuations included). */
export const MAX_FRAGMENTS = 1_024;
/** Pings answered in a row without a message in between: beyond, the connection is closed. */
export const MAX_PINGS_IN_A_ROW = 100;
/** A pong is written only while less than this waits in the socket (a peer that does not read). */
export const MAX_PENDING_WRITE_BYTES = 64 * 1024;
const OPCODES = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

/** Retry-After in ms (seconds or an HTTP date), or undefined. */
export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  if (/^\d{1,9}$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * Open a WebSocket. Resolves with a WebSocketConnection once the upgrade is
 * accepted; rejects with a BridgeError (never holding what the server sent).
 *
 * @param {object} options
 * @param {string} options.hostname
 * @param {number} options.port
 * @param {string} options.path
 * @param {number} options.timeoutMs connection + upgrade
 * @param {number} options.maxMessageBytes
 * @param {(text: string) => void} options.onMessage
 * @param {(err: BridgeError) => void} options.onClose once, whatever the cause
 * @param {Function} [options.request] node:http request (tests)
 */
export function openWebSocket({
  hostname,
  port,
  path,
  timeoutMs,
  maxMessageBytes,
  onMessage,
  onClose,
  request = httpRequest,
}) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      reject(err);
    };
    const req = request({
      hostname,
      port,
      path,
      method: 'GET',
      agent: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    });
    const timer = setTimeout(
      () => fail(new BridgeError(CODES.TIMEOUT, 'no WebSocket upgrade in time')),
      timeoutMs,
    );
    req.on('error', (err) => {
      const code = UNREACHABLE_CODES.has(err?.code) ? CODES.UNREACHABLE : CODES.BAD_ANSWER;
      fail(new BridgeError(code, `connection failed (${String(err?.code ?? 'error')})`));
    });
    req.on('response', (res) => {
      // Not an upgrade: only the status and Retry-After are read, never the body.
      const status = res.statusCode;
      const wait = retryAfterMs(res.headers['retry-after']);
      res.destroy();
      if (status === 101) {
        // A 101 without `Connection: Upgrade`: not a valid upgrade.
        fail(new BridgeError(CODES.BAD_ANSWER, 'not a valid WebSocket upgrade'));
        return;
      }
      fail(
        new BridgeError(CODES.HTTP, `HTTP ${status} instead of a WebSocket`, {
          status,
          retryAfterMs: wait,
        }),
      );
    });
    req.on('upgrade', (res, socket, head) => {
      if (settled) {
        socket.destroy();
        return;
      }
      const upgrade = String(res.headers.upgrade ?? '').toLowerCase();
      const connection = String(res.headers.connection ?? '')
        .toLowerCase()
        .split(',')
        .map((token) => token.trim());
      if (
        res.statusCode !== 101 ||
        upgrade !== 'websocket' ||
        !connection.includes('upgrade') ||
        res.headers['sec-websocket-accept'] !== accept ||
        res.headers['sec-websocket-extensions'] !== undefined ||
        res.headers['sec-websocket-protocol'] !== undefined
      ) {
        socket.destroy();
        fail(new BridgeError(CODES.BAD_ANSWER, 'not a valid WebSocket upgrade'));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(new WebSocketConnection(socket, head, { maxMessageBytes, onMessage, onClose }));
    });
    req.end();
  });
}

export class WebSocketConnection {
  #socket;
  /** The bytes received and not parsed yet: chunks from #head, the first one from #offset. */
  #chunks = [];
  #head = 0;
  #offset = 0;
  #buffered = 0;
  #fragments = null;
  #fragmentBytes = 0;
  #pongPending = false;
  #pingsInARow = 0;
  #closeTimer = null;
  #finished = false;
  #decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(socket, head, { maxMessageBytes, onMessage, onClose }) {
    this.#socket = socket;
    this.maxMessageBytes = maxMessageBytes;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.open = true;
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => this.#receive(chunk));
    socket.on('error', (err) =>
      this.#finish(
        new BridgeError(CODES.CLOSED, `connection lost (${String(err?.code ?? 'error')})`),
      ),
    );
    socket.on('close', () => this.#finish(new BridgeError(CODES.CLOSED, 'connection closed')));
    if (head?.length) this.#receive(head);
  }

  /** Send a text message. Resolves true once written, false when the connection is not open. */
  send(text) {
    if (!this.open) return Promise.resolve(false);
    const frame = this.#frame(OPCODES.TEXT, Buffer.from(text, 'utf8'));
    return new Promise((resolve) => {
      this.#socket.write(frame, (err) => resolve(!err));
    });
  }

  /** Close (normal closure), then destroy the socket if the server does not answer. */
  close() {
    if (!this.open) return;
    this.open = false;
    const code = Buffer.alloc(2);
    code.writeUInt16BE(1000);
    try {
      this.#socket.write(this.#frame(OPCODES.CLOSE, code));
      this.#socket.end();
    } catch {
      // The socket is already gone: destroyed below.
    }
    this.#closeTimer = setTimeout(() => this.#socket.destroy(), TIMEOUTS.CLOSE);
    this.#finish(new BridgeError(CODES.CLOSED, 'connection closed by Gladys'));
  }

  #finish(err) {
    if (this.#finished) return;
    this.#finished = true;
    this.open = false;
    this.#chunks = [];
    this.#head = 0;
    this.#offset = 0;
    this.#buffered = 0;
    this.#fragments = null;
    if (!this.#closeTimer) this.#socket.destroy();
    else this.#socket.once('close', () => clearTimeout(this.#closeTimer));
    try {
      this.onClose?.(err);
    } catch {
      // The owner's handler never breaks the socket handling.
    }
  }

  #fail(code, message) {
    if (this.#finished) return;
    this.open = false;
    this.#socket.destroy();
    this.#finish(new BridgeError(code, message));
  }

  /** A masked client frame (RFC 6455: every client frame is masked). */
  #frame(opcode, payload) {
    const length = payload.length;
    const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
    const header = Buffer.alloc(2 + extra + 4);
    header[0] = 0x80 | opcode;
    if (extra === 0) header[1] = 0x80 | length;
    else if (extra === 2) {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(length, 6);
    }
    const mask = randomBytes(4);
    mask.copy(header, 2 + extra);
    const masked = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
    return Buffer.concat([header, masked]);
  }

  /**
   * Copy the first `n` buffered bytes; `consume` removes them. The queue
   * advances an index (never Array.shift): bytes dripped one per chunk cost
   * a constant time each.
   */
  #read(n, consume) {
    const out = Buffer.allocUnsafe(n);
    let copied = 0;
    let index = this.#head;
    let offset = this.#offset;
    while (copied < n) {
      const chunk = this.#chunks[index];
      const take = Math.min(chunk.length - offset, n - copied);
      chunk.copy(out, copied, offset, offset + take);
      copied += take;
      offset += take;
      if (offset === chunk.length) {
        index += 1;
        offset = 0;
      }
    }
    if (consume) {
      this.#buffered -= n;
      this.#head = index;
      this.#offset = offset;
      // Drop the consumed chunks now and then (amortized, linear overall).
      if (this.#head >= 64 && this.#head * 2 >= this.#chunks.length) {
        this.#chunks = this.#chunks.slice(this.#head);
        this.#head = 0;
      }
    }
    return out;
  }

  #receive(chunk) {
    if (this.#finished) return;
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
    while (!this.#finished && this.#buffered >= 2) {
      const head = this.#read(Math.min(this.#buffered, 10), false);
      const fin = (head[0] & 0x80) !== 0;
      const opcode = head[0] & 0x0f;
      if ((head[0] & 0x70) !== 0) return this.#fail(CODES.BAD_ANSWER, 'reserved bits set');
      if ((head[1] & 0x80) !== 0) return this.#fail(CODES.BAD_ANSWER, 'masked server frame');
      // Binary, reserved or unknown opcodes are refused from the header, before the payload.
      if (![0x0, 0x1, 0x8, 0x9, 0xa].includes(opcode)) {
        return this.#fail(CODES.BAD_ANSWER, 'unexpected frame');
      }
      let length = head[1] & 0x7f;
      let headerLength = 2;
      if (length === 126) {
        if (head.length < 4) return;
        length = head.readUInt16BE(2);
        headerLength = 4;
      } else if (length === 127) {
        if (head.length < 10) return;
        if (head.readUInt32BE(2) !== 0) return this.#fail(CODES.TOO_LARGE, 'message too large');
        length = head.readUInt32BE(6);
        headerLength = 10;
      }
      const control = opcode >= 0x8;
      if (control && (!fin || length > 125)) {
        return this.#fail(CODES.BAD_ANSWER, 'invalid control frame');
      }
      if (!control && this.#fragmentBytes + length > this.maxMessageBytes) {
        return this.#fail(CODES.TOO_LARGE, 'message too large');
      }
      if (opcode === OPCODES.CONTINUATION && !fin && length === 0) {
        return this.#fail(CODES.BAD_ANSWER, 'empty continuation');
      }
      if (opcode === OPCODES.CLOSE && length === 1) {
        return this.#fail(CODES.BAD_ANSWER, 'invalid close frame');
      }
      if (this.#buffered < headerLength + length) return;
      this.#read(headerLength, true);
      const payload = length > 0 ? this.#read(length, true) : Buffer.alloc(0);
      this.#frameReceived(fin, opcode, payload);
    }
  }

  #frameReceived(fin, opcode, payload) {
    switch (opcode) {
      case OPCODES.TEXT:
        if (this.#fragments) return this.#fail(CODES.BAD_ANSWER, 'unexpected text frame');
        if (fin) return this.#deliver(payload);
        this.#fragments = [payload];
        this.#fragmentBytes = payload.length;
        return undefined;
      case OPCODES.CONTINUATION:
        if (!this.#fragments) return this.#fail(CODES.BAD_ANSWER, 'unexpected continuation');
        if (this.#fragments.length >= MAX_FRAGMENTS) {
          return this.#fail(CODES.TOO_LARGE, 'too many fragments');
        }
        this.#fragments.push(payload);
        this.#fragmentBytes += payload.length;
        if (fin) {
          const message = Buffer.concat(this.#fragments, this.#fragmentBytes);
          this.#fragments = null;
          this.#fragmentBytes = 0;
          this.#deliver(message);
        }
        return undefined;
      case OPCODES.PING:
        // A ping flood, or a peer that does not read what we write: closed.
        this.#pingsInARow += 1;
        if (this.#pingsInARow > MAX_PINGS_IN_A_ROW) {
          return this.#fail(CODES.BAD_ANSWER, 'too many pings');
        }
        if ((this.#socket.writableLength ?? 0) > MAX_PENDING_WRITE_BYTES) {
          return this.#fail(CODES.BAD_ANSWER, 'peer does not read');
        }
        // One pong waiting at most: a later ping is answered once it is written.
        if (this.open && !this.#pongPending) {
          this.#pongPending = true;
          this.#socket.write(this.#frame(OPCODES.PONG, payload), () => {
            this.#pongPending = false;
          });
        }
        return undefined;
      case OPCODES.PONG:
        return undefined;
      case OPCODES.CLOSE:
        if (this.open) {
          this.open = false;
          try {
            this.#socket.write(this.#frame(OPCODES.CLOSE, payload.subarray(0, 2)));
            this.#socket.end();
          } catch {
            // Gone already.
          }
        }
        this.#socket.destroy();
        return this.#finish(new BridgeError(CODES.CLOSED, 'connection closed by System Bridge'));
      default:
        // Binary or unknown: System Bridge only sends text.
        return this.#fail(CODES.BAD_ANSWER, 'unexpected frame');
    }
  }

  #deliver(payload) {
    let text;
    try {
      text = this.#decoder.decode(payload);
    } catch {
      return this.#fail(CODES.BAD_ANSWER, 'invalid UTF-8');
    }
    this.#pingsInARow = 0;
    try {
      this.onMessage?.(text);
    } catch {
      // The owner's handler never breaks the frame parsing.
    }
    return undefined;
  }
}
