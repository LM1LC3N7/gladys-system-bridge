// -----------------------------------------------------------------------------
// Keys, limits and timings. The manifest keys and the external id shapes are
// stored in user devices and scenes: never rename them (test/manifest.test.js
// ties them to the manifest).
// -----------------------------------------------------------------------------

export const ACTIONS = Object.freeze({
  TEST: 'test_connection',
});

/** Device external id: `ext:<selector>:pc:<machine uuid given by System Bridge>`. */
export const PC_TYPE = 'pc';

/** Fixed features (the disks and GPUs add `disk_<key>`, `gpu_<key>_load`, `gpu_<key>_temperature`). */
export const FEATURES = Object.freeze({
  ONLINE: 'online',
  CPU_USAGE: 'cpu_usage',
  CPU_TEMPERATURE: 'cpu_temperature',
  MEMORY_USAGE: 'memory_usage',
  MEMORY_USED: 'memory_used',
  USERS: 'users',
  UPTIME: 'uptime',
  PENDING_REBOOT: 'pending_reboot',
  UPDATE_AVAILABLE: 'update_available',
  POWER_USAGE: 'power_usage',
  CAMERA_IN_USE: 'camera_in_use',
  MICROPHONE_IN_USE: 'microphone_in_use',
  BATTERY: 'battery',
  BATTERY_CHARGING: 'battery_charging',
  // Buttons.
  LOCK: 'lock',
  SLEEP: 'sleep',
  HIBERNATE: 'hibernate',
  RESTART: 'restart',
  SHUTDOWN: 'shutdown',
  OPEN_URL: 'open_url',
});

/**
 * The buttons and the System Bridge event each one sends, with the answer
 * System Bridge gives once it accepted it. Nothing else is ever sent: no
 * command line (COMMAND_EXECUTE), no keyboard (KEYBOARD_*), no file or path
 * (OPEN with a path), no notification, no media, no settings.
 */
export const COMMANDS = Object.freeze({
  [FEATURES.LOCK]: { event: 'POWER_LOCK', answer: 'POWER_LOCKING', kind: 'protective' },
  [FEATURES.SLEEP]: { event: 'POWER_SLEEP', answer: 'POWER_SLEEPING', kind: 'power' },
  [FEATURES.HIBERNATE]: { event: 'POWER_HIBERNATE', answer: 'POWER_HIBERNATING', kind: 'power' },
  [FEATURES.RESTART]: { event: 'POWER_RESTART', answer: 'POWER_RESTARTING', kind: 'power' },
  [FEATURES.SHUTDOWN]: { event: 'POWER_SHUTDOWN', answer: 'POWER_SHUTTINGDOWN', kind: 'power' },
  [FEATURES.OPEN_URL]: { event: 'OPEN', answer: 'OPENED', kind: 'open' },
});

/** The data modules read (never `processes`, `media`, `networks`: large or private). */
export const MODULES = Object.freeze(['system', 'cpu', 'memory', 'disks', 'battery', 'gpus']);

/** Seconds between two readings. */
export const REFRESH_INTERVALS = Object.freeze(['30', '60', '120', '300']);

/** System Bridge listens on 9170 unless told otherwise. */
export const DEFAULT_PORT = 9170;
export const WEBSOCKET_PATH = '/api/websocket';

export const LIMITS = Object.freeze({
  /** Disk partitions and GPUs turned into features (the first ones, in the order given). */
  PARTITIONS: 12,
  GPUS: 4,
  /**
   * One WebSocket message read from System Bridge, at most. Its own server
   * refuses more than 1 MiB from a client; the modules read here are far
   * smaller (no process list).
   */
  MESSAGE_BYTES: 4 * 1024 * 1024,
  /** Bytes buffered before the HTTP upgrade answer is complete. */
  HANDSHAKE_BYTES: 16 * 1024,
  /** Messages waiting for an answer at once (requests in flight). */
  PENDING: 16,
});

export const TIMEOUTS = Object.freeze({
  /** TCP connection and WebSocket upgrade. */
  CONNECT: 8_000,
  /** A reading: the DATA_GET answer, then the module updates. */
  READ: 10_000,
  /** The close handshake before the socket is destroyed. */
  CLOSE: 1_000,
});

/**
 * Gladys waits 5 s for the acknowledgement of a command: past this budget,
 * counted from the moment the command arrives, nothing is sent to the PC (an
 * action must never run after Gladys showed a failure).
 */
export const COMMAND_BUDGET_MS = 3_500;
/** Room needed to start the fresh reading of the PC at all. */
export const COMMAND_MIN_READ_MS = 1_500;
/** Room kept after the fresh reading for the command itself. */
export const COMMAND_MIN_SEND_MS = 500;
/**
 * Once the command is written, Gladys gets its answer at the latest this long
 * after the command arrived: without the answer of System Bridge by then, the
 * command is "sent, without confirmation".
 */
export const COMMAND_ACK_MS = 4_300;

export const INTERVALS = Object.freeze({
  /** A failed reading (PC off, asleep, unreachable): the first retry, never under the interval. */
  RETRY_MIN_MS: 30_000,
  RETRY_MAX_MS: 5 * 60_000,
  /** HTTP 429 / 503 on the upgrade: a pause within these bounds (Retry-After if given). */
  BUSY_MIN_MS: 60_000,
  BUSY_MAX_MS: 6 * 3600_000,
  /** A token System Bridge refused: tried again alone this long after, at most once. */
  REFUSED_RETRY_MS: 6 * 3600_000,
  /** After a command: the PC is read again in a moment. */
  AFTER_COMMAND_MS: 5_000,
});

/** The persistent store (refusals, pause: see src/store.js). */
export const STORE_FILE = 'system-bridge.json';
