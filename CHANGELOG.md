# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version, never tested with a real Smile: Plugwise Smile P1, Anna and
  Adam through the local XML API (`/core/domain_objects`, plain HTTP, user
  name `smile` and the Smile ID), ported from python-plugwise. Current
  firmwares only; older ones, the Stretch and an Anna connected to an Adam
  are said in the status.
- Smile P1 (and Anna P1): power taken and injected, the consumption index
  (peak + off-peak) for the energy monitoring through the index guard of
  gladys-p1-monitor (never 0, tariffs checked, a jump or a drop held until
  the "Accept the held index" button), indexes per tariff and injection as
  plain sensors, gas as a volume sensor, phases.
- Anna and Adam: per zone temperature, setpoint, heating state, mode, preset
  and active schedule; boiler flame, heating, hot water, temperatures,
  pressure, modulation; outdoor temperature; Adam gateway and regulation
  modes; Plugwise plugs (power, relay).
- Commands, off by default: setpoint, preset, Adam gateway mode and
  regulation mode (heating / cooling only) behind `allow_climate`; relay of
  the unlocked lighting and entertainment plugs behind `allow_plugs` (a plug
  feeding a boiler, a pump, a fridge... is read only). Fresh read before
  acting, 3.5 s budget, answer at 4.3 s at most. A command waits for the
  request of the previous one to really end (bounded by its timeout), so it
  never concludes "already set" on a state the Smile has not applied yet;
  a permission taken away in the configuration applies at once.
- A minimal XML reader without DTD (no XXE, no entity expansion), bounded
  and linear; the model read in linear time, an answer with more than 500
  zones, plugs, rules or presets refused.
- The state in `/data` (index guard per meter, refusal hash, 429 pause)
  written one save after the other.
- Buttons "Test the connection" and "Accept the held index".

[Unreleased]: https://github.com/LM1LC3N7/gladys-plugwise/commits/main
