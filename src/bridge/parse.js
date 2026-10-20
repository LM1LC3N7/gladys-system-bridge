// -----------------------------------------------------------------------------
// The data modules of System Bridge -> one plain snapshot of the PC. Every
// value is checked (type, range); anything unexpected becomes null and is
// simply not published. Lists are cut before they are walked. The shapes
// follow the models of system-bridge-connector (and the Go types of System
// Bridge 5): snake_case keys, nullable numbers.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';
import { BridgeError, CODES } from './errors.js';

const SCAN = 64; // list entries looked at, at most (before the caps of LIMITS)

/** File systems and mount points that are not a disk of the user. */
const SKIPPED_FILESYSTEMS = new Set([
  'squashfs',
  'tmpfs',
  'devtmpfs',
  'overlay',
  'proc',
  'sysfs',
  'cgroup',
  'cgroup2',
  'autofs',
  'ramfs',
  'nsfs',
  'efivarfs',
  'fuse.snapfuse',
  'fuse.portal',
]);
const SKIPPED_MOUNTS = /^\/(?:snap|proc|sys|dev|run)(?:\/|$)/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = (value) => (isObject(value) ? value : {});
const list = (value) => (Array.isArray(value) ? value.slice(0, SCAN) : []);
const bool = (value) => (typeof value === 'boolean' ? value : null);
const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** A finite number within [min, max], rounded; null otherwise (null, '', NaN, strings). */
export function num(value, min, max, digits = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return round(value, digits);
}

/** Printable text, cut. */
export function label(value, max = 64) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean ? clean.slice(0, max) : null;
}

/** A key for an external id: lowercase letters, digits and dashes. */
export function slug(value, max = 32) {
  if (typeof value !== 'string') return '';
  return value
    .slice(0, 256)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

/** The machine id System Bridge gives (stable): the external id of the PC. */
export function machineId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) ? id : null;
}

function partitions(disks) {
  const out = [];
  const keys = new Set();
  for (const device of list(object(disks).devices)) {
    for (const partition of list(object(device).partitions)) {
      if (out.length >= LIMITS.PARTITIONS) return out;
      const p = object(partition);
      const mount = label(p.mount_point, 256);
      if (!mount || SKIPPED_MOUNTS.test(mount)) continue;
      if (typeof p.category === 'string' && p.category !== 'primary') continue;
      if (SKIPPED_FILESYSTEMS.has(String(p.filesystem_type ?? '').toLowerCase())) continue;
      const percent = num(object(p.usage).percent, 0, 100);
      if (percent === null) continue;
      const key = slug(mount) || 'root';
      if (keys.has(key)) continue; // the first one keeps the key
      keys.add(key);
      out.push({ key, label: mount.slice(0, 64), percent });
    }
  }
  return out;
}

function gpus(value) {
  const out = [];
  const keys = new Set();
  for (const [index, gpu] of list(value).entries()) {
    if (out.length >= LIMITS.GPUS) break;
    const g = object(gpu);
    const key = slug(g.id) || slug(g.name) || String(index);
    if (keys.has(key)) continue;
    keys.add(key);
    out.push({
      key,
      name: label(g.name) ?? `GPU ${index + 1}`,
      load: num(g.core_load, 0, 100),
      temperature: num(g.temperature, -50, 150),
    });
  }
  return out;
}

/**
 * @param {Record<string, unknown>} modules the data of each module received
 * @returns the snapshot; throws BAD_ANSWER without a valid machine id
 */
export function parseSnapshot(modules) {
  const system = object(modules?.system);
  const uuid = machineId(system.uuid);
  if (!uuid) throw new BridgeError(CODES.BAD_ANSWER, 'no machine id in the system data');
  const cpu = object(modules.cpu);
  const memory = object(object(modules.memory).virtual);
  const battery = object(modules.battery);
  const info = object(system.device_info);
  const users = Array.isArray(system.users) ? Math.min(system.users.length, 1000) : null;
  const usedBytes = num(memory.used, 0, 1e16, 0);
  const uptime = num(system.uptime, 0, 1e10, 0);
  const batteryPercent = num(battery.percentage, 0, 100, 0);
  return {
    uuid,
    hostname: label(system.hostname),
    version: label(system.version, 32),
    platform: label(system.platform, 32),
    model: [label(info.manufacturer, 40), label(info.model, 40)].filter(Boolean).join(' ') || null,
    cpuUsage: num(cpu.usage, 0, 100),
    cpuTemperature: num(cpu.temperature, -50, 150),
    memoryUsage: num(memory.percent, 0, 100),
    memoryUsedMb: usedBytes === null ? null : Math.round(usedBytes / 1e6),
    users,
    uptimeHours: uptime === null ? null : round(uptime / 3600, 2),
    pendingReboot: bool(system.pending_reboot),
    updateAvailable: bool(system.version_newer_available),
    powerUsage: num(system.power_usage, 0, 100_000),
    cameraInUse: Array.isArray(system.camera_usage) ? system.camera_usage.length > 0 : null,
    microphoneInUse: Array.isArray(system.microphone_usage)
      ? system.microphone_usage.length > 0
      : null,
    battery: batteryPercent,
    batteryCharging: batteryPercent === null ? null : bool(battery.is_charging),
    partitions: partitions(modules.disks),
    gpus: gpus(modules.gpus),
  };
}
