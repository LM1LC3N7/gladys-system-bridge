// -----------------------------------------------------------------------------
// Hostile System Bridge (review 1): frames that would grow the memory or the
// CPU without bound, a slow handshake that would make a command leave late,
// odd upgrade answers, floods. A fake socket for the frame parser, the fake
// System Bridge on loopback for the rest.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BridgeClient } from '../src/bridge/client.js';
import { CODES } from '../src/bridge/errors.js';
import {
  MAX_FRAGMENTS,
  MAX_PINGS_IN_A_ROW,
  WebSocketConnection,
  openWebSocket,
} from '../src/bridge/ws.js';
import { COMMAND_BUDGET_MS, LIMITS } from '../src/constants.js';
import { TOKEN, rawFrame, startFakeBridge, textFrame } from './helpers/fakeBridge.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A socket whose peer never reads: write() never completes. */
function deafSocket() {
  const socket = new EventEmitter();
  socket.writes = 0;
  socket.writableLength = 0;
  socket.write = (buffer) => {
    socket.writes += 1;
    socket.writableLength += buffer.length;
    return false;
  };
  socket.end = () => {};
  socket.destroy = () => {
    socket.destroyed = true;
  };
  return socket;
}

function connection(maxMessageBytes = 4 * 1024 * 1024) {
  const socket = deafSocket();
  const state = { messages: [], closed: null };
  new WebSocketConnection(socket, Buffer.alloc(0), {
    maxMessageBytes,
    onMessage: (text) => state.messages.push(text),
    onClose: (err) => {
      state.closed = err;
    },
  });
  return { socket, state };
}

test('empty continuation frames: refused at once', () => {
  const { socket, state } = connection();
  socket.emit('data', Buffer.from([0x01, 0x01, 0x61])); // TEXT, not final, "a"
  socket.emit('data', Buffer.alloc(2 * 32_768)); // continuations of length 0, not final
  assert.equal(state.closed?.code, CODES.BAD_ANSWER);
  assert.equal(state.messages.length, 0);
});

test('a message in more than 1024 frames: closed', () => {
  const { socket, state } = connection();
  socket.emit('data', Buffer.from([0x01, 0x01, 0x61]));
  const one = Buffer.from([0x00, 0x01, 0x62]); // continuation, not final, "b"
  socket.emit('data', Buffer.concat(Array.from({ length: MAX_FRAGMENTS + 5 }, () => one)));
  assert.equal(state.closed?.code, CODES.TOO_LARGE);
});

test('a ping flood toward a peer that does not read: one pong queued, then closed', () => {
  const { socket, state } = connection();
  const pings = Buffer.alloc(2 * 1_000);
  for (let i = 0; i < pings.length; i += 2) pings[i] = 0x89;
  socket.emit('data', pings);
  assert.equal(socket.writes, 1, 'a single pong waiting');
  assert.equal(state.closed?.code, CODES.BAD_ANSWER);
  // Pings answered in a row are bounded even when the pongs are written.
  const { socket: other, state: otherState } = connection();
  other.write = (buffer, done) => {
    other.writes += 1;
    done?.();
    return true;
  };
  other.emit('data', pings.subarray(0, 2 * (MAX_PINGS_IN_A_ROW + 1)));
  assert.equal(otherState.closed?.code, CODES.BAD_ANSWER);
  assert.equal(other.writes, MAX_PINGS_IN_A_ROW);
});

test('a frame dripped one byte per chunk is parsed in linear time', () => {
  const { socket, state } = connection();
  const payload = Buffer.from(`"${'x'.repeat(199_998)}"`);
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeUInt32BE(payload.length, 6);
  const bytes = Buffer.concat([header, payload]);
  const started = process.hrtime.bigint();
  for (let i = 0; i < bytes.length; i += 1) socket.emit('data', bytes.subarray(i, i + 1));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].length, 200_000);
  assert.ok(ms < 1_500, `${ms} ms`);
});

test('a 4 MiB frame in 1 M one-byte chunks: no chunk kept, the payload allocated once', () => {
  const socket = deafSocket();
  const state = { messages: [], closed: null };
  const ws = new WebSocketConnection(socket, Buffer.alloc(0), {
    maxMessageBytes: 4 * 1024 * 1024,
    onMessage: (text) => state.messages.push(text),
    onClose: (err) => {
      state.closed = err;
    },
  });
  const length = 4 * 1024 * 1024;
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeUInt32BE(length, 6);
  const payload = Buffer.alloc(length, 0x78); // "xxx..."
  payload[0] = 0x22;
  payload[length - 1] = 0x22;
  const bytes = Buffer.concat([header, payload]);
  const before = process.memoryUsage();
  let maxQueued = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    socket.emit('data', bytes.subarray(i, i + 1));
    if ((i & 0xffff) === 0) maxQueued = Math.max(maxQueued, ws.queuedChunks);
  }
  const after = process.memoryUsage();
  assert.equal(state.closed, null);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].length, length);
  assert.ok(maxQueued <= 10, `${maxQueued} chunks kept`);
  assert.equal(ws.queuedChunks, 0);
  const grown = (after.heapUsed - before.heapUsed) / 1024 / 1024;
  assert.ok(grown < 64, `heap +${grown.toFixed(1)} MiB`);
});

test('reserved and binary opcodes are refused from the header; a 1-byte close too', () => {
  for (const bytes of [
    Buffer.from([0x83, 0x05]), // opcode 3, payload not even received
    Buffer.from([0x82, 0x7d]), // binary, 125 bytes announced
    Buffer.from([0x88, 0x01, 0x00]), // close with 1 byte
  ]) {
    const { socket, state } = connection(1024);
    socket.emit('data', bytes);
    assert.equal(state.closed?.code, CODES.BAD_ANSWER, bytes.toString('hex'));
  }
});

// --- On loopback ---------------------------------------------------------------

let fake;
let client;
afterEach(async () => {
  client?.dispose();
  client = undefined;
  await fake?.close();
  fake = undefined;
});

test('a command is never written after its sendBy, even when the opening ends later', async () => {
  fake = await startFakeBridge();
  client = new BridgeClient({ address: fake.address, token: TOKEN });
  fake.handshakeDelayMs = 600;
  const received = Date.now();
  // The loop opens first (its own, longer deadline)...
  const reading = client.getData(['system'], { deadline: Date.now() + 5_000 });
  await wait(20);
  // ...then a command that must leave within 300 ms shares that opening.
  await assert.rejects(
    client.command('POWER_LOCK', {}, 'POWER_LOCKING', {
      deadline: received + 500,
      sendBy: received + 300,
    }),
    { code: CODES.TIMEOUT, sent: false },
  );
  await reading;
  await wait(100);
  assert.deepEqual(
    fake.received.map((r) => r.event),
    ['GET_DATA'],
    'POWER_LOCK never reached the PC',
  );
  assert.ok(COMMAND_BUDGET_MS > 0);
});

test('a command bound to a socket is never written on another one', async () => {
  fake = await startFakeBridge();
  client = new BridgeClient({ address: fake.address, token: TOKEN });
  await client.getData(['system'], { deadline: Date.now() + 2_000 });
  const verified = client.currentSocket();
  for (const socket of fake.sockets) socket.destroy();
  await wait(50);
  await client.getData(['system'], { deadline: Date.now() + 2_000 }); // a new connection
  await assert.rejects(
    client.command('POWER_SHUTDOWN', {}, 'POWER_SHUTTINGDOWN', {
      deadline: Date.now() + 1_000,
      socket: verified,
    }),
    { code: CODES.CLOSED, sent: false },
  );
  assert.ok(!fake.received.some((r) => r.event === 'POWER_SHUTDOWN'));
});

test('the upgrade: Connection: Upgrade required, no subprotocol accepted', async () => {
  for (const handshake of ['noConnection', 'protocol']) {
    fake = await startFakeBridge({ handshake });
    client = new BridgeClient({ address: fake.address, token: TOKEN });
    await assert.rejects(client.getData(['system'], { deadline: Date.now() + 2_000 }), {
      code: CODES.BAD_ANSWER,
    });
    client.dispose();
    await fake.close();
    fake = undefined;
  }
});

test('a module answered with null counts as received (no 5 s wait)', async () => {
  fake = await startFakeBridge();
  fake.modules = { ...fake.modules, gpus: null };
  client = new BridgeClient({ address: fake.address, token: TOKEN });
  const started = Date.now();
  const data = await client.getData(['system', 'gpus'], { deadline: Date.now() + 8_000 });
  assert.equal(data.gpus, null);
  assert.ok(Date.now() - started < 1_000);
});

test('an odd error subtype is never repeated as is', async () => {
  fake = await startFakeBridge();
  client = new BridgeClient({ address: fake.address, token: TOKEN });
  await client.getData(['system'], { deadline: Date.now() + 2_000 });
  fake.commands = 'silent';
  const pending = client.command('POWER_SLEEP', {}, 'POWER_SLEEPING', {
    deadline: Date.now() + 1_000,
  });
  await wait(50);
  const id = [...client.pending.keys()][0];
  fake.raw(
    textFrame(
      JSON.stringify({
        id,
        type: 'ERROR',
        subtype: '<script>alert(1)</script> visit evil.example',
      }),
    ),
  );
  const err = await pending.catch((e) => e);
  assert.equal(err.code, CODES.REFUSED);
  assert.equal(err.subtype, undefined);
  assert.equal(err.message, 'refused (error)');
});

test('messages nobody asked for: past the limit, the socket is closed', async () => {
  fake = await startFakeBridge();
  client = new BridgeClient({ address: fake.address, token: TOKEN });
  await client.getData(['system'], { deadline: Date.now() + 2_000 });
  const flood = textFrame(
    JSON.stringify({ id: 'system', type: 'DATA_UPDATE', module: 'cpu', data: {} }),
  );
  fake.raw(Buffer.concat(Array.from({ length: LIMITS.UNSOLICITED_MESSAGES + 5 }, () => flood)));
  await wait(100);
  assert.equal(client.currentSocket(), null);
  // The next reading opens a new connection.
  const data = await client.getData(['system'], { deadline: Date.now() + 2_000 });
  assert.equal(data.system.hostname, 'desk');
});

test('a ping from the real server path is answered once written', async () => {
  fake = await startFakeBridge();
  const socket = await openWebSocket({
    ...fake.address,
    path: '/api/websocket',
    timeoutMs: 2_000,
    maxMessageBytes: 1024,
    onMessage: () => {},
    onClose: () => {},
  });
  await wait(30);
  fake.raw(Buffer.concat([rawFrame(0x9, Buffer.from('a')), rawFrame(0x9, Buffer.from('b'))]));
  await wait(50);
  fake.raw(rawFrame(0x9, Buffer.from('c')));
  await wait(50);
  assert.ok(fake.pongs >= 2);
  socket.close();
});
