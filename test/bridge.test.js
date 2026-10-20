// -----------------------------------------------------------------------------
// The WebSocket client and the System Bridge client against a fake System
// Bridge on loopback (real sockets, real framing). No other network.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { inspect } from 'node:util';
import { BridgeClient } from '../src/bridge/client.js';
import { CODES } from '../src/bridge/errors.js';
import { openWebSocket, retryAfterMs } from '../src/bridge/ws.js';
import { MODULES } from '../src/constants.js';
import { TOKEN, rawFrame, startFakeBridge, textFrame } from './helpers/fakeBridge.js';

let fake;
let client;
afterEach(async () => {
  client?.dispose();
  client = undefined;
  await fake?.close();
  fake = undefined;
});

const soon = (ms = 3_000) => Date.now() + ms;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(options = {}, token = TOKEN) {
  fake = await startFakeBridge(options);
  client = new BridgeClient({ address: fake.address, token });
  return { fake, client };
}

test('getData: GET_DATA, then one DATA_UPDATE per module; the frames are masked', async () => {
  await setup();
  const data = await client.getData(MODULES, { deadline: soon() });
  assert.deepEqual(Object.keys(data).sort(), [...MODULES].sort());
  assert.equal(data.system.hostname, 'desk');
  assert.deepEqual(
    fake.received.map((r) => [r.event, r.tokenOk]),
    [['GET_DATA', true]],
  );
  assert.deepEqual(fake.received[0].data, { modules: [...MODULES] });
  assert.equal(fake.unmasked, undefined, 'every client frame is masked');
  // The socket is kept: a second reading uses it.
  await client.getData(['system'], { deadline: soon() });
  assert.equal(fake.sockets.size, 1);
});

test('a module System Bridge does not have is left out; without system: TIMEOUT', async () => {
  const { gpus: _gpus, ...modules } = (await import('./helpers/fakeBridge.js')).windowsModules();
  await setup({ modules });
  const started = Date.now();
  const data = await client.getData(['system', 'gpus'], { deadline: Date.now() + 1_000 });
  assert.ok(data.system);
  assert.equal(data.gpus, undefined);
  assert.ok(Date.now() - started < 2_000);
  fake.modules = {};
  await assert.rejects(client.getData(['system'], { deadline: Date.now() + 500 }), {
    code: CODES.TIMEOUT,
  });
});

test('a wrong token: BAD_TOKEN, and the token is in no error message', async () => {
  await setup({}, 'wrong-token-value');
  const err = await client.getData(['system'], { deadline: soon() }).catch((e) => e);
  assert.equal(err.code, CODES.BAD_TOKEN);
  assert.ok(!err.message.includes('wrong-token-value'));
  assert.ok(!inspect(client, { depth: 1 }).includes('wrong-token-value'), 'token not printed');
  assert.ok(!Object.keys(client).includes('token'));
});

test('commands: the answer of System Bridge, its refusal, its silence', async () => {
  await setup();
  let sent = false;
  await client.command('POWER_LOCK', {}, 'POWER_LOCKING', {
    deadline: soon(),
    onSent: () => {
      sent = true;
    },
  });
  assert.ok(sent);
  fake.commands = 'error';
  await assert.rejects(client.command('POWER_SLEEP', {}, 'POWER_SLEEPING', { deadline: soon() }), {
    code: CODES.REFUSED,
    sent: true,
  });
  fake.commands = 'silent';
  await assert.rejects(
    client.command('POWER_SLEEP', {}, 'POWER_SLEEPING', { deadline: Date.now() + 300 }),
    { code: CODES.TIMEOUT, sent: true },
  );
});

test('fragments are joined, a ping is answered', async () => {
  await setup();
  const received = [];
  const socket = await openWebSocket({
    ...fake.address,
    path: '/api/websocket',
    timeoutMs: 2_000,
    maxMessageBytes: 1024,
    onMessage: (text) => received.push(text),
    onClose: () => {},
  });
  await wait(50);
  fake.raw(Buffer.concat([textFrame('{"a":', { fin: false }), rawFrame(0x9, Buffer.from('hi'))]));
  fake.raw(rawFrame(0x0, Buffer.from('1}')));
  await wait(100);
  assert.deepEqual(received, ['{"a":1}']);
  assert.equal(fake.pongs, 1);
  socket.close();
});

test('a message larger than allowed closes the connection before it is buffered', async () => {
  await setup();
  let closed;
  await openWebSocket({
    ...fake.address,
    path: '/api/websocket',
    timeoutMs: 2_000,
    maxMessageBytes: 1024,
    onMessage: () => assert.fail('never delivered'),
    onClose: (err) => {
      closed = err;
    },
  });
  await wait(50);
  // Only the header announcing 10 MB is sent.
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeUInt32BE(10 * 1024 * 1024, 6);
  fake.raw(header);
  await wait(100);
  assert.equal(closed?.code, CODES.TOO_LARGE);
});

test('protocol errors: a masked server frame, invalid UTF-8, a binary frame', async () => {
  for (const bytes of [
    Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0, 0]),
    rawFrame(0x1, Buffer.from([0xff, 0xfe])),
    rawFrame(0x2, Buffer.from('x')),
  ]) {
    await setup();
    let closed;
    await openWebSocket({
      ...fake.address,
      path: '/api/websocket',
      timeoutMs: 2_000,
      maxMessageBytes: 1024,
      onMessage: () => assert.fail('never delivered'),
      onClose: (err) => {
        closed = err;
      },
    });
    await wait(50);
    fake.raw(bytes);
    await wait(100);
    assert.equal(closed?.code, CODES.BAD_ANSWER);
    await fake.close();
    fake = undefined;
  }
});

test('the upgrade: HTTP 429 with Retry-After, a wrong accept key, nobody listening', async () => {
  await setup({ handshake: 'http429' });
  await assert.rejects(client.getData(['system'], { deadline: soon() }), {
    code: CODES.HTTP,
    status: 429,
    retryAfterMs: 120_000,
  });
  fake.handshake = 'badAccept';
  await assert.rejects(client.getData(['system'], { deadline: soon() }), {
    code: CODES.BAD_ANSWER,
  });
  // A port nobody listens on.
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const lonely = new BridgeClient({ address: { hostname: '127.0.0.1', port }, token: TOKEN });
  await assert.rejects(lonely.getData(['system'], { deadline: soon() }), {
    code: CODES.UNREACHABLE,
  });
  lonely.dispose();
});

test('the connection closed by System Bridge: waiting requests fail, the next one reopens', async () => {
  await setup({ commands: 'silent' });
  await client.getData(['system'], { deadline: soon() });
  const pending = client.command('POWER_SLEEP', {}, 'POWER_SLEEPING', { deadline: soon() });
  await wait(50);
  for (const socket of fake.sockets) socket.destroy();
  await assert.rejects(pending, { code: CODES.CLOSED, sent: true });
  const data = await client.getData(['system'], { deadline: soon() });
  assert.equal(data.system.hostname, 'desk');
});

test('a disposed client sends nothing', async () => {
  await setup();
  client.dispose();
  await assert.rejects(client.getData(['system'], { deadline: soon() }), { code: CODES.CLOSED });
  assert.equal(fake.received.length, 0);
});

test('Retry-After: seconds, a date, garbage', () => {
  assert.equal(retryAfterMs('30'), 30_000);
  assert.equal(
    retryAfterMs(new Date(Date.UTC(2026, 0, 1, 0, 1)).toUTCString(), Date.UTC(2026, 0, 1)),
    60_000,
  );
  assert.equal(retryAfterMs('soon'), undefined);
  assert.equal(retryAfterMs(undefined), undefined);
});
