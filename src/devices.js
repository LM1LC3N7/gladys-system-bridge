// -----------------------------------------------------------------------------
// The Gladys device of the PC (pure).
//
//   pc   `ext:<selector>:pc:<machine uuid>`: the readings (read only) and the
//        buttons (lock, sleep, hibernate, restart, shut down, open the URL)
//
// The machine uuid System Bridge gives is stable across reboots, renames and
// address changes. The disks (`disk_<mount point>`) and the GPUs
// (`gpu_<id>_load`, `gpu_<id>_temperature`) are named after what System Bridge
// reports, and a feature seen once is never dropped from the device (the core
// marks a device whose features disappear as changed, and "Update" would
// destroy their history).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FEATURES, PC_TYPE } from './constants.js';
import { machineId } from './bridge/parse.js';

export const pcIds = (gladys, uuid) => gladys.externalIds(PC_TYPE, uuid);

const readOnly = (extra) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...extra,
});
const percent = (name) =>
  // No core category lists a percent for a processor, a memory or a disk
  // load: `unknown`/`unknown` without a unit (TODO.md, "Decisions").
  readOnly({ name, category: C.UNKNOWN, type: T.UNKNOWN.UNKNOWN, min: 0, max: 100 });
const binary = (name) =>
  // Read only, never a switch: the core hands every switch to the voice
  // assistants, MCP and the switch scene actions.
  readOnly({ name, category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const temperature = (name) =>
  readOnly({
    name,
    category: C.DEVICE_TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: -50,
    max: 150,
  });

/** A push button (refused unless allowed in the configuration, lock excepted). */
const button = (name) => ({
  name,
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
});

export const diskFeature = (key) => `disk_${key}`;
export const gpuLoadFeature = (key) => `gpu_${key}_load`;
export const gpuTemperatureFeature = (key) => `gpu_${key}_temperature`;

/** The features of a snapshot: [key, definition], in display order. */
export function featuresOf(snapshot) {
  const s = snapshot;
  const features = [
    [FEATURES.ONLINE, binary('Online')],
    [FEATURES.CPU_USAGE, percent('CPU (%)')],
  ];
  if (s.cpuTemperature !== null) features.push([FEATURES.CPU_TEMPERATURE, temperature('CPU')]);
  features.push(
    [FEATURES.MEMORY_USAGE, percent('Memory (%)')],
    [
      FEATURES.MEMORY_USED,
      readOnly({
        name: 'Memory used',
        category: C.DATA,
        type: T.DATA.SIZE,
        unit: U.MEGABYTE,
        min: 0,
        max: 100_000_000,
      }),
    ],
  );
  for (const p of s.partitions) features.push([diskFeature(p.key), percent(`Disk ${p.label} (%)`)]);
  for (const g of s.gpus) {
    features.push([gpuLoadFeature(g.key), percent(`${g.name} (%)`)]);
    if (g.temperature !== null) features.push([gpuTemperatureFeature(g.key), temperature(g.name)]);
  }
  if (s.battery !== null) {
    features.push([
      FEATURES.BATTERY,
      readOnly({
        name: 'Battery',
        category: C.BATTERY,
        type: T.BATTERY.INTEGER,
        unit: U.PERCENT,
        min: 0,
        max: 100,
      }),
    ]);
    if (s.batteryCharging !== null) {
      features.push([
        FEATURES.BATTERY_CHARGING,
        readOnly({
          name: 'Charging',
          category: C.BATTERY,
          type: T.BATTERY.CHARGING,
          min: 0,
          max: 1,
        }),
      ]);
    }
  }
  if (s.powerUsage !== null) {
    features.push([
      FEATURES.POWER_USAGE,
      readOnly({
        name: 'Power',
        category: C.ENERGY_SENSOR,
        type: T.ENERGY_SENSOR.POWER,
        unit: U.WATT,
        min: 0,
        max: 100_000,
      }),
    ]);
  }
  features.push(
    [
      FEATURES.USERS,
      readOnly({
        name: 'Users logged in',
        category: C.COUNTER_SENSOR,
        type: T.SENSOR.INTEGER,
        min: 0,
        max: 1000,
      }),
    ],
    [
      FEATURES.UPTIME,
      readOnly({
        name: 'Uptime',
        category: C.DURATION,
        type: T.DURATION.DECIMAL,
        unit: U.HOURS,
        min: 0,
        max: 10_000_000,
      }),
    ],
  );
  if (s.cameraInUse !== null) features.push([FEATURES.CAMERA_IN_USE, binary('Camera in use')]);
  if (s.microphoneInUse !== null) {
    features.push([FEATURES.MICROPHONE_IN_USE, binary('Microphone in use')]);
  }
  if (s.pendingReboot !== null) features.push([FEATURES.PENDING_REBOOT, binary('Restart pending')]);
  if (s.updateAvailable !== null) {
    features.push([FEATURES.UPDATE_AVAILABLE, binary('System Bridge update available')]);
  }
  features.push(
    [FEATURES.LOCK, button('Lock')],
    [FEATURES.SLEEP, button('Sleep')],
    [FEATURES.HIBERNATE, button('Hibernate')],
    [FEATURES.RESTART, button('Restart')],
    [FEATURES.SHUTDOWN, button('Shut down')],
    [FEATURES.OPEN_URL, button('Open the URL')],
  );
  return features;
}

/**
 * The device of the PC. `created`: the device already created in Gladys
 * (from `gladys.devices`), whose features are all kept.
 */
export function buildPcDevice(gladys, snapshot, created = null) {
  const ids = pcIds(gladys, snapshot.uuid);
  const features = featuresOf(snapshot).map(([key, definition]) => ({
    ...definition,
    external_id: ids.feature(key),
  }));
  const known = new Set(features.map((f) => f.external_id));
  for (const feature of created?.features ?? []) {
    if (typeof feature?.external_id === 'string' && !known.has(feature.external_id)) {
      known.add(feature.external_id);
      features.push(feature);
    }
  }
  const name = snapshot.hostname ?? 'PC';
  return {
    name: name.slice(0, 64),
    external_id: ids.device,
    model: (snapshot.model ?? `System Bridge (${snapshot.platform ?? 'PC'})`).slice(0, 80),
    should_poll: false,
    features,
  };
}

/** The value of each feature of a snapshot (null: unknown, not published). */
export function valuesOf(snapshot) {
  const s = snapshot;
  const flag = (value) => (value === null ? null : value ? 1 : 0);
  const values = new Map([
    [FEATURES.ONLINE, 1],
    [FEATURES.CPU_USAGE, s.cpuUsage],
    [FEATURES.CPU_TEMPERATURE, s.cpuTemperature],
    [FEATURES.MEMORY_USAGE, s.memoryUsage],
    [FEATURES.MEMORY_USED, s.memoryUsedMb],
    [FEATURES.BATTERY, s.battery],
    [FEATURES.BATTERY_CHARGING, flag(s.batteryCharging)],
    [FEATURES.POWER_USAGE, s.powerUsage],
    [FEATURES.USERS, s.users],
    [FEATURES.UPTIME, s.uptimeHours],
    [FEATURES.CAMERA_IN_USE, flag(s.cameraInUse)],
    [FEATURES.MICROPHONE_IN_USE, flag(s.microphoneInUse)],
    [FEATURES.PENDING_REBOOT, flag(s.pendingReboot)],
    [FEATURES.UPDATE_AVAILABLE, flag(s.updateAvailable)],
  ]);
  for (const p of s.partitions) values.set(diskFeature(p.key), p.percent);
  for (const g of s.gpus) {
    values.set(gpuLoadFeature(g.key), g.load);
    values.set(gpuTemperatureFeature(g.key), g.temperature);
  }
  return values;
}

/**
 * What a device or feature external id of this integration designates:
 * { uuid, feature } (feature null for the device itself) | null.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string' || externalId.length > 256) return null;
  const prefix = gladys.externalId(`${PC_TYPE}:`);
  if (!externalId.startsWith(prefix)) return null;
  const [id, feature, ...rest] = externalId.slice(prefix.length).split(':');
  const uuid = machineId(id);
  if (rest.length > 0 || !uuid || uuid !== id) return null;
  if (feature !== undefined && !/^[a-z0-9_-]{1,80}$/.test(feature)) return null;
  return { uuid, feature: feature ?? null };
}

/** The PCs created in Gladys: [{ uuid, externalId, device }]. */
export function createdPcs(gladys, devices = gladys.devices) {
  const out = [];
  for (const device of devices ?? []) {
    const parsed = parseExternalId(gladys, device?.external_id);
    if (parsed && parsed.feature === null) {
      out.push({ uuid: parsed.uuid, externalId: device.external_id, device });
    }
  }
  return out;
}
