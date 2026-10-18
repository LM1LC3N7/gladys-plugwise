# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Plugwise Smile gateways
(Smile P1, Anna, Adam) through their local XML API: a Node.js service (Node
22+, ESM, no build step) that runs in its own sandboxed Docker container and
talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template;
the protocol is ported from python-plugwise (MIT, see THIRD_PARTY_NOTICES.md).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "plug"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # regenerate cover.png
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js              SDK wiring only (src/handlers.js registers every handler before connect())
src/handlers.js       the SDK handlers, shared with the tests
src/app.js            PlugwiseApp: lifecycle, reading loop, states, commands, buttons
src/smile/client.js   the Smile's paths, basic auth smile:<ID>, the command requests
src/smile/http.js     the only network access (node:http, plain HTTP, deadline, size cap)
src/smile/xml.js      minimal XML reader: no DTD, bounded, linear, no prototype pollution
src/smile/model.js    /core/domain_objects -> plain objects (pure)
src/smile/errors.js   error codes
src/devices.js        Gladys devices and states (pure), never losing a created feature
src/guard.js          the index guard of gladys-p1-monitor, taken AS IS (approved)
src/store.js          /data: index guard, Smile ID refusal (hash), 429 pause
src/budget.js         states per minute
src/config.js         DEFAULTS (mirror the manifest defaults) + normalization
src/i18n.js           texts (status and buttons en/fr, errors en, device names fr/en)
src/constants.js      keys, limits, timings, the plug types that may be switched
test/                 node --test, against the SDK's fake Gladys and a fake Smile
test/fixtures/        python-plugwise test data (MIT), unchanged
```

## Rules

- **External ids are forever**: `<kind>:<Plugwise id>`. The same goes for every
  key users store: manifest `config_schema`, `actions`, feature keys.
- **The container rootfs is read-only.** Write only under `/data`. Never log
  the Smile ID, the Authorization header or the body of an answer.
- **Energy**: `consumption_index` is the only energy index; it always goes
  through `src/guard.js` (never modify the guard without a review); gas and
  injection are never in the energy monitoring.
- **Commands** stay behind `allow_climate` / `allow_plugs` (off by default),
  checked at arrival and just before sending, decided on a fresh read only.
  Never add a plug type to `SWITCHABLE_PLUG_TYPES` that could feed heating,
  cold, water or the network. Never a `switch` for a plug that is not
  switchable.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`.
  A `secret` field is NOT encrypted by Gladys: never write "encrypted".
- **User-facing text** is bilingual (English and French): status, button
  answers, manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
  Files are UTF-8 without BOM (`test/encoding.test.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (loopback only).
