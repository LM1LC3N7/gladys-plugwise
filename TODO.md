# TODO — Plugwise (Smile P1, Anna, Adam) v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own: the claim is in /t/10385 (post #275, lot 8,
  wave 2).

## Status

- [x] **Milestone 1 — core** (2026-10-18): local XML API of the Smile ported
      from python-plugwise (`/core/domain_objects`, basic authentication
      `smile:<ID>`); a minimal XML reader without DTD; Smile P1 (powers,
      consumption index through the index guard of gladys-p1-monitor,
      tariffs, injection, gas, phases), Anna and Adam (zones, boiler, outdoor
      temperature, modes, plugs); commands off by default (setpoint, preset,
      Adam modes, plugs) with a fresh read before acting; 401 / 429 kept in
      `/data`; buttons "Test the connection" and "Accept the held index";
      docs en/fr. Tested with unit tests against the SDK's fake Gladys and a
      fake Smile serving the test data of python-plugwise.
      **Never tested with a real Smile.** No Docker on this PC: no e2e test
      in a container. The store validator only refuses the Docker image (not
      published yet).
- [ ] **Milestone 2 — real Smile** (a tester with a P1, an Anna or an Adam):
      record real answers as fixtures (IDs and MAC addresses removed), fix
      what differs. To check first:
  - the time an Adam takes to answer `/core/domain_objects` (a large one is
    about 220 KB): a command reads it again within 2.7 s; if too slow, read
    only the location / appliance (`/core/locations;id=…`, to be checked on
    a real Smile) before acting;
  - whether a PUT answers 200 or 202 at once, and how soon the next read
    shows the new setpoint / preset / relay;
  - the gateway mode "away" / "vacation" dates (python-plugwise sends the
    Smile's time and yesterday 23:00 UTC);
  - the Anna with cooling (Elga, Loria): setpoint_low / setpoint_high are not
    handled (one setpoint, the one of the thermostat functionality);
  - the reachability of the plugs (ZigBee module `reachable`): not read yet;
  - an Adam with an on/off boiler (city heating): heating state from the
    valves in python-plugwise, not ported.
- [ ] **v2 ideas**: schedule on / off (the rule PUT of python-plugwise, needs
      an XML writer of the contexts), hot water comfort mode (with a
      temperature cap), temperature offset, plug groups, the Plugwise
      notifications as text, the battery of the zone thermostats.

## Decisions

- **Version**: 0.1.0 set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag; the first Release (patch) gives 0.1.1.
- **License**: Apache-2.0, the standard text (no person named), shipped in the
  image with `THIRD_PARTY_NOTICES.md` (full MIT notice of python-plugwise,
  checked: MIT, not GPL).
- **XML reader of our own** rather than fast-xml-parser: the answers of the
  Smile are simple (elements, attributes, text); ~200 lines that refuse any
  DTD (XXE, entity expansion impossible), decode only the five predefined
  entities and character references (a bare `&`, which the Smile may send,
  stays `&`), bound the size (4 MiB, after the 4 MiB cap of the HTTP body),
  the depth (64), the elements (200,000) and the attributes (32), run in one
  linear pass, and keep attributes in a `Map` (no prototype pollution). No
  runtime dependency but the SDK, nothing to audit or update.
- **Size cap 4 MiB** (not the 64 KB of the other XML integrations): a large
  Adam answers about 220 KB (python-plugwise test data); 4 MiB leaves room
  for big installations while bounding memory.
- **Current firmwares only** (the answer has a `<gateway>`): Smile P1 v4,
  Anna v4, Adam v3, as python-plugwise's non-legacy path. Legacy firmwares,
  the Stretch and an Anna connected to an Adam are refused with a message;
  an unsupported Smile is read again every 10 min.
- **External ids**: the Plugwise ids (32 hexadecimal characters), stable:
  `meter:` and `gateway:` on the gateway appliance id, `heater:` on the
  heater_central id, `zone:` on the location id (the Anna's room too), `plug:`
  on the appliance id. A new address keeps every device.
- **Energy**: the guard of gladys-p1-monitor (`src/guard.js`, approved) taken
  as is, with its tests. `consumption_index` = off-peak + peak (indexOfTariffs
  with low = off-peak, high = peak), published once a minute, never 0; a
  jump or drop held, accepted only by the bounded "Accept the held index"
  button; state in `/data`. The index feature exists only when both tariffs
  are present at discovery ("reliable" meter); otherwise plain sensors only.
  Tariffs and injection: `unknown` / `decimal`, kWh in the name. Gas:
  `volume-sensor` m³, never `publishEnergyConsumption`. Power: the only
  `energy-sensor` / `power`; a power with one tariff unreadable is undefined
  (never a partial sum); stale after 5 min with the same log date.
- **Commands off by default**: `allow_climate` (setpoint, preset, Adam modes)
  and `allow_plugs` (relays), checked when the command arrives AND just
  before sending. Features are created writable (read_only is fixed at
  creation), the permission is checked at each command.
- **Fresh read before acting**: the whole `/core/domain_objects` (the only
  endpoint known to work on every Smile), within 2.7 s of the command; the
  decision (bounds, presets, modes, lock, type, "already set") is taken on
  that read only; the read is also published (newest state), without being
  awaited by the answer to Gladys. Nothing sent past 3.5 s; the PUT must be
  connected by then (`sendWithin`), else "not sent"; once connected, Gladys
  is answered at 4.3 s at most: "sent, without confirmation" (no answer yet,
  a timeout or a 5xx after sending), "refused" (4xx), "not sent" (never
  connected). The Smile is read again 5 s after any command that left.
  Commands are serialized (one Smile).
- **Setpoint**: 4-30 °C (python-plugwise MIN/MAX_SETPOINT) narrowed to the
  bounds the Smile gives for the zone; raw value checked before rounding to
  0.1 °C, never clamped; null, '' and booleans refused.
- **Regulation mode**: only `heating` and `cooling` can be set; `off` (the
  heating stops: frost risk) and the bleeding cycles (pump and boiler run
  for 5 minutes) stay in the Plugwise app. **Gateway mode**: away / full /
  vacation, as python-plugwise.
- **Plugs**: a relay is commandable only when the plug is NOT locked in
  Plugwise (lock missing counts as locked, as python-plugwise) AND its type is
  lamp, lighting, tv, hometheater, settop, vcr, game_console or charger. Any
  other type (heater_central, central_heating_pump, heater_electric,
  valve_actuator, water_heater_vessel, refrigerator, freezer, router,
  dishwasher, washingmachine, dryer, watercooker, computer_desktop,
  zz_misc "other", unknown) is refused, and its state is created read only
  (`unknown` / `binary`), never a `switch`: "turn everything off" and the
  voice assistants never reach it. Lock and type are read again before
  acting. The fixtures show a fridge with lock `false`: the lock alone is not
  enough.
- **Mode and schedule read only** in v1: `thermostat` / `mode` (off 0, heat 1,
  cool 2, auto 3) and the active schedule as text. Switching a schedule
  needs the rule PUT of python-plugwise (an XML writer of the contexts): v2.
- **Preset and Adam modes as `text` / `select`**: the options are the
  Smile's (`supported_options`, upserted on each Discovery); the THERMOSTAT
  preset enum of Gladys has no "vacation" next to "away" (both would be
  AWAY).
- **Never lose a feature**: a device republished keeps every feature of the
  created one (from `gladys.devices`) and its shape (category, type, unit,
  bounds, read_only).
- **HTTP 401**: final until the user saves the configuration or presses
  "Test the connection"; kept in `/data` as a salted scrypt hash of the address
  and the ID (never the ID; a plain hash of 8 characters could be brute-forced). **HTTP 429**: 1 min to 6 h for every path, kept in
  `/data` (read back capped at 6 h). Neither is cleared by a reconnection to
  Gladys.
- **Intervals**: 10 s for a P1 (Home Assistant's), 30 s for an Anna / Adam
  (Home Assistant: 60 s); retries 30 s to 10 min, never faster than the
  reading; heartbeat 10 min; at most 250 states a minute (rotating cut).
- **Gladys 5.2.0 minimum**: `text` / `select` features with
  `supported_options` and the thermostat mode / operating state types are
  recent in the core.
- **Logs**: codes and HTTP statuses only, never the body of an answer, the
  Smile ID or the Authorization header.
- **Test data**: python-plugwise's `core.domain_objects.xml` files (MIT,
  credited) in `test/fixtures/`, unchanged; the expected values are those of
  its own `data.json` fixtures.
