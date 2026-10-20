# TODO — System Bridge v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own: the claim is in /t/10385 (lot 10).

## Status

- [x] **Milestone 1 — core** (2026-10-20): bounded WebSocket client (RFC
      6455 on node:http, 4 MiB per message, frames checked), System Bridge
      protocol ported from system-bridge-connector (GET_DATA / DATA_GET /
      DATA_UPDATE, POWER_*, OPEN, BAD_TOKEN), one device per PC keyed by its
      machine uuid, readings of system / cpu / memory / disks / battery /
      gpus, features never dropped, online 0 and retry when the PC is off,
      token refusal persisted (HMAC) with one spaced retry after 6 h, 429 /
      503 pause persisted, buttons lock / sleep / hibernate / restart / shut
      down / open the URL with the safety rules below, "Test the connection",
      docs en/fr, cover. Tested with unit tests against the SDK's fake
      Gladys, a fake PC, and a fake System Bridge on loopback (real sockets
      and framing). **Never tested with a real PC.** No Docker on this PC: no
      e2e test in a container. The store validator
      (`npx github:GladysAssistant/integration-store .`) could not be run by
      the development agent.
- [ ] **Milestone 2 — real PC** (a tester with System Bridge 5 on Windows and
      Linux): record real answers as fixtures (token removed), fix what
      differs. To check first:
  - the `uuid` of `system`: present and stable on Windows and Linux (reboot,
    update of System Bridge)? Else fall back to the MAC address;
  - which modules answer on a desktop without battery or GPU (a module that
    never answers costs a 5 s wait per reading);
  - the size of `disks` and `gpus` on a Linux box with many mounts (snap,
    docker, flatpak): the filters of `src/bridge/parse.js`;
  - `cpu.temperature` on Windows (needs a sensor provider?);
  - the answer of a power command before the PC goes down: does
    `POWER_SHUTTINGDOWN` always arrive (1 s delay in the server)?;
  - System Bridge closing an idle WebSocket: is a ping needed between
    readings at 5 min?;
  - `BAD_TOKEN` on the very first message, and an older System Bridge (4.x):
    same events?
- [ ] **Later**
  - Several PCs in one integration (today: one address and token).
  - A scene trigger "PC went offline / came online" (today: the `online`
    feature in a scene).
  - Wake-on-LAN for a PC that sleeps (System Bridge cannot wake it; needs the
    MAC and a broadcast from the Gladys host: probably a separate integration).
  - Media player (System Bridge `media` module, MEDIA_CONTROL): play / pause /
    volume, volume capped by an option.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-system-bridge:0.1.0`):
  the first Release (patch) gives 0.1.1.
- **No library at runtime.** systembridgeconnector is Python; its protocol is
  ported (Apache-2.0, THIRD_PARTY_NOTICES.md). The WebSocket client is our own
  (`src/bridge/ws.js`) so that every limit is ours: the size of a message is
  refused from the frame header, before buffering; Node's global WebSocket
  has no such limit.
- **One WebSocket, kept open** between readings and reopened by the next
  reading (never by a timer of its own): a reconnection is never faster than
  the refresh interval. Polling with GET_DATA rather than
  REGISTER_DATA_LISTENER: the pace is ours, not the server's broadcast.
- **The machine uuid of System Bridge is the external id** (lowercased,
  `[a-z0-9._-]`, 64 at most); without it the reading is refused. Disks are
  keyed by their mount point (`disk_c`, `disk_root`, `disk_mnt-data`), GPUs by
  their id; two mount points giving the same key: the first one keeps it.
- **No percent unit for CPU, memory, disk and GPU load**: no core category
  lists a percent for them (`DEVICE_FEATURE_UNITS_BY_CATEGORY`):
  `unknown`/`unknown` without unit, the name says "(%)" (like gladys-portainer).
  Temperatures in `device-temperature-sensor` (°C), memory used in MB (`data`),
  uptime in hours (`duration`), power in W (`energy-sensor`/`power`, an
  instantaneous value, never an index), users as a `counter-sensor`.
- **Online, camera, microphone, restart pending, update available** are read
  only `unknown`/`binary`, never a switch.
- **Buttons only.** Lock is protective: always allowed (no option), never
  blocked by another command, and it cancels an "open the URL" still being
  checked. Sleep, hibernate, restart and shut down share one option
  (`allow_power_actions`, off); open the URL has its own (`allow_open_url`,
  off) and a fixed URL from the configuration (http or https, no credentials,
  2000 characters at most): never a value from a scene, never a path (on
  Windows a path or another scheme can start a program). Log out is not
  offered (unsaved work lost, no use in a home).
- **Never sent**: COMMAND_EXECUTE, KEYBOARD_KEYPRESS / KEYBOARD_TEXT, OPEN
  with a path, NOTIFICATION, MEDIA_CONTROL, UPDATE_SETTINGS,
  APPLICATION_UPDATE, EXIT_APPLICATION, GET_FILE(S).
- **Commands**: the value must be 1, '1' or true; the PC is read again
  (`system` only) and its uuid compared before a power or open command; the
  option is checked on arrival and just before sending; one such command at a
  time; nothing sent when less than 0.5 s is left of the 3.5 s budget; Gladys
  answered at 4.3 s at most. A command written but not confirmed is "sent,
  without confirmation", never "not sent"; an ERROR answer is "refused".
- **A refused token** (BAD_TOKEN, BAD_API_KEY, MISSING_TOKEN): every path
  stops; an HMAC (salt of `/data`) of address + token and the time of the next
  try are kept; a restart with the same values sends nothing before 6 h, then
  one try. Saving the configuration or the test button tries at once.
- **429 / 503** on the upgrade: a pause of 1 min to 6 h (Retry-After), kept in
  `/data`, read back capped at 6 h; lifted by the user only.
- **Not read**: processes, media, networks, displays, sensors (large or
  private); user names, application names, IP and MAC addresses are never
  published nor logged. The address of the PC is logged (it is configuration).
- **States budget**: at most ~45 features per PC, one reading every 30 s at
  the fastest, through `publishChangedStates`: far under 300 states/min, no
  budget window needed.
- **`gladys_version` >= 5.1.0** like the other integrations of the author
  (no trigger nor widget needed today).
