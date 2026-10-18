# Third-party notices

This integration ports to JavaScript the logic of the projects below for
talking to a Plugwise Smile. Nothing of them is installed at runtime: they
are Python, this integration is JavaScript.

## python-plugwise

<https://github.com/plugwise/python-plugwise> (read at commit `4b78fde`,
2026-10-16), the library of the Home Assistant `plugwise` integration,
licensed under the MIT License.

Ported in `src/smile/client.js`, `src/smile/model.js` and `src/constants.js`:
the local API of the Smile (`/core/domain_objects`, HTTP basic
authentication with the user name `smile` and the Smile ID, the PUT requests
and XML bodies of the setpoint, preset, gateway mode, regulation mode and
relay commands, the end date of the away / vacation modes), the detection of
the Smile (the `<gateway>` element, `vendor_model` and firmware major, the
outdated firmwares, an Anna connected to an Adam), the reading of the smart
meter (point and cumulative logs per `nl_peak` / `nl_offpeak` tariff, Wh to
kWh, gas, phases, the "P1 does not seem to be connected" notification), of
the boiler (the `Central heating boiler` heater_central, its measurements,
the obsolete measurements after 7 days, the modulation of older firmwares),
of the zones (thermostat functionality and bounds, presets from the preset
rules, active schedule from the schedule rules and their contexts, the
ranking of thermostat types), of the plugs (description, relay state and
lock), the Adam modes (allowed regulation modes, the three gateway modes),
and the setpoint bounds 4-30 °C. The XML files of `test/fixtures/` are its
test data (`userdata/*/core.domain_objects.xml`), unchanged.

```
MIT License

Copyright (c) 2019 @laetificat, 2019-2020 @CoMPaTech & @bouwew, 2020-current @CoMPaTech, @bouwew & @brefra

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

(The copyright line is the one of the project's own LICENSE file, reproduced
as it is.)

## LM1LC3N7/gladys-p1-monitor and LM1LC3N7/gladys-incomfort

The index guard (`src/guard.js`, taken as is with its tests), the `/data`
store, the structure of the app, the handler wiring, the retry and pause
policy and the command checks follow integrations of the same author, under
the Apache License 2.0 of this repository.
