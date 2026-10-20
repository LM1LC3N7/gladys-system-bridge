// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake PC, through the
// exact wiring of the container (src/handlers.js).
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SystemBridgeApp } from '../src/app.js';
import { BridgeError, CODES } from '../src/bridge/errors.js';
import { parseSnapshot } from '../src/bridge/parse.js';
import { ACTIONS, COMMAND_BUDGET_MS, INTERVALS, STORE_FILE } from '../src/constants.js';
import { buildPcDevice } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import { TOKEN, windowsModules } from './helpers/fakeBridge.js';
import { createFakePc } from './helpers/fakePc.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

const T0 = Date.parse('2026-10-20T08:00:00Z');
const SELECTOR = 'system-bridge';
const ids = createFakeGladys({ selector: SELECTOR });
const UUID = '4c4c4544-0042-3510-8051-b4c04f4a4b32';
const PC = buildPcDevice(ids, parseSnapshot(windowsModules()));
const fid = (key) => `ext:${SELECTOR}:pc:${UUID}:${key}`;
const feature = (key) => PC.features.find((f) => f.external_id === fid(key));
const BASE_CONFIG = { host: '192.168.1.20', token: TOKEN };
const MINUTE = 60_000;

let running;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function setup({ config = {}, created = [PC], pc, dataDir } = {}) {
  const clock = { now: T0 };
  pc ??= createFakePc();
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...BASE_CONFIG, ...config },
    devices: created,
  });
  const timers = createFakeTimers();
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.stack ?? String(a)).join(' ')}`),
    ]),
  );
  dataDir ??= mkdtempSync(join(tmpdir(), 'sb-app-'));
  const app = new SystemBridgeApp({
    gladys,
    logger,
    createClient: pc.createClient,
    dataDir,
    now: () => clock.now,
    timers,
  });
  running = app;
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  return { gladys, pc, timers, clock, logs, app, dataDir };
}

const state = (gladys, key) => gladys.fake.lastState(fid(key));
const press = (gladys, key, value = 1) => gladys.fake.setValue(PC, feature(key), value);

test('start: one device per PC (machine id), its readings, the status, the loop', async () => {
  const { gladys, timers } = await setup();
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => [d.external_id, d.name, d.model]),
    [[`ext:${SELECTOR}:pc:${UUID}`, 'desk', 'Dell Inc. OptiPlex 7090']],
  );
  const keys = gladys.fake.discoveredDevices[0].features.map((f) => f.external_id.split(':').pop());
  assert.deepEqual(keys, [
    'online',
    'cpu_usage',
    'cpu_temperature',
    'memory_usage',
    'memory_used',
    'disk_c',
    'disk_d',
    'gpu_nvidia-0_load',
    'gpu_nvidia-0_temperature',
    'users',
    'uptime',
    'camera_in_use',
    'microphone_in_use',
    'pending_reboot',
    'update_available',
    'lock',
    'sleep',
    'hibernate',
    'restart',
    'shutdown',
    'open_url',
  ]);
  assert.equal(state(gladys, 'online'), 1);
  assert.equal(state(gladys, 'cpu_usage'), 12.3);
  assert.equal(state(gladys, 'cpu_temperature'), 48.5);
  assert.equal(state(gladys, 'memory_usage'), 50);
  assert.equal(state(gladys, 'memory_used'), 8500);
  assert.equal(state(gladys, 'disk_c'), 61.2);
  assert.equal(state(gladys, 'users'), 1);
  assert.equal(state(gladys, 'uptime'), 2);
  assert.equal(state(gladys, 'camera_in_use'), 0);
  assert.equal(state(gladys, 'microphone_in_use'), 1);
  assert.equal(state(gladys, 'battery'), undefined, 'no battery on this PC');
  assert.ok(gladys.fake.states.every((s) => Number.isFinite(s.state)));
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: true,
    message: {
      en: 'System Bridge 5.13.0 answers on desk: CPU 12.3 %, memory 50 %.',
      fr: 'System Bridge 5.13.0 répond sur desk : CPU 12.3 %, mémoire 50 %.',
    },
  });
  assert.ok(gladys.fake.transports.every((t) => t.transport === 'local'));
  assert.deepEqual(timers.delays(), [MINUTE]);
  for (const f of gladys.fake.discoveredDevices[0].features) {
    assert.notEqual(f.category, 'switch', `${f.external_id} is never a switch`);
  }
});

test('a feature seen once is never dropped: a USB disk gone stays on the device', async () => {
  const created = {
    ...PC,
    features: [
      ...PC.features,
      { ...feature('disk_d'), external_id: fid('disk_e'), name: 'Disk E:\\ (%)' },
    ],
  };
  const { gladys } = await setup({ created: [created] });
  const keys = gladys.fake.discoveredDevices[0].features.map((f) => f.external_id);
  assert.ok(keys.includes(fid('disk_e')));
  assert.equal(new Set(keys).size, keys.length, 'no duplicate');
  assert.equal(gladys.fake.lastState(fid('disk_e')), undefined, 'unknown: nothing published');
});

test('the PC off: online 0, unreachable, retried never faster than the interval, up to 5 min', async () => {
  const pc = createFakePc();
  const { gladys, timers, clock } = await setup({ pc });
  pc.fail = new BridgeError(CODES.UNREACHABLE, 'connection failed (EHOSTUNREACH)');
  await timers.run();
  assert.equal(state(gladys, 'online'), 0);
  assert.equal(gladys.fake.transports.at(-1).transport, 'unreachable');
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /off, asleep/);
  assert.deepEqual(timers.delays(), [MINUTE]);
  const delays = [];
  for (let i = 0; i < 5; i += 1) {
    clock.now += timers.delays()[0];
    await timers.run();
    delays.push(timers.delays()[0]);
  }
  assert.deepEqual(delays, [2 * MINUTE, 4 * MINUTE, 5 * MINUTE, 5 * MINUTE, 5 * MINUTE]);
  pc.fail = null;
  clock.now += timers.delays()[0];
  await timers.run();
  assert.equal(state(gladys, 'online'), 1);
  assert.equal(gladys.fake.transports.at(-1).transport, 'local');
  assert.deepEqual(timers.delays(), [MINUTE]);
});

test('a reconnection to Gladys keeps the wait, and republishes the status and Discovery', async () => {
  const pc = createFakePc();
  const { gladys, timers } = await setup({ pc });
  pc.fail = new BridgeError(CODES.TIMEOUT, 'no answer');
  await timers.run();
  const reads = pc.reads.length;
  await gladys.disconnect();
  const statuses = gladys.fake.connectionStatuses.length;
  await gladys.connect();
  assert.equal(pc.reads.length, reads, 'no reading before the end of the wait');
  assert.ok(gladys.fake.connectionStatuses.length > statuses, 'status republished');
  assert.equal(
    gladys.fake.discoveredDevices.length,
    1,
    'Discovery republished from the last reading',
  );
  assert.deepEqual(timers.delays(), [MINUTE]);
});

test('a refused token: stops, kept in /data (no token), tried again alone only after 6 h', async () => {
  const pc = createFakePc();
  pc.fail = new BridgeError(CODES.BAD_TOKEN, 'token refused');
  const { gladys, timers, dataDir, clock, logs } = await setup({ pc });
  assert.match(gladys.fake.connectionStatus.message.en, /refused the token/);
  assert.deepEqual(timers.delays(), [INTERVALS.REFUSED_RETRY_MS]);
  const file = readFileSync(join(dataDir, STORE_FILE), 'utf8');
  assert.ok(!file.includes(TOKEN), 'the token is never written');
  assert.equal(pc.reads.length, 1);

  // A restart of the container, same values: nothing sent.
  await running.stop();
  const again = await setup({ pc, dataDir });
  assert.equal(pc.reads.length, 1);
  assert.match(again.gladys.fake.connectionStatus.message.en, /refused the token/);
  // 6 h later: one try.
  again.clock.now += INTERVALS.REFUSED_RETRY_MS;
  await again.timers.run();
  assert.equal(pc.reads.length, 2);
  // Saved configuration: tried at once, and it works.
  pc.fail = null;
  await again.gladys.fake.configUpdated({ ...BASE_CONFIG });
  assert.equal(pc.reads.length, 3);
  assert.equal(again.gladys.fake.connectionStatus.connected, true);
  assert.ok(![...logs, ...again.logs].some((line) => line.includes(TOKEN)), 'token never logged');
  void clock;
});

test('HTTP 429 on the upgrade: a pause kept in /data across a restart, lifted by the test button', async () => {
  const pc = createFakePc();
  const { timers, dataDir, gladys } = await setup({ pc });
  pc.fail = new BridgeError(CODES.HTTP, 'HTTP 429', { status: 429, retryAfterMs: 10 * MINUTE });
  await timers.run();
  assert.match(gladys.fake.connectionStatus.message.en, /slow down/);
  assert.deepEqual(timers.delays(), [10 * MINUTE]);
  await running.stop();
  const reads = pc.reads.length;
  const again = await setup({ pc, dataDir });
  assert.equal(pc.reads.length, reads, 'still paused after a restart');
  pc.fail = null;
  const ack = await again.gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, true);
  assert.match(ack.data.message.en, /Connected: desk, System Bridge 5\.13\.0/);
});

test('the configuration: address, token, https refused', async () => {
  for (const [config, pattern] of [
    [{ host: '' }, /Type the address/],
    [{ host: 'https://pc:9170' }, /does not offer https/],
    [{ host: 'pc/some/path' }, /not valid/],
    [{ token: '' }, /Type the token/],
    [{ token: 'abc\u200bdef' }, /invisible character/],
  ]) {
    const pc = createFakePc();
    const { gladys } = await setup({ pc, config });
    assert.match(gladys.fake.connectionStatus.message.en, pattern);
    assert.equal(pc.reads.length, 0);
    await running.stop();
  }
});

// --- Commands ----------------------------------------------------------------

test('power buttons: refused by default, nothing sent', async () => {
  const { gladys, pc } = await setup();
  for (const key of ['sleep', 'hibernate', 'restart', 'shutdown']) {
    const ack = await press(gladys, key);
    assert.equal(ack.success, false);
    assert.match(ack.error, /are off: allow them first/);
  }
  const open = await press(gladys, 'open_url');
  assert.match(open.error, /Opening a URL is off/);
  assert.deepEqual(pc.sent, []);
});

test('power allowed: the PC read again, then the command; the answer does not wait for the states', async () => {
  const { gladys, pc, timers } = await setup({ config: { allow_power_actions: true } });
  const reads = pc.reads.length;
  const ack = await press(gladys, 'shutdown');
  assert.equal(ack.success, true);
  assert.deepEqual(pc.reads.slice(reads), [['system']], 'a fresh reading of the PC first');
  assert.deepEqual(pc.sent, [{ event: 'POWER_SHUTDOWN', data: {} }]);
  assert.ok(timers.delays().includes(INTERVALS.AFTER_COMMAND_MS), 'read again in a moment');
});

test('the value must be exactly a push; a reading is not a command', async () => {
  const { gladys, pc } = await setup({ config: { allow_power_actions: true } });
  for (const value of [0, '', null, 2, 'sleep']) {
    const ack = await press(gladys, 'sleep', value);
    assert.equal(ack.success, false, String(value));
  }
  const reading = await gladys.fake.setValue(PC, feature('cpu_usage'), 1);
  assert.match(reading.error, /a reading, not a command/);
  assert.deepEqual(pc.sent, []);
});

test('the permission is checked again just before sending', async () => {
  const pc = createFakePc();
  const { gladys, app } = await setup({ pc, config: { allow_power_actions: true } });
  pc.onRead = () => {
    app.config = { ...app.config, allowPower: false };
  };
  const ack = await press(gladys, 'sleep');
  assert.match(ack.error, /are off/);
  assert.deepEqual(pc.sent, []);
});

test('another PC at this address, an unreadable PC, a slow reading: nothing sent', async () => {
  const pc = createFakePc();
  const { gladys, clock } = await setup({ pc, config: { allow_power_actions: true } });
  pc.modules = windowsModules({
    system: { ...windowsModules().system, uuid: 'another-machine' },
  });
  assert.match((await press(gladys, 'restart')).error, /Another PC answers/);
  pc.modules = windowsModules();
  pc.fail = new BridgeError(CODES.TIMEOUT, 'no answer');
  assert.match((await press(gladys, 'restart')).error, /could not be read just before/);
  pc.fail = null;
  pc.onRead = () => {
    clock.now += COMMAND_BUDGET_MS;
  };
  assert.match((await press(gladys, 'restart')).error, /could not be checked in time/);
  assert.deepEqual(pc.sent, []);
});

test('outcomes: sent without confirmation, refused, not sent', async () => {
  const pc = createFakePc();
  const { gladys } = await setup({ pc, config: { allow_power_actions: true } });
  pc.commands = 'silent';
  assert.match(
    (await press(gladys, 'sleep')).error,
    /^Sent to System Bridge, without confirmation/,
  );
  pc.commands = 'refused';
  assert.match((await press(gladys, 'sleep')).error, /System Bridge refused the command/);
  pc.commands = 'notSent';
  assert.match((await press(gladys, 'sleep')).error, /nothing was sent/);
});

test('one power command at a time', async () => {
  const pc = createFakePc();
  const { gladys } = await setup({ pc, config: { allow_power_actions: true } });
  let release;
  pc.onRead = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const first = press(gladys, 'sleep');
  await new Promise((resolve) => setImmediate(resolve));
  pc.onRead = null;
  const second = await press(gladys, 'restart');
  assert.match(second.error, /still waiting for its answer/);
  release();
  assert.equal((await first).success, true);
  assert.deepEqual(
    pc.sent.map((s) => s.event),
    ['POWER_SLEEP'],
  );
});

test('lock: allowed by default, never waits, and cancels an "open the URL" not sent yet', async () => {
  const pc = createFakePc();
  const { gladys } = await setup({
    pc,
    config: { allow_open_url: true, open_url: 'https://gladys.local/dashboard' },
  });
  let release;
  pc.onRead = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const open = press(gladys, 'open_url');
  await new Promise((resolve) => setImmediate(resolve));
  pc.onRead = null;
  const lock = await press(gladys, 'lock');
  assert.equal(lock.success, true);
  release();
  assert.match((await open).error, /Cancelled by a Lock command/);
  assert.deepEqual(pc.sent, [{ event: 'POWER_LOCK', data: {} }]);
  // Then the URL alone: sent with its address only.
  const again = await press(gladys, 'open_url');
  assert.equal(again.success, true);
  assert.deepEqual(pc.sent.at(-1), {
    event: 'OPEN',
    data: { url: 'https://gladys.local/dashboard' },
  });
});

test('open the URL: an address that is not http(s) is never sent', async () => {
  for (const url of [
    'file:///C:/Windows/System32/cmd.exe',
    'C:\\Windows\\notepad.exe',
    'https://u:p@x.y/',
    '',
  ]) {
    const pc = createFakePc();
    const { gladys } = await setup({ pc, config: { allow_open_url: true, open_url: url } });
    const ack = await press(gladys, 'open_url');
    assert.match(ack.error, /missing or not valid/, url);
    assert.deepEqual(pc.sent, []);
    assert.match(gladys.fake.connectionStatus.message.en, /URL to open is missing or not valid/);
    await running.stop();
  }
});

test('a token refused during a command: stops everything', async () => {
  const pc = createFakePc();
  const { gladys, app } = await setup({ pc });
  pc.commands = 'badToken';
  const ack = await press(gladys, 'lock');
  assert.match(ack.error, /refused the token/);
  assert.equal(app.blocked, true);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the token/);
});

test('values: never NaN, undefined nor a string', async () => {
  const pc = createFakePc({
    modules: windowsModules({
      cpu: { usage: 'high', temperature: Number.NaN },
      memory: { virtual: { percent: null, used: -5 } },
    }),
  });
  const { gladys } = await setup({ pc });
  assert.equal(state(gladys, 'cpu_usage'), undefined);
  assert.equal(state(gladys, 'memory_usage'), undefined);
  assert.equal(state(gladys, 'memory_used'), undefined);
  assert.ok(
    gladys.fake.states.every((s) => typeof s.state === 'number' && Number.isFinite(s.state)),
  );
});

test('Discovery button: never a reading faster than the interval; a created device gets its states', async () => {
  const pc = createFakePc();
  const { gladys, clock } = await setup({ pc, created: [] });
  assert.equal(gladys.fake.states.length, 0, 'nothing created yet');
  const reads = pc.reads.length;
  for (let i = 0; i < 5; i += 1) await gladys.fake.scanRequest();
  assert.equal(pc.reads.length, reads, 'the reading of the start is recent: published as is');
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  clock.now += MINUTE;
  await gladys.fake.scanRequest();
  assert.equal(pc.reads.length, reads + 1);
  await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
  assert.equal(state(gladys, 'online'), 1);
});

// --- Review 1 ----------------------------------------------------------------

test('power turned off and saved while a start still reads the PC: refused', async () => {
  const pc = createFakePc();
  const { gladys, app } = await setup({ pc, config: { allow_power_actions: true } });
  let release;
  pc.onRead = (names) =>
    names.length > 1
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
  const restart = app.start(app.rawConfig, { force: true });
  await new Promise((resolve) => setImmediate(resolve));
  const saved = gladys.fake.configUpdated({ ...BASE_CONFIG, allow_power_actions: false });
  await new Promise((resolve) => setImmediate(resolve));
  const ack = await press(gladys, 'shutdown');
  assert.match(ack.error, /are off/);
  pc.onRead = null;
  release();
  await restart;
  await saved;
  assert.deepEqual(pc.sent, []);
});

test('a configuration saved between the check and the send: nothing sent', async () => {
  const pc = createFakePc();
  const { gladys, app } = await setup({ pc, config: { allow_power_actions: true } });
  let restart;
  pc.onRead = (names) => {
    // The user saves (same values) while the PC is read again for the command.
    if (names.length === 1) restart = app.start({ ...BASE_CONFIG, allow_power_actions: true });
  };
  const ack = await press(gladys, 'sleep');
  assert.match(ack.error, /nothing was sent/);
  assert.deepEqual(pc.sent, []);
  pc.onRead = null;
  await restart;
});

test('the URL opened is the one of the last configuration saved', async () => {
  const pc = createFakePc();
  const config = { allow_open_url: true, open_url: 'https://old.example/' };
  const { gladys, app } = await setup({ pc, config });
  let release;
  pc.onRead = (names) =>
    names.length > 1
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
  const restart = app.start(app.rawConfig, { force: true });
  await new Promise((resolve) => setImmediate(resolve));
  const saved = gladys.fake.configUpdated({
    ...BASE_CONFIG,
    ...config,
    open_url: 'https://new.example/',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const ack = await press(gladys, 'open_url');
  assert.equal(ack.success, false);
  pc.onRead = null;
  release();
  await restart;
  await saved;
  assert.deepEqual(pc.sent, []);
  assert.equal((await press(gladys, 'open_url')).success, true);
  assert.deepEqual(pc.sent, [{ event: 'OPEN', data: { url: 'https://new.example/' } }]);
});

test('the connection closed between the check and the send: a verified command is not sent', async () => {
  const pc = createFakePc();
  const { gladys } = await setup({ pc, config: { allow_power_actions: true } });
  pc.afterRead = (names, client) => {
    // The verification reads on the current socket, which then drops.
    if (names.length === 1) client.disconnect();
  };
  const ack = await press(gladys, 'restart');
  assert.match(ack.error, /nothing was sent/);
  assert.deepEqual(pc.sent, []);
});

test('a verified command carries its sendBy and its socket', async () => {
  const pc = createFakePc();
  const { gladys, clock } = await setup({ pc, config: { allow_power_actions: true } });
  const received = clock.now;
  await press(gladys, 'sleep');
  assert.equal(pc.lastOptions.sendBy, received + COMMAND_BUDGET_MS);
  assert.equal(pc.lastOptions.socket, pc.clients.at(-1).socket);
});

test('lock during a 429 pause: nothing sent (no new connection)', async () => {
  const pc = createFakePc();
  const { gladys, timers, app } = await setup({ pc });
  pc.fail = new BridgeError(CODES.HTTP, 'HTTP 429', { status: 429, retryAfterMs: 30 * MINUTE });
  await timers.run();
  assert.equal(app.paused(), true);
  const ack = await press(gladys, 'lock');
  assert.equal(ack.success, false);
  assert.deepEqual(pc.sent, []);
});

test('lock: only the PC read last; a 429 met by a command pauses everything', async () => {
  const other = buildPcDevice(
    ids,
    parseSnapshot(windowsModules({ system: { ...windowsModules().system, uuid: 'old-pc-0001' } })),
  );
  const pc = createFakePc();
  const { gladys, app } = await setup({ pc });
  const ack = await gladys.fake.setValue(
    other,
    other.features.find((f) => f.external_id.endsWith(':lock')),
    1,
  );
  assert.match(ack.error, /Another PC/);
  assert.deepEqual(pc.sent, []);
  pc.commandFail = new BridgeError(CODES.HTTP, 'HTTP 503', { status: 503 });
  await press(gladys, 'lock');
  assert.equal(app.paused(), true);
  assert.match(gladys.fake.connectionStatus.message.en, /slow down/);
});

test('ten locks: one reading afterwards, not ten', async () => {
  const pc = createFakePc();
  const { gladys, timers } = await setup({ pc });
  for (let i = 0; i < 10; i += 1) assert.equal((await press(gladys, 'lock')).success, true);
  const before = pc.reads.length;
  await timers.run((ms) => ms === INTERVALS.AFTER_COMMAND_MS);
  assert.equal(pc.reads.length - before, 1);
});

test('a reconnection to Gladys right after a reading: no new reading, the pace kept', async () => {
  const pc = createFakePc();
  const { gladys, timers, clock } = await setup({ pc });
  const before = pc.reads.length;
  clock.now += 20_000;
  await gladys.disconnect();
  const statuses = gladys.fake.connectionStatuses.length;
  await gladys.connect();
  assert.equal(pc.reads.length, before);
  assert.ok(gladys.fake.connectionStatuses.length > statuses, 'status republished');
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.deepEqual(timers.delays(), [MINUTE - 20_000]);
  clock.now += 40_000;
  await timers.run();
  assert.equal(pc.reads.length, before + 1);
});
