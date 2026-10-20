import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODES } from '../src/bridge/errors.js';
import { label, machineId, num, parseSnapshot, slug } from '../src/bridge/parse.js';
import { windowsModules } from './helpers/fakeBridge.js';

test('a Windows PC', () => {
  const s = parseSnapshot(windowsModules());
  assert.equal(s.uuid, '4c4c4544-0042-3510-8051-b4c04f4a4b32');
  assert.equal(s.hostname, 'desk');
  assert.equal(s.cpuUsage, 12.3);
  assert.equal(s.memoryUsedMb, 8500);
  assert.equal(s.uptimeHours, 2);
  assert.deepEqual(s.partitions, [
    { key: 'c', label: 'C:\\', percent: 61.2 },
    { key: 'd', label: 'D:\\', percent: 10 },
  ]);
  assert.deepEqual(s.gpus, [
    { key: 'gpu-0a1b', name: 'NVIDIA RTX 4060', load: 3, temperature: 41 },
  ]);
  assert.equal(s.battery, null);
  assert.equal(s.batteryCharging, null);
  assert.equal(s.cameraInUse, false);
  assert.equal(s.microphoneInUse, true);
});

test('a Linux laptop: system mounts left out, battery, duplicates keep the first', () => {
  const partition = (mount, fs, percent, category) => ({
    device: '/dev/x',
    mount_point: mount,
    filesystem_type: fs,
    usage: { percent },
    ...(category ? { category } : {}),
  });
  const s = parseSnapshot(
    windowsModules({
      disks: {
        devices: [
          {
            name: 'nvme0n1',
            partitions: [
              partition('/', 'ext4', 40, 'primary'),
              partition('/boot/efi', 'vfat', 5),
              partition('/snap/core/1', 'squashfs', 100),
              partition('/run/user/1000', 'tmpfs', 1),
              partition('/var/lib/docker', 'ext4', 40, 'bind'),
              partition('/boot-efi', 'ext4', 7),
              partition('/home', 'ext4', 'full'),
            ],
          },
        ],
      },
      battery: { is_charging: true, percentage: 87.4 },
      gpus: null,
    }),
  );
  assert.deepEqual(
    s.partitions.map((p) => [p.key, p.percent]),
    [
      ['root', 40],
      ['boot-efi', 5],
    ],
  );
  assert.equal(s.battery, 87);
  assert.equal(s.batteryCharging, true);
  assert.deepEqual(s.gpus, []);
});

test('caps: 12 partitions, 4 GPUs, long texts cut', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    mount_point: `/data${i}`,
    filesystem_type: 'ext4',
    usage: { percent: i },
  }));
  const s = parseSnapshot(
    windowsModules({
      disks: { devices: [{ name: 'x', partitions: many }] },
      gpus: Array.from({ length: 10 }, (_, i) => ({ id: `g${i}`, name: 'n'.repeat(500) })),
    }),
  );
  assert.equal(s.partitions.length, 12);
  assert.equal(s.gpus.length, 4);
  assert.equal(s.gpus[0].name.length, 64);
});

test('no machine id: refused (the external id needs it)', () => {
  for (const uuid of [undefined, '', 'a:b', 'x'.repeat(65), 42]) {
    assert.throws(
      () => parseSnapshot(windowsModules({ system: { ...windowsModules().system, uuid } })),
      { code: CODES.BAD_ANSWER },
    );
  }
  assert.throws(() => parseSnapshot({}), { code: CODES.BAD_ANSWER });
  assert.throws(() => parseSnapshot(null), { code: CODES.BAD_ANSWER });
});

test('hostile values: no prototype pollution, no NaN, no huge strings', () => {
  const modules = JSON.parse(
    `{"system":{"uuid":"abc","hostname":"h","__proto__":{"polluted":1},"users":"many"},"cpu":{"usage":1e999},"memory":{"virtual":{"percent":"50"}},"disks":{"devices":{"length":1e9}},"gpus":{"0":{}}}`,
  );
  const s = parseSnapshot(modules);
  assert.equal({}.polluted, undefined);
  assert.equal(s.cpuUsage, null);
  assert.equal(s.memoryUsage, null);
  assert.equal(s.users, null);
  assert.deepEqual(s.partitions, []);
  assert.deepEqual(s.gpus, []);
});

test('helpers', () => {
  assert.equal(num(5.55, 0, 10), 5.6);
  assert.equal(num('5', 0, 10), null);
  assert.equal(num(11, 0, 10), null);
  assert.equal(num(Number.NaN, 0, 10), null);
  assert.equal(label('a\u0000b\nc  '), 'abc');
  assert.equal(label(''), null);
  assert.equal(slug('C:\\'), 'c');
  assert.equal(slug('/mnt/My Data/'), 'mnt-my-data');
  assert.equal(slug('/'), '');
  assert.equal(machineId(' ABC-1 '), 'abc-1');
  assert.equal(machineId('a/b'), null);
});
