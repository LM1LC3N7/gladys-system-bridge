// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, REFRESH_INTERVALS } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = Object.freeze({
  refresh_interval: '60',
  allow_power_actions: false,
  allow_open_url: false,
});

/** What a JSON string and a WebSocket text frame accept as a token: printable ASCII, no space. */
const TOKEN_PATTERN = /^[\x21-\x7e]{1,256}$/;
/** A host name, an IPv4 address, or an IPv6 address in brackets. */
const HOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])$/i;
const MAX_URL_LENGTH = 2_000;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const bool = (value, fallback) => {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return fallback;
};

/**
 * The address of the PC: `host`, `host:port`, or the same after `ws://` or
 * `http://` (what the System Bridge settings show). System Bridge has no TLS:
 * `https://` and `wss://` are refused rather than silently downgraded.
 *   -> { hostname, port, label } or { error: 'empty' | 'invalid' | 'tls' }
 */
export function parseAddress(value) {
  let raw = text(value);
  if (!raw) return { error: 'empty' };
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name === 'https' || name === 'wss') return { error: 'tls' };
    if (name !== 'http' && name !== 'ws') return { error: 'invalid' };
    raw = raw.slice(scheme[0].length);
  }
  // A trailing slash or the API path pasted with it is dropped; anything else is not an address.
  raw = raw.replace(/\/(?:api(?:\/websocket)?)?\/?$/i, '');
  const match = /^(\[[^\]]*\]|[^:/?#@\s]+)(?::(\d{1,5}))?$/.exec(raw);
  if (!match || !HOST_PATTERN.test(match[1])) return { error: 'invalid' };
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!(port > 0 && port < 65536)) return { error: 'invalid' };
  const hostname = match[1].toLowerCase();
  return {
    hostname: hostname.startsWith('[') ? hostname.slice(1, -1) : hostname,
    port,
    label: `${hostname}:${port}`,
  };
}

/**
 * The page the "Open the URL" button opens: http or https only (never a
 * file, a path or another scheme, which Windows would hand to a program), no
 * user name nor password in it.
 */
export function parseOpenUrl(value) {
  const raw = text(value);
  if (!raw) return { url: null, error: null };
  if (raw.length > MAX_URL_LENGTH) return { url: null, error: 'invalid' };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { url: null, error: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { url: null, error: 'scheme' };
  if (url.username || url.password) return { url: null, error: 'credentials' };
  if (!url.hostname) return { url: null, error: 'invalid' };
  return { url: url.href, error: null };
}

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const address = parseAddress(raw.host);
  const token = typeof raw.token === 'string' ? raw.token.trim() : '';
  const openUrl = parseOpenUrl(raw.open_url);
  const interval = REFRESH_INTERVALS.includes(String(raw.refresh_interval))
    ? String(raw.refresh_interval)
    : DEFAULTS.refresh_interval;
  return {
    address: address.error ? null : address,
    addressError: address.error ?? null,
    token,
    // An invisible character pasted with the token (U+200B...) is said to
    // the user, never sent.
    tokenInvalid: token !== '' && !TOKEN_PATTERN.test(token),
    refreshMs: Number(interval) * 1000,
    allowPower: bool(raw.allow_power_actions, DEFAULTS.allow_power_actions),
    allowOpenUrl: bool(raw.allow_open_url, DEFAULTS.allow_open_url),
    openUrl: openUrl.url,
    openUrlError: openUrl.error,
  };
}
