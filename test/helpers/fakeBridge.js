// -----------------------------------------------------------------------------
// A fake System Bridge on loopback: a real HTTP server, a real WebSocket
// upgrade and framing (server side), the protocol of System Bridge 5
// (GET_DATA -> DATA_GET + one DATA_UPDATE per module with id "system",
// POWER_* -> POWER_*ING, OPEN -> OPENED, a wrong token -> ERROR BAD_TOKEN).
// Never touches the network beyond 127.0.0.1.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

export const TOKEN = 'sb-test-token-0123456789';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const ANSWERS = {
  POWER_LOCK: 'POWER_LOCKING',
  POWER_SLEEP: 'POWER_SLEEPING',
  POWER_HIBERNATE: 'POWER_HIBERNATING',
  POWER_RESTART: 'POWER_RESTARTING',
  POWER_SHUTDOWN: 'POWER_SHUTTINGDOWN',
  OPEN: 'OPENED',
};

/** The modules of a Windows PC, shaped like System Bridge 5 sends them. */
export function windowsModules(overrides = {}) {
  return {
    system: {
      boot_time: 1_760_000_000,
      fqdn: 'desk.local',
      hostname: 'desk',
      kernel_version: '10.0.26100',
      ip_address_4: '192.168.1.20',
      mac_address: '00:11:22:33:44:55',
      platform_version: '11',
      platform: 'windows',
      power_usage: null,
      uptime: 7200,
      users: [{ name: 'alice', active: true, terminal: '', host: '', started: 0, pid: 1 }],
      uuid: '4C4C4544-0042-3510-8051-B4C04F4A4B32',
      version: '5.13.0',
      camera_usage: [],
      microphone_usage: ['Teams'],
      ip_address_6: '',
      pending_reboot: false,
      run_mode: 'standalone',
      version_latest_url: null,
      version_latest: '5.13.0',
      version_newer_available: false,
      device_info: { manufacturer: 'Dell Inc.', model: 'OptiPlex 7090' },
    },
    cpu: { count: 8, usage: 12.345, temperature: 48.5, per_cpu: [] },
    memory: { virtual: { total: 17_000_000_000, used: 8_500_000_000, percent: 50 } },
    disks: {
      devices: [
        {
          name: 'disk0',
          partitions: [
            {
              device: 'C:\\',
              mount_point: 'C:\\',
              filesystem_type: 'NTFS',
              options: 'rw',
              max_file_size: 0,
              max_path_length: 0,
              usage: { total: 1, used: 1, free: 0, percent: 61.2 },
            },
            {
              device: 'D:\\',
              mount_point: 'D:\\',
              filesystem_type: 'NTFS',
              options: 'rw',
              max_file_size: 0,
              max_path_length: 0,
              usage: { total: 1, used: 1, free: 0, percent: 10 },
            },
          ],
        },
      ],
    },
    battery: { is_charging: null, percentage: null, time_remaining: null },
    gpus: [{ id: 'GPU-0a1b', name: 'NVIDIA RTX 4060', core_load: 3, temperature: 41 }],
    ...overrides,
  };
}

function frame(opcode, payload, { fin = true } = {}) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  return Buffer.concat([header, payload]);
}

export const textFrame = (text, options) => frame(0x1, Buffer.from(text, 'utf8'), options);
export const rawFrame = frame;

/**
 * @param {object} [options]
 * @param {string} [options.token]
 * @param {object} [options.modules] the data served (module -> data)
 * @param {'ok' | 'http429' | 'badAccept'} [options.handshake]
 * @param {'answer' | 'silent' | 'error'} [options.commands]
 */
export async function startFakeBridge({
  token = TOKEN,
  modules = windowsModules(),
  handshake = 'ok',
  commands = 'answer',
} = {}) {
  const fake = { token, modules, handshake, commands, received: [], sockets: new Set() };
  const server = createServer((req, res) => {
    res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {});
    if (fake.handshakeDelayMs) {
      setTimeout(() => upgrade(req, socket), fake.handshakeDelayMs);
    } else upgrade(req, socket);
  });

  function upgrade(req, socket) {
    if (socket.destroyed) return;
    if (fake.handshake === 'http429') {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 120\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const accept =
      fake.handshake === 'badAccept'
        ? 'nope'
        : createHash('sha1').update(`${key}${GUID}`).digest('base64');
    const connection = fake.handshake === 'noConnection' ? '' : 'Connection: Upgrade\r\n';
    const protocol = fake.handshake === 'protocol' ? 'Sec-WebSocket-Protocol: chat\r\n' : '';
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n${connection}${protocol}Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    fake.sockets.add(socket);
    socket.on('close', () => fake.sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        if ((buffer[1] & 0x80) === 0) fake.unmasked = true;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          length = buffer.readUInt32BE(6);
          offset = 10;
        }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
        buffer = buffer.subarray(offset + 4 + length);
        if (opcode === 0x8) {
          socket.end(frame(0x8, payload.subarray(0, 2)));
          return;
        }
        if (opcode === 0xa) {
          fake.pongs = (fake.pongs ?? 0) + 1;
          continue;
        }
        if (opcode === 0x1) handle(socket, payload.toString('utf8'));
      }
    });
  }

  const send = (socket, message) => socket.write(textFrame(JSON.stringify(message)));

  function handle(socket, text) {
    const message = JSON.parse(text);
    fake.received.push({
      event: message.event,
      data: message.data,
      tokenOk: message.token === fake.token,
      at: Date.now(),
    });
    if (message.token !== fake.token) {
      send(socket, {
        id: message.id,
        type: 'ERROR',
        subtype: 'BAD_TOKEN',
        message: 'Invalid token',
        data: {},
      });
      return;
    }
    if (message.event === 'GET_DATA') {
      send(socket, {
        id: message.id,
        type: 'DATA_GET',
        subtype: 'NONE',
        data: message.data,
        message: 'Getting data',
      });
      for (const module of message.data.modules) {
        if (!(module in fake.modules)) continue;
        send(socket, {
          id: 'system',
          type: 'DATA_UPDATE',
          subtype: 'NONE',
          module,
          data: fake.modules[module],
        });
      }
      return;
    }
    const answer = ANSWERS[message.event];
    if (!answer || fake.commands === 'error') {
      send(socket, {
        id: message.id,
        type: 'ERROR',
        subtype: 'BAD_REQUEST',
        message: 'no',
        data: {},
      });
      return;
    }
    if (fake.commands === 'silent') return;
    send(socket, {
      id: message.id,
      type: answer,
      subtype: 'NONE',
      data: message.data,
      message: 'ok',
    });
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = server.address().port;
  fake.address = { hostname: '127.0.0.1', port: fake.port, label: `127.0.0.1:${fake.port}` };
  /** Write raw bytes to every connected client. */
  fake.raw = (bytes) => {
    for (const socket of fake.sockets) socket.write(bytes);
  };
  fake.close = () =>
    new Promise((resolve) => {
      for (const socket of fake.sockets) socket.destroy();
      server.close(() => resolve());
    });
  return fake;
}
