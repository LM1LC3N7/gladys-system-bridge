# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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

[Unreleased]: https://github.com/LM1LC3N7/gladys-system-bridge/commits/main
