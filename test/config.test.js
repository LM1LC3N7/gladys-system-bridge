import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeConfig, parseAddress, parseOpenUrl } from '../src/config.js';

test('the address: host, host:port, ws:// or http://, never https nor a path', () => {
  assert.deepEqual(parseAddress('192.168.1.20'), {
    hostname: '192.168.1.20',
    port: 9170,
    label: '192.168.1.20:9170',
  });
  assert.equal(parseAddress(' My-PC.local:9171 ').label, 'my-pc.local:9171');
  assert.equal(parseAddress('ws://pc:9170/api/websocket').label, 'pc:9170');
  assert.equal(parseAddress('http://pc/').label, 'pc:9170');
  assert.deepEqual(parseAddress('[fe80::1]:9170'), {
    hostname: 'fe80::1',
    port: 9170,
    label: '[fe80::1]:9170',
  });
  assert.deepEqual(parseAddress(''), { error: 'empty' });
  assert.deepEqual(parseAddress('https://pc'), { error: 'tls' });
  assert.deepEqual(parseAddress('wss://pc'), { error: 'tls' });
  for (const bad of [
    'ftp://pc',
    'pc/other',
    'user@pc',
    'pc:0',
    'pc:70000',
    'pc?x=1',
    'a b',
    '-pc',
  ]) {
    assert.deepEqual(parseAddress(bad), { error: 'invalid' }, bad);
  }
});

test('the URL to open: http(s) only, without credentials', () => {
  assert.deepEqual(parseOpenUrl('https://gladys.local/dashboard'), {
    url: 'https://gladys.local/dashboard',
    error: null,
  });
  assert.deepEqual(parseOpenUrl(''), { url: null, error: null });
  assert.equal(parseOpenUrl('file:///etc/passwd').error, 'scheme');
  assert.equal(parseOpenUrl('ms-settings:privacy').error, 'scheme');
  assert.equal(parseOpenUrl('C:\\Windows\\notepad.exe').error, 'scheme');
  assert.equal(parseOpenUrl('notepad.exe').error, 'invalid');
  assert.equal(parseOpenUrl('https://user:pw@host/').error, 'credentials');
  assert.equal(parseOpenUrl(`https://x.y/${'a'.repeat(2_000)}`).error, 'invalid');
});

test('defaults: everything that acts is off', () => {
  const config = normalizeConfig({ host: 'pc', token: 't' });
  assert.equal(config.allowPower, false);
  assert.equal(config.allowOpenUrl, false);
  assert.equal(config.refreshMs, 60_000);
  assert.deepEqual(DEFAULTS, {
    refresh_interval: '60',
    allow_power_actions: false,
    allow_open_url: false,
  });
  assert.equal(normalizeConfig({ refresh_interval: '5' }).refreshMs, 60_000, 'unknown value');
  assert.equal(normalizeConfig({ refresh_interval: 30 }).refreshMs, 30_000);
  assert.equal(normalizeConfig({ allow_power_actions: 'yes' }).allowPower, false);
  assert.equal(normalizeConfig(null).addressError, 'empty');
});

test('the token: trimmed, an invisible character refused', () => {
  assert.equal(normalizeConfig({ token: '  abc  ' }).token, 'abc');
  assert.equal(normalizeConfig({ token: 'ab c' }).tokenInvalid, true);
  assert.equal(normalizeConfig({ token: 'abc\u200b' }).tokenInvalid, true);
  assert.equal(normalizeConfig({ token: 'x'.repeat(300) }).tokenInvalid, true);
  assert.equal(normalizeConfig({ token: 42 }).token, '');
});
