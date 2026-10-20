# gladys-system-bridge

[Gladys Assistant](https://gladysassistant.com) external integration for
**System Bridge** ([timmo001/system-bridge](https://github.com/timmo001/system-bridge)):
a Windows or Linux PC becomes a Gladys device (online, CPU, memory, disks,
GPU, battery, users, uptime, camera and microphone in use) with lock, sleep,
hibernate, restart, shut down and open-the-URL buttons. Every action but lock
is off by default; nothing ever sends a command line nor keystrokes.
**Unofficial integration, not affiliated with System Bridge. Never tested with
a real PC yet.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (SystemBridgeApp)
                 ├─ src/bridge/client.js   System Bridge protocol (GET_DATA, POWER_*, OPEN)
                 ├─ src/bridge/ws.js       the only network access: a bounded WebSocket client
                 ├─ src/bridge/parse.js    modules -> one checked snapshot of the PC
                 ├─ src/bridge/errors.js   error codes (never holding the token)
                 ├─ src/store.js           /data: refusals, 429 / 503 pause (never the token)
                 └─ src/devices.js         the device of the PC (pure)
```

- **Connection**: one WebSocket to `ws://<host>:9170/api/websocket`, kept
  between readings, reopened by the next reading. Each request is one JSON
  message `{ token, id, event, data }`; System Bridge has no TLS, so the token
  crosses the network in clear (said in the configuration).
- **Readings** (every 30 s to 5 min, 60 s by default): `GET_DATA` for
  `system`, `cpu`, `memory`, `disks`, `battery`, `gpus` (never `processes`,
  `media`, `networks`). External id: `pc:<machine uuid>`. A disk or GPU seen
  once is never dropped from the device. When the PC does not answer:
  `online` = 0, transport unreachable, retry 30 s to 5 min, never faster than
  the interval.
- **Errors**: `BAD_TOKEN` stops everything; a salted HMAC of the address and
  token is kept in `/data` and the same values are tried again alone once
  after 6 h (saved configuration or test button: at once). HTTP 429 / 503 on
  the upgrade pauses every path (Retry-After, 1 min to 6 h, kept in `/data`).
- **Limits**: a message is read up to 4 MiB and 1024 frames (closed before
  buffering more), frames checked (unmasked, known opcodes from the header,
  small control frames, valid UTF-8), one pong waiting at most, the byte
  queue parsed in linear time, unsolicited messages capped; every value is
  type- and range-checked, lists are cut (12 disks, 4 GPUs).
- **Commands**: push buttons, never switches. Lock is always allowed, never
  waits, cancels an "open the URL" not sent yet, and goes only to the PC read
  last on the connection open now. Sleep, hibernate, restart, shut down
  (`allow_power_actions`) and open the URL (`allow_open_url` + an http(s)
  URL) are off by default, checked on arrival and just before sending against
  the configuration in use and the last one saved, one at a time, after a
  fresh read of the PC (same machine id) and on that connection only;
  nothing written past 3.5 s, Gladys answered at 4.3 s at most ("sent,
  without confirmation" when System Bridge did not answer).

## Development

```bash
npm install
npm test                                        # node --test, no network (loopback only)
npm run lint && npm run format:check
npm run audit                                   # production dependencies
npm run cover                                   # regenerate cover.png
npx github:GladysAssistant/integration-store .  # store admission checks
```

The tests run against the SDK's fake Gladys and a fake PC
(`test/helpers/fakePc.js`), and the client against a fake System Bridge on
loopback (`test/helpers/fakeBridge.js`: real sockets, real framing). No test
touches a real PC or the Internet.

## Credits

- [timmo001/system-bridge-connector](https://github.com/timmo001/system-bridge-connector)
  (Apache-2.0): the protocol, ported to JavaScript, and
  [timmo001/system-bridge](https://github.com/timmo001/system-bridge)
  (Apache-2.0) to check it (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
- [gladys-portainer](https://github.com/LM1LC3N7/gladys-portainer): the
  structure of the app, the retry policy and the command safety rules.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0.
