// -----------------------------------------------------------------------------
// SystemBridgeApp: the integration. One PC running System Bridge.
//
//   start(config)  (re)connects: the PC read, Discovery published, loop started
//   reading loop   every `refresh_interval` s: system, CPU, memory, disks,
//                  battery, GPUs -> the states of the created device; while
//                  the PC does not answer (off, asleep), `online` = 0 and a
//                  retry 30 s to 5 min, never faster than the interval
//                  (HTTP 429 / 503 on the upgrade: a pause of 1 min to 6 h,
//                  Retry-After honoured, kept in /data)
//   setValue       the buttons, see "Commands" below
//
// The loop is one chain of timers: halt() bumps an epoch, and a run of an
// older epoch never schedules itself again. A token System Bridge refused
// (BAD_TOKEN) stops everything: a salted HMAC of the address and token is
// kept in /data, and the same values are tried again alone only once, 6 h
// later; saving the configuration or "Test the connection" tries at once.
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { BridgeClient } from './bridge/client.js';
import { BridgeError, CODES, isTokenRefused } from './bridge/errors.js';
import { parseSnapshot } from './bridge/parse.js';
import { normalizeConfig } from './config.js';
import {
  COMMAND_ACK_MS,
  COMMAND_BUDGET_MS,
  COMMAND_MIN_READ_MS,
  COMMAND_MIN_SEND_MS,
  COMMANDS,
  FEATURES,
  INTERVALS,
  MODULES,
  STORE_FILE,
  TIMEOUTS,
} from './constants.js';
import {
  buildPcDevice,
  createdPcs,
  featuresOf,
  parseExternalId,
  pcIds,
  valuesOf,
} from './devices.js';
import { T } from './i18n.js';
import { Store } from './store.js';

/** The "Test the connection" button waits 30 s: answer before. */
const TEST_BUDGET_MS = 25_000;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class SystemBridgeApp {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {object} [options.logger]
   * @param {(options: object) => BridgeClient} [options.createClient] (tests inject a fake PC)
   * @param {string} [options.dataDir] the writable volume
   * @param {() => number} [options.now]
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'system-bridge' }),
    createClient = (options) => new BridgeClient(options),
    dataDir = process.env.DATA_DIR ?? '/data',
    now = Date.now,
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.createClient = createClient;
    this.now = now;
    this.timers = timers;
    this.store = new Store({ filePath: join(dataDir, STORE_FILE), logger });
    this.rawConfig = {};
    this.config = normalizeConfig();
    this.client = null;
    this.generation = 0;
    this.epoch = 0;
    this.handles = new Set();
    this.queue = Promise.resolve();
    /** The power or open command waiting for its answer (one at a time). */
    this.inFlight = null;
    /**
     * The wait after a failed reading (not a 429: that pause is in the
     * store), kept across a reconnection to Gladys (reset()) for the same
     * address and token: { identity, nextReadAt, retryDelay, message }.
     */
    this.retry = null;
    /** The last snapshot read: kept across a reconnection to Gladys. */
    this.snapshot = null;
    /** When it was read, for which address and token: { identity, at }. */
    this.lastRead = null;
    /** The configuration last given to start() (saved), and its serial number. */
    this.latestConfig = this.config;
    this.configSerial = 0;
    this.refreshPending = false;
    this.reset();
  }

  reset() {
    // Gladys keeps the status and the Discovery list in memory only: after a
    // restart of the core (a new `connected`), both are published again.
    this.lastStatus = null;
    this.discoveredKey = null;
    this.transports = new Map();
    this.online = false;
    this.blocked = false;
    this.pausedUntil = 0;
    this.retryDelay = this.minRetry();
  }

  /** A failed reading is never retried faster than the interval. */
  minRetry() {
    return Math.max(INTERVALS.RETRY_MIN_MS, this.config.refreshMs);
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Run `task` after every start / restart already queued. */
  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * (Re)start with a configuration. Calls are serialized. `force`: the user
   * asked (button, saved configuration): a token refused earlier is tried,
   * and a pause or a wait is skipped.
   */
  start(rawConfig, { force = false } = {}) {
    // Known at once, before the queue: a command arriving while an older
    // start still reads the PC is checked against this configuration too.
    this.latestConfig = normalizeConfig(rawConfig);
    this.configSerial += 1;
    return this.enqueue(() => this.run(rawConfig, { force }));
  }

  async stop() {
    this.generation += 1;
    this.halt();
    this.dropClient();
  }

  /** Clear every timer; the runs still in flight will not schedule again. */
  halt() {
    this.epoch += 1;
    for (const handle of this.handles) this.timers.clearTimeout(handle);
    this.handles.clear();
    this.refreshPending = false;
  }

  dropClient() {
    this.client?.dispose();
    this.client = null;
  }

  /** The values a refusal is about (HMAC with the salt of /data: never the token). */
  async refusalKey(config) {
    return createHmac('sha256', await this.store.salt())
      .update(JSON.stringify([config.address.label, config.token]))
      .digest('hex');
  }

  /** What a wait is about: the address and the token (kept in memory only). */
  identity() {
    return JSON.stringify([this.config.address?.label, this.config.token]);
  }

  pauseKey() {
    return `pausedUntil|${this.config.address?.label}`;
  }

  async run(rawConfig, { force = false } = {}) {
    this.halt();
    this.dropClient();
    const generation = ++this.generation;
    this.rawConfig = rawConfig ?? {};
    const config = normalizeConfig(rawConfig);
    const sameTarget = JSON.stringify([config.address?.label, config.token]) === this.identity();
    this.config = config;
    if (!sameTarget) {
      this.snapshot = null;
      this.retry = null;
      this.lastRead = null;
    }
    this.reset();
    await this.store.load();

    if (config.addressError) {
      const message = { empty: T.status.addressEmpty, tls: T.status.addressTls }[
        config.addressError
      ];
      await this.setStatus(false, message ?? T.status.addressInvalid);
      return;
    }
    if (!config.token) {
      await this.setStatus(false, T.status.missingToken);
      return;
    }
    if (config.tokenInvalid) {
      await this.setStatus(false, T.status.tokenInvalid);
      return;
    }
    // A token refused with these very values is tried again alone only once, later.
    const label = config.address.label;
    const [refusedKey, retryAt] = String(this.store.get('refusals', label) ?? '').split('|');
    if (refusedKey && !force && refusedKey === (await this.refusalKey(config))) {
      const wait = Number(retryAt) - this.now();
      if (wait > 0) {
        this.blocked = true;
        this.logger.warn('Token refused earlier by System Bridge: not sent again before the delay');
        await this.setStatus(false, T.status.tokenRefused(wait));
        await this.publishDiscovered();
        this.schedule(Math.min(wait, INTERVALS.REFUSED_RETRY_MS), () =>
          this.enqueue(() => this.run(this.rawConfig)),
        );
        return;
      }
    }
    if (refusedKey && (force || refusedKey !== (await this.refusalKey(config)))) {
      await this.store.set('refusals', label, null);
    }
    this.client = this.createClient({ address: config.address, token: config.token });
    this.logger.info(`Using System Bridge at ${label}`);
    // An HTTP 429 / 503 pause outlives a restart and a reconnection to
    // Gladys; only the user lifts it (button, saved configuration).
    const pausedUntil = Math.min(
      Number(this.store.get('meta', this.pauseKey())) || 0,
      this.now() + INTERVALS.BUSY_MAX_MS,
    );
    if (force && pausedUntil) await this.store.set('meta', this.pauseKey(), null);
    if (!force && this.now() < pausedUntil) {
      this.pausedUntil = pausedUntil;
      const delay = pausedUntil - this.now();
      await this.setStatus(false, T.status.busy(delay));
      await this.publishOffline();
      await this.publishDiscovered();
      this.schedule(delay, () => this.connect(generation));
      return;
    }
    // A reconnection to Gladys keeps the wait of a failed reading, and its
    // growing delay; only the user skips it.
    const { retry } = this;
    if (!force && retry?.identity === this.identity() && this.now() < retry.nextReadAt) {
      this.retryDelay = retry.retryDelay;
      await this.publishOffline();
      await this.setStatus(false, retry.message);
      await this.publishDiscovered();
      this.schedule(retry.nextReadAt - this.now(), () => this.connect(generation));
      return;
    }
    this.retry = null;
    // A reconnection to Gladys right after a reading: what was read is
    // published again, and the next reading keeps its pace.
    const elapsed = this.lastRead ? this.now() - this.lastRead.at : Infinity;
    if (
      !force &&
      this.snapshot &&
      this.lastRead?.identity === this.identity() &&
      elapsed >= 0 &&
      elapsed < config.refreshMs
    ) {
      this.online = true;
      await this.publishDiscovered();
      await this.publishStates();
      await this.publishTransports();
      await this.setStatus(true, this.okMessage());
      const epoch = this.epoch;
      this.schedule(config.refreshMs - elapsed, () => this.readingLoop(generation, epoch));
      return;
    }
    await this.connect(generation);
  }

  okMessage() {
    const snapshot = this.snapshot;
    return T.status.ok({
      hostname: snapshot?.hostname,
      version: snapshot?.version,
      cpu: snapshot?.cpuUsage,
      memory: snapshot?.memoryUsage,
      openUrlMissing: this.config.allowOpenUrl && !this.config.openUrl,
    });
  }

  schedule(delay, task) {
    const handle = this.timers.setTimeout(async () => {
      this.handles.delete(handle);
      try {
        await task();
      } catch (err) {
        this.logger.error(`Loop failed: ${err?.message}`);
      }
    }, delay);
    this.handles.add(handle);
    return handle;
  }

  /** May a loop of this generation and epoch schedule its next run? */
  current(generation, epoch) {
    return generation === this.generation && epoch === this.epoch && !this.blocked;
  }

  scheduleLoop(generation) {
    const epoch = this.epoch;
    this.schedule(this.config.refreshMs, () => this.readingLoop(generation, epoch));
  }

  /** First reading, then the loop. Never throws. */
  async connect(generation) {
    if (!this.client || generation !== this.generation) return;
    // Another chain started meanwhile (halt() bumped the epoch): this one stops.
    const epoch = this.epoch;
    try {
      await this.read({ publish: true });
    } catch (err) {
      if (this.current(generation, epoch)) await this.failed(err, generation);
      return;
    }
    if (this.current(generation, epoch)) this.scheduleLoop(generation);
  }

  async readingLoop(generation, epoch) {
    if (!this.current(generation, epoch)) return;
    try {
      await this.read({ publish: false });
    } catch (err) {
      if (this.current(generation, epoch)) await this.failed(err, generation);
      return;
    }
    if (this.current(generation, epoch)) this.scheduleLoop(generation);
  }

  /** Read the PC and publish. Throws when the reading fails. */
  async read({ publish }) {
    const client = this.client;
    if (!client) return;
    const modules = await client.getData(MODULES, { deadline: this.now() + TIMEOUTS.READ });
    if (client !== this.client) return;
    const snapshot = parseSnapshot(modules);
    const wasOnline = this.online;
    this.snapshot = snapshot;
    this.lastRead = { identity: this.identity(), at: this.now() };
    this.online = true;
    this.retryDelay = this.minRetry();
    this.retry = null;
    if (!wasOnline) {
      this.logger.info(`System Bridge ${snapshot.version ?? '?'} answers`);
    }
    const discoveredKey = JSON.stringify([snapshot.uuid, featuresOf(snapshot).map(([key]) => key)]);
    if (publish || discoveredKey !== this.discoveredKey) await this.publishDiscovered();
    this.discoveredKey = discoveredKey;
    await this.publishStates();
    await this.publishTransports();
    await this.setStatus(true, this.okMessage());
  }

  /** HTTP 429 / 503: whoever met it (a command, a reading after a command), every path pauses. */
  static isBusy(err) {
    return err?.code === CODES.HTTP && (err.status === 429 || err.status === 503);
  }

  /** A reading failed: refusal, pause, or retry with a growing delay. */
  async failed(err, generation) {
    if (generation !== this.generation) return;
    const wasOnline = this.online;
    this.online = false;
    this.halt();
    this.client?.disconnect();
    await this.publishOffline();
    if (isTokenRefused(err)) {
      this.blocked = true;
      const retryAt = this.now() + INTERVALS.REFUSED_RETRY_MS;
      await this.store.set(
        'refusals',
        this.config.address.label,
        `${await this.refusalKey(this.config)}|${retryAt}`,
      );
      this.logger.warn('System Bridge refused the token: not sent again before 6 h');
      await this.setStatus(false, T.status.tokenRefused(INTERVALS.REFUSED_RETRY_MS));
      this.schedule(INTERVALS.REFUSED_RETRY_MS, () => this.enqueue(() => this.run(this.rawConfig)));
      return;
    }
    let delay;
    let message;
    if (SystemBridgeApp.isBusy(err)) {
      delay = clamp(
        err.retryAfterMs ?? INTERVALS.BUSY_MIN_MS,
        INTERVALS.BUSY_MIN_MS,
        INTERVALS.BUSY_MAX_MS,
      );
      this.pausedUntil = this.now() + delay;
      await this.store.set('meta', this.pauseKey(), String(this.pausedUntil));
      message = T.status.busy(delay);
    } else {
      delay = Math.max(this.retryDelay, this.minRetry());
      this.retryDelay = Math.min(delay * 2, Math.max(INTERVALS.RETRY_MAX_MS, this.minRetry()));
      const offline = err?.code === CODES.UNREACHABLE || err?.code === CODES.TIMEOUT;
      message = offline ? T.status.offline(err, delay) : T.status.notBridge(err, delay);
    }
    if (wasOnline || delay === this.minRetry()) {
      this.logger.warn(
        `System Bridge does not answer: ${err?.code ?? 'error'} ${err?.message ?? ''}`,
      );
    }
    this.retry = {
      identity: this.identity(),
      nextReadAt: this.now() + delay,
      retryDelay: this.retryDelay,
      message,
    };
    await this.setStatus(false, message);
    this.schedule(delay, () => this.connect(generation));
  }

  paused() {
    return this.now() < this.pausedUntil;
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = null;
      this.logger.warn(`Connection status not sent: ${err.message}`);
    });
  }

  // --- Publication -------------------------------------------------------------

  /** The created device of the PC read, if any. */
  createdDevice(uuid) {
    return createdPcs(this.gladys).find((pc) => pc.uuid === uuid)?.device ?? null;
  }

  /** Never throws: a refusal of Gladys is not a System Bridge failure. */
  async publishDiscovered() {
    const devices = this.snapshot
      ? [buildPcDevice(this.gladys, this.snapshot, this.createdDevice(this.snapshot.uuid))]
      : [];
    await this.gladys.publishDiscoveredDevices(devices).catch((err) => {
      this.logger.warn(`Discovery not published: ${err.message}`);
    });
  }

  /** Discovery (scan button): read again when connected, else what is known. */
  async publishDiscovery() {
    // Never read faster than the interval: a reading younger than it is published as is.
    const fresh =
      this.lastRead?.identity === this.identity() &&
      this.now() - this.lastRead.at < this.config.refreshMs;
    if (this.online && !this.paused() && this.client && !fresh) {
      const generation = this.generation;
      try {
        await this.read({ publish: true });
        return;
      } catch (err) {
        if (isTokenRefused(err) || err?.code === CODES.HTTP) await this.failed(err, generation);
      }
    }
    await this.publishDiscovered();
  }

  /** The values of the created device of the PC read (only those known). */
  states() {
    const snapshot = this.snapshot;
    if (!snapshot || !this.online) return [];
    const created = this.createdDevice(snapshot.uuid);
    if (!created) return [];
    const ids = pcIds(this.gladys, snapshot.uuid);
    const values = valuesOf(snapshot);
    const states = [];
    for (const feature of created.features ?? []) {
      const parsed = parseExternalId(this.gladys, feature?.external_id);
      if (!parsed?.feature || feature.external_id !== ids.feature(parsed.feature)) continue;
      const value = values.get(parsed.feature);
      // Never undefined nor NaN: an unknown value is simply not published.
      if (typeof value === 'number' && Number.isFinite(value)) {
        states.push({ device_feature_external_id: feature.external_id, state: value });
      }
    }
    return states;
  }

  async publishStates(states = this.states()) {
    if (states.length === 0) return;
    await this.gladys.publishChangedStates(states).catch((err) => {
      this.logger.warn(`States not published: ${err.message}`);
    });
  }

  /** `online` = 0 on every created PC (read only: the PC is off, asleep or away). */
  async publishOffline() {
    const states = [];
    for (const { uuid, device } of createdPcs(this.gladys)) {
      const id = pcIds(this.gladys, uuid).feature(FEATURES.ONLINE);
      if ((device.features ?? []).some((f) => f?.external_id === id)) {
        states.push({ device_feature_external_id: id, state: 0 });
      }
    }
    await this.publishStates(states);
    await this.publishTransports();
  }

  async publishTransports() {
    const entries = createdPcs(this.gladys).map(({ uuid, externalId }) => ({
      external_id: externalId,
      transport: this.online && this.snapshot?.uuid === uuid ? 'local' : 'unreachable',
    }));
    const changed = entries.filter((e) => this.transports.get(e.external_id) !== e.transport);
    if (changed.length === 0) return;
    for (const entry of changed) this.transports.set(entry.external_id, entry.transport);
    await this.gladys.publishTransports(changed).catch((err) => {
      for (const entry of changed) this.transports.delete(entry.external_id);
      this.logger.debug(`Transports not published: ${err.message}`);
    });
  }

  // --- Commands --------------------------------------------------------------
  //
  // Six push buttons, never a switch (the core hands every switch to the
  // voice assistants, MCP and the switch scene actions). Nothing else is
  // ever sent to the PC: no command line, no keyboard, no file nor path.
  //
  //   lock                 protective: always allowed, never waits behind
  //                        another command, and cancels an "open the URL"
  //                        not sent yet; sent only to the PC read last (same
  //                        machine id), on the connection open now (never a
  //                        new connection, so never during a pause)
  //   sleep, hibernate,    refused unless `allow_power_actions` (off by
  //   restart, shut down   default)
  //   open the URL         refused unless `allow_open_url` (off by default)
  //                        and an http(s) URL typed in the configuration
  //
  // The permission is checked when the command arrives AND just before it
  // is sent, in the configuration in use and in the last one saved. One
  // power / open command at a time. Before sending, the PC is read again
  // (fresh `system` module): unknown, or another machine id at this address,
  // the command is refused; it is then written on that very connection only.
  // Gladys waits 5 s: past 3.5 s after the command arrived, nothing is
  // written any more (a connection opening later fails); once written, Gladys is
  // answered on System Bridge's answer or 4.3 s after the command at the
  // latest ("sent, without confirmation"). The answer to Gladys never waits
  // for the states (read again a few seconds later).

  async setValue(device, feature, value) {
    const received = this.now();
    const parsed = parseExternalId(this.gladys, feature?.external_id);
    if (!parsed?.feature) throw new Error(T.errors.unknownDevice);
    const command = COMMANDS[parsed.feature];
    if (!command) throw new Error(T.errors.notCommand);
    // Strictly 1: null, '' or 0 are not a push.
    if (!(value === 1 || value === '1' || value === true)) throw new Error(T.errors.invalidValue);
    this.checkAllowed(command);
    const client = this.client;
    if (!client || this.blocked) throw new Error(T.errors.notConnected);
    const generation = this.generation;
    const serial = this.configSerial;
    if (command.kind === 'protective') {
      // Never waits behind another command, but only to the PC of this
      // device, read last, on the connection open now (never a new
      // connection: no request during a pause).
      if (!this.online || !this.snapshot) throw new Error(T.errors.notConnected);
      if (this.snapshot.uuid !== parsed.uuid) throw new Error(T.errors.otherPc);
      const socket = client.currentSocket();
      if (!socket) throw new Error(T.errors.notConnected);
      // Cancels an "open the URL" still being checked.
      if (this.inFlight?.kind === 'open') this.inFlight.cancelled = true;
      return this.send({ client, generation, serial, parsed, command, received, socket });
    }
    if (this.paused()) throw new Error(T.errors.busy);
    if (this.inFlight) throw new Error(T.errors.stillRunning);
    const context = { kind: command.kind, cancelled: false };
    this.inFlight = context;
    try {
      return await this.send({
        client,
        generation,
        serial,
        parsed,
        command,
        received,
        verify: true,
        context,
      });
    } finally {
      if (this.inFlight === context) this.inFlight = null;
    }
  }

  /**
   * The permission, in the configuration in use AND in the last one saved
   * (a start may still be reading the PC with the older one).
   */
  checkAllowed(command) {
    for (const config of [this.config, this.latestConfig]) {
      if (command.kind === 'power' && !config.allowPower) throw new Error(T.errors.powerDisabled);
      if (command.kind === 'open') {
        if (!config.allowOpenUrl) throw new Error(T.errors.openDisabled);
        if (!config.openUrl) throw new Error(T.errors.openUrlMissing);
      }
    }
    if (command.kind === 'open' && this.config.openUrl !== this.latestConfig.openUrl) {
      throw new Error(T.errors.configChanged);
    }
  }

  /** The client, the configuration and the permission are still those of the command. */
  stillValid({ client, generation, serial, command, context }) {
    if (
      client !== this.client ||
      generation !== this.generation ||
      serial !== this.configSerial ||
      this.blocked
    ) {
      throw new Error(T.errors.configChanged);
    }
    this.checkAllowed(command);
    if (context?.cancelled) throw new Error(T.errors.cancelledByLock);
  }

  async send({ client, generation, serial, parsed, command, received, verify, context, socket }) {
    // Nothing is written after this instant, whatever happens before.
    const sendBy = received + COMMAND_BUDGET_MS;
    if (verify) {
      if (sendBy - this.now() < COMMAND_MIN_READ_MS) throw new Error(T.errors.tooSlow);
      let snapshot;
      try {
        snapshot = parseSnapshot(
          await client.getData(['system'], { deadline: sendBy - COMMAND_MIN_SEND_MS }),
        );
      } catch (err) {
        await this.commandFailed(err, generation);
        if (isTokenRefused(err)) throw new Error(T.errors.tokenRefused, { cause: err });
        throw new Error(T.errors.unknownState(err), { cause: err });
      }
      if (snapshot.uuid !== parsed.uuid) throw new Error(T.errors.otherPc);
      // The command goes on the connection of this fresh reading, and nowhere else.
      socket = client.currentSocket();
      if (!socket) throw new Error(T.errors.notSent({ code: CODES.CLOSED }));
    }
    if (sendBy - this.now() < (verify ? COMMAND_MIN_SEND_MS : 0)) {
      throw new Error(T.errors.tooSlow);
    }
    // The last check before sending: the user may have changed things meanwhile.
    this.stillValid({ client, generation, serial, command, context });
    const data = command.kind === 'open' ? { url: this.config.openUrl } : {};
    try {
      await client.command(command.event, data, command.answer, {
        deadline: received + COMMAND_ACK_MS,
        sendBy,
        socket,
      });
    } catch (err) {
      if (isTokenRefused(err) || SystemBridgeApp.isBusy(err)) {
        await this.commandFailed(err, generation);
      }
      if (isTokenRefused(err)) {
        throw new Error(T.errors.tokenRefused, { cause: err });
      }
      if (err instanceof BridgeError && err.code === CODES.REFUSED) {
        throw new Error(T.errors.refused(err), { cause: err });
      }
      if (err instanceof BridgeError && !err.sent) {
        throw new Error(T.errors.notSent(err), { cause: err });
      }
      // It may have run: never announced as "not sent".
      this.logger.warn(`${parsed.feature} sent, without confirmation`);
      this.refreshSoon(generation);
      throw new Error(T.errors.sentUnconfirmed(err), { cause: err });
    }
    this.logger.info(`${parsed.feature} sent and confirmed by System Bridge`);
    this.refreshSoon(generation);
  }

  /** Read the truth again in a moment (after a command), never before the next answer to Gladys. */
  refreshSoon(generation) {
    // One reading waiting at most, whatever the number of commands.
    if (generation !== this.generation || this.refreshPending) return;
    this.refreshPending = true;
    this.schedule(INTERVALS.AFTER_COMMAND_MS, async () => {
      this.refreshPending = false;
      if (generation !== this.generation || this.blocked || this.paused()) return;
      try {
        await this.read({ publish: false });
      } catch (err) {
        // The PC went to sleep or shut down: the loop says so at its pace.
        if (isTokenRefused(err) || SystemBridgeApp.isBusy(err)) await this.failed(err, generation);
        else this.logger.debug(`Reading after a command failed: ${err?.code ?? 'error'}`);
      }
    });
  }

  /** A refused token or a 429 / 503 met by a command: every path stops or pauses. */
  async commandFailed(err, generation) {
    if (isTokenRefused(err) || SystemBridgeApp.isBusy(err)) await this.failed(err, generation);
  }

  // --- Devices created / deleted in Gladys -----------------------------------

  async deviceCreated(device) {
    const parsed = parseExternalId(this.gladys, device?.external_id);
    if (!parsed || !this.online) return;
    await this.publishStates();
    await this.publishTransports();
  }

  deviceDeleted(device) {
    this.transports.delete(device?.external_id);
  }

  // --- Configuration button --------------------------------------------------

  /** Resolves `promise`, or rejects with `message` after `ms`. */
  within(promise, ms, message) {
    let handle;
    const limit = new Promise((_, reject) => {
      handle = this.timers.setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, limit]).finally(() => this.timers.clearTimeout(handle));
  }

  /** Reconnects (a refused token included: the user asked), then reports, within 25 s. */
  async testConnection() {
    await this.within(
      this.start(this.rawConfig, { force: true }),
      TEST_BUDGET_MS,
      T.errors.testTooLong,
    );
    if (!this.online) {
      const message = this.lastStatus ? JSON.parse(this.lastStatus)[1] : null;
      throw new Error(message?.en ?? T.errors.notConnected);
    }
    return T.test.ok({ hostname: this.snapshot?.hostname, version: this.snapshot?.version });
  }
}
