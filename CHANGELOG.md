# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-23

## [0.1.1] - 2026-10-20

### Added

- First version, never tested with a real PC: a Windows or Linux PC running
  System Bridge, through its local WebSocket API and its token.
- One device per PC, keyed by its machine id: online, CPU load and
  temperature, memory load and used, usage of each disk (12 at most), GPU load
  and temperature (4 at most), battery and charging, power, users logged in,
  uptime, camera and microphone in use, restart pending, update available. A
  disk or GPU seen once is never dropped from the device.
- Buttons Lock (always allowed, cancels an "open the URL" not sent yet),
  Sleep, Hibernate, Restart, Shut down (off by default) and Open the URL (off
  by default, http or https only). Never a switch; never a command line,
  keystrokes, a file nor a path. Checked again just before sending, after a
  fresh read of the PC; nothing sent past 3.5 s; "sent, without
  confirmation" when System Bridge does not answer in time.
- A refused token stops everything and is tried again alone only once after
  6 hours; HTTP 429 / 503 pauses every request (1 min to 6 h), kept across
  restarts. The token is never logged nor written in `/data`.
- Refresh every 30 s to 5 min; retry 30 s to 5 min when the PC does not
  answer, never faster than the refresh.
- Button "Test the connection".

### Security

- WebSocket frames bounded in count as well as in size: a message in more
  than 1024 frames or an empty non-final continuation closes the connection;
  one pong waiting at most, 100 pings in a row at most, nothing written to a
  peer that does not read; binary, reserved and unknown opcodes refused from
  the header; the byte queue parsed in linear time, and a frame whose header
  is known is copied into one buffer of its size as it arrives (no chunk
  kept: a frame dripped byte by byte costs its own size, not 200 times it); a 101 without
  `Connection: Upgrade` or with a subprotocol refused; a 1-byte close frame
  refused; messages nobody asked for (50, or 8 MiB) close the socket.
- A command is never written later than 3.5 s after it arrived, even when the
  connection opens later (a shared opening included); a verified command is
  written only on the connection of its fresh reading.
- The permissions are checked against the configuration in use and the last
  one saved: a command arriving while a start still reads the PC follows the
  saved choice; a configuration saved meanwhile cancels the command, and the
  URL opened is the saved one.
- Lock goes only to the PC read last (same machine id), on the connection
  open now: never a new connection, so never during a 429 / 503 pause. A
  429 / 503 met by a command or the reading after it pauses every path.
- An error subtype from System Bridge is shown only when it is a plain
  constant name.

### Changed

- Never a reading faster than the refresh: several commands give one reading
  a few seconds later; Discovery and a reconnection to Gladys right after a
  reading publish it as is and keep the pace.
- A module answered with no data (a desktop without GPU) no longer costs a
  5 s wait per reading.
- Disk keys are unique per mount point (`/` is `root`, `/mnt/data` is
  `mnt-data`, any other mount point gets a short hash: `/root`,
  `/mnt-data`...); a GPU is keyed by its id only (none: left out). Under
  Windows, the temperature of a GPU whose id is not `nvidia-<n>` (an ACPI
  zone of the board) is not published.

[Unreleased]: https://github.com/LM1LC3N7/gladys-system-bridge/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-system-bridge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-system-bridge/releases/tag/v0.1.1
