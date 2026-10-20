// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEVICE_FEATURE_UNITS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { parseSnapshot } from '../src/bridge/parse.js';
import { DEFAULTS } from '../src/config.js';
import { ACTIONS, COMMANDS, REFRESH_INTERVALS } from '../src/constants.js';
import { buildPcDevice } from '../src/devices.js';
import { windowsModules } from './helpers/fakeBridge.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const keys = (list) => (list ?? []).map((item) => item.key);
const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));

test('the store basics; version 0.1.0 set by hand everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.gladys_version, /^>=5\.1\.0$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-system-bridge:${manifest.version}`);
  assert.equal(pkg.name, 'gladys-system-bridge');
  assert.equal(lock.name, 'gladys-system-bridge');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.deepEqual(manifest.transports, ['local']);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(fields.intro.description.en, /Unofficial integration, not affiliated/);
  assert.match(fields.intro.description.fr, /non officielle, sans lien/);
  assert.match(read('docs/en.md'), /never\s+been\s+tested\s+with\s+a\s+real\s+PC/i);
  assert.match(read('docs/fr.md'), /jamais\s+été\s+testée\s+avec\s+un\s+vrai\s+PC/i);
});

test('the license and the notices ship in the image', () => {
  assert.match(read('LICENSE'), /Apache License/);
  assert.doesNotMatch(read('LICENSE'), /Copyright (?:\(c\) )?\d{4}/i, 'no name in the license');
  assert.match(read('THIRD_PARTY_NOTICES.md'), /system-bridge-connector[\s\S]*Apache License/);
  assert.match(dockerfile, /COPY[^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('the configuration matches the code; every action off by default', () => {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.equal(fields[key].default, value, key);
  }
  assert.deepEqual(
    fields.refresh_interval.options.map((o) => o.value),
    REFRESH_INTERVALS,
  );
  assert.deepEqual(keys(manifest.config_schema), [
    'intro',
    'host',
    'token',
    'refresh_interval',
    'security_section',
    'allow_power_actions',
    'allow_open_url',
    'open_url',
  ]);
  assert.equal(fields.token.type, 'secret');
  assert.match(fields.token.description.en, /Kept by Gladys in its database, never shown again/);
  assert.match(fields.token.description.fr, /Gardé par Gladys dans sa base, jamais réaffiché/);
  assert.match(fields.host.description.en, /in clear/, 'the risk is said');
  assert.match(fields.host.description.fr, /en clair/);
  assert.equal(fields.allow_power_actions.default, false);
  assert.equal(fields.allow_open_url.default, false);
});

test('sections store nothing; links https', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined, section.key);
    assert.equal(section.default, undefined, section.key);
    assert.equal(section.placeholder, undefined, section.key);
    for (const link of section.links ?? []) assert.match(link.url, /^https:\/\//);
    for (const text of Object.values(section.description)) {
      assert.ok(text.length <= 1000, `${section.key}: ${text.length} characters`);
    }
  }
});

test('the keys of the manifest are the keys of the code, all registered', () => {
  assert.deepEqual(keys(manifest.actions).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), name);
  }
  assert.ok(manifest.actions.every((a) => a.timeout_seconds >= 5 && a.timeout_seconds <= 120));
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.widgets, undefined);
  for (const handler of ['onScanRequest(', 'onSetValue(', 'onConfigUpdated(']) {
    assert.ok(handlers.includes(handler), handler);
  }
});

test('placeholders are multi-language objects', () => {
  for (const field of manifest.config_schema.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', field.key);
    assert.ok(field.placeholder.en && field.placeholder.fr, field.key);
  }
});

test('only buttons act; nothing ever sends a command line, keystrokes, a path or a file', () => {
  const gladys = createFakeGladys({ selector: 'system-bridge' });
  const device = buildPcDevice(gladys, parseSnapshot(windowsModules()));
  for (const feature of device.features) {
    const key = feature.external_id.split(':').pop();
    if (feature.read_only) continue;
    assert.equal(feature.category, 'button', key);
    assert.equal(feature.type, 'push', key);
    assert.ok(key in COMMANDS, key);
  }
  assert.deepEqual(
    Object.values(COMMANDS)
      .map((c) => c.event)
      .sort(),
    ['OPEN', 'POWER_HIBERNATE', 'POWER_LOCK', 'POWER_RESTART', 'POWER_SHUTDOWN', 'POWER_SLEEP'],
  );
  const sources = ['src/app.js', 'src/bridge/client.js', 'src/constants.js'].map(read).join('\n');
  for (const event of ['COMMAND_EXECUTE', 'KEYBOARD_KEYPRESS', 'KEYBOARD_TEXT', 'GET_FILE']) {
    assert.ok(!new RegExp(`['"]${event}['"]`).test(sources), `${event} is never sent`);
  }
  assert.ok(!/\bpath:/.test(read('src/app.js')), 'OPEN never carries a path');
});

test('units: only those the core lists for the category (server/utils/constants.js)', () => {
  // DEVICE_FEATURE_UNITS_BY_CATEGORY of the core, for the categories used here.
  const allowed = {
    data: [
      'bit',
      'kilobit',
      'megabit',
      'gigabit',
      'byte',
      'kilobyte',
      'megabyte',
      'gigabyte',
      'terabyte',
    ],
    battery: ['percent'],
    'device-temperature-sensor': ['celsius', 'fahrenheit'],
    duration: [
      'microseconds',
      'milliseconds',
      'seconds',
      'minutes',
      'hours',
      'days',
      'weeks',
      'months',
      'years',
    ],
    'energy-sensor': [
      'milliampere',
      'ampere',
      'millivolt',
      'volt',
      'watt',
      'kilowatt',
      'watt-hour',
      'kilowatt-hour',
      'megawatt-hour',
      'kilovolt-ampere',
      'volt-ampere',
      'volt-ampere-reactive',
      'euro',
      'dollar',
    ],
  };
  const gladys = createFakeGladys({ selector: 'system-bridge' });
  const snapshot = parseSnapshot(
    windowsModules({
      battery: { is_charging: false, percentage: 50 },
      system: { ...windowsModules().system, power_usage: 80 },
    }),
  );
  for (const feature of buildPcDevice(gladys, snapshot).features) {
    if (feature.unit === undefined) continue;
    assert.ok(Object.values(DEVICE_FEATURE_UNITS).includes(feature.unit), feature.unit);
    assert.ok(
      allowed[feature.category]?.includes(feature.unit),
      `${feature.name}: ${feature.unit}`,
    );
  }
});
