# gladys-plugwise

[Gladys Assistant](https://gladysassistant.com) external integration for
**Plugwise Smile** gateways through their local XML API: the **Smile P1**
(smart meter power, the electricity index for the energy monitoring, indexes
per tariff, injection, gas), the **Anna** and the **Adam** (zones:
temperature, setpoint, preset, mode, schedule; boiler: flame, heating, hot
water, temperatures, pressure; outdoor temperature; Adam modes and plugs).
The setpoint, the preset, the Adam modes and the plugs can be commanded,
each behind an option off by default. Local HTTP, no cloud.
**Unofficial integration, not affiliated with Plugwise. Never tested with a
real Smile yet.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (PlugwiseApp)
                 ├─ src/smile/client.js   the Smile's paths, basic auth smile:<ID>, commands
                 ├─ src/smile/http.js     the only network access (node:http, plain HTTP)
                 ├─ src/smile/xml.js      a minimal XML reader: no DTD, bounded, linear
                 ├─ src/smile/model.js    domain_objects -> plain objects (ported from python-plugwise)
                 ├─ src/guard.js          the index guard of gladys-p1-monitor (as is)
                 ├─ src/devices.js        devices and states (pure)
                 ├─ src/budget.js         states per minute
                 └─ src/store.js          /data: index guard, refusal, 429 pause
```

- **Smile**: `GET /core/domain_objects` with HTTP basic authentication
  `smile:<Smile ID>`, every 10 s for a P1, 30 s for an Anna or an Adam.
  Current firmwares only (the answer has a `<gateway>` element). External
  ids are the Plugwise ids: `meter:<gateway id>`, `gateway:<gateway id>`,
  `heater:<appliance id>`, `zone:<location id>`, `plug:<appliance id>`.
- **XML**: a reader of our own (`src/smile/xml.js`, ~200 lines, no
  dependency) rather than a library: the answers are simple, and the reader
  refuses any DTD (no XXE, no entity expansion), decodes only the five
  predefined entities and character references, bounds the size, depth and
  element count, runs in one linear pass, and keeps attributes in a `Map`
  (no prototype pollution). The HTTP layer caps the body at 4 MiB first.
- **Energy** (P1): `consumption_index` (peak + off-peak, kWh) is the only
  `energy-sensor` / `index` feature, created only when the meter gives both
  tariffs; it goes through the approved index guard of gladys-p1-monitor
  (never 0, tariffs checked one by one, a jump or a drop held until the
  user's bounded acceptance, kept in `/data`). Tariffs, injection and gas
  are plain sensors.
- **Commands** (`allow_climate`, `allow_plugs`, both off by default): the
  setpoint (4-30 °C within the zone's bounds), the preset, the Adam gateway
  mode, the Adam regulation mode (heating / cooling only), the relay of a
  plug (unlocked lighting / entertainment plugs only; the others are read
  only, never a `switch`). The Smile is read again just before acting and
  the decision is taken on that read only; nothing is sent past 3.5 s; Gladys
  is answered at most 4.3 s after the command ("sent, without confirmation"
  when the Smile has not answered); the Smile is read again 5 s later.
- **Failures**: unreachable, retried 30 s to 10 min (never faster than the
  reading); HTTP 401 final until the user acts, kept in `/data` as a hash;
  HTTP 429 pauses every path 1 min to 6 h, kept in `/data`. Errors are logged
  as codes, never with the text of the answer nor the Smile ID.
- **Reconnection to Gladys**: status, Discovery, states and badges are
  published again; the client, a refusal and a pause stay. A device
  republished never loses a feature of the created one, nor changes its
  shape.

## Development

```bash
npm install
npm test                                        # node --test, no network (loopback only)
npm run lint && npm run format:check
npm run audit                                   # production dependencies
npm run cover                                   # regenerate cover.png
npx github:GladysAssistant/integration-store .  # store admission checks
```

The tests run against the SDK's fake Gladys and a fake Smile serving the test
data of python-plugwise (`test/fixtures/`, MIT). No test touches a real Smile
or the Internet.

## Credits

- [python-plugwise](https://github.com/plugwise/python-plugwise) (MIT), the
  library of the Home Assistant `plugwise` integration: the protocol of the
  Smile, ported to JavaScript, and its test data (see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
- [gladys-p1-monitor](https://github.com/LM1LC3N7/gladys-p1-monitor): the
  index guard, as is; [gladys-incomfort](https://github.com/LM1LC3N7/gladys-incomfort):
  the structure of the app, the retry policy and the command checks.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0.
