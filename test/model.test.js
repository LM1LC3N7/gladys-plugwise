// -----------------------------------------------------------------------------
// What a Smile shows (src/smile/model.js), against the test data of
// python-plugwise (userdata/*/core.domain_objects.xml, MIT): the values are
// those its own fixtures expect (fixtures/*/data.json).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseXml } from '../src/smile/xml.js';
import { MODEL_LIMITS, number, onOff, parseDomainObjects } from '../src/smile/model.js';

export const fixture = (name) =>
  readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), 'utf8');
/** The time of the Smile in its answer: the measurements are fresh then. */
const timeOf = (xml) => Date.parse(/<time>([^<]+)<\/time>/.exec(xml)?.[1] ?? '');
const read = (name, now) => {
  const xml = fixture(name);
  return parseDomainObjects(parseXml(xml), { now: now ?? timeOf(xml) });
};

test('numbers and on/off as the Smile writes them, nothing else', () => {
  assert.equal(number('20.50'), 20.5);
  assert.equal(number('-3'), -3);
  assert.equal(number('0.00'), 0);
  for (const bad of ['', ' 1', '1e3', 'NaN', '0x10', '1.', undefined, null, 12]) {
    assert.equal(number(bad), undefined, String(bad));
  }
  assert.equal(onOff('on'), true);
  assert.equal(onOff('true'), true);
  assert.equal(onOff('off'), false);
  assert.equal(onOff('false'), false);
  assert.equal(onOff('ON'), undefined);
  assert.equal(onOff(''), undefined);
});

test('Smile P1 v4, single phase: powers, indexes per tariff in kWh', () => {
  const model = read('p1v4_442_single');
  assert.equal(model.supported, true);
  assert.equal(model.smile, 'p1');
  assert.equal(model.firmware, '4.4.2');
  assert.match(model.gatewayId, /^[0-9a-f]{32}$/);
  assert.equal(model.zones.length, 0);
  assert.equal(model.gateway, undefined);
  const { meter } = model;
  assert.equal(meter.connected, true);
  assert.equal(meter.power, 486);
  assert.equal(meter.injectionPower, 0);
  assert.deepEqual(meter.consumption, { peak: 13966.608, offpeak: 17643.423 });
  assert.deepEqual(meter.injection, { peak: 0, offpeak: 0 });
  assert.equal(meter.gas, undefined);
  assert.deepEqual(meter.phases, [{ consumed: 486, produced: 0, voltage: undefined }]);
  assert.ok(meter.powerDate);
});

test('Smile P1 v4, three phases and gas', () => {
  const { meter } = read('p1v4_442_triple');
  assert.equal(meter.power, 5553);
  assert.deepEqual(meter.consumption, { peak: 161328.641, offpeak: 70537.898 });
  assert.equal(meter.gas, 16811.37);
  assert.deepEqual(
    meter.phases.map((p) => [p.consumed, p.produced, p.voltage]),
    [
      [1763, 0, 233.2],
      [1703, 0, 234.4],
      [2080, 0, 234.7],
    ],
  );
});

test('the P1 not connected: said by a notification of the Smile', () => {
  const xml = fixture('p1v4_442_single').replace(
    '</domain_objects>',
    "<notification id='aaaa0000aaaa0000aaaa0000aaaa0000'><type>warning</type><message>P1 does not seem to be connected to a smart meter.</message></notification></domain_objects>",
  );
  const model = parseDomainObjects(parseXml(xml), { now: timeOf(xml) });
  assert.equal(model.meter.connected, false);
});

test('Anna v4: its room, setpoint and bounds, presets, the boiler', () => {
  const model = read('anna_v4');
  assert.equal(model.smile, 'anna');
  assert.equal(model.meter, undefined);
  assert.equal(model.plugs.length, 0);
  assert.equal(model.zones.length, 1);
  const [zone] = model.zones;
  assert.equal(zone.temperature, 20.64, 'the temperature of the Anna itself');
  assert.equal(zone.setpoint, 20.5);
  assert.equal(zone.lower, 4);
  assert.equal(zone.upper, 30);
  assert.equal(zone.preset, 'home');
  assert.deepEqual([...zone.presets].sort(), ['asleep', 'away', 'home', 'no_frost', 'vacation']);
  assert.equal(zone.mode, 'heat');
  assert.equal(zone.schedule, 'off');
  assert.match(zone.functionalityId, /^[0-9a-f]{32}$/);
  assert.equal(model.gateway.outdoorTemperature, 7.44);
  const { heater } = model;
  assert.equal(heater.available, true);
  assert.equal(heater.flame, false);
  assert.equal(heater.heating, true);
  assert.equal(heater.hotWater, false);
  assert.equal(heater.waterTemperature, 45);
  assert.equal(heater.returnTemperature, 32);
  assert.equal(heater.pressure, 2.2);
  assert.equal(heater.modulation, 0);
});

test('a heater value not logged for a week is obsolete', () => {
  const xml = fixture('anna_v4');
  const later = timeOf(xml) + 400 * 24 * 3600_000;
  const model = parseDomainObjects(parseXml(xml), { now: later });
  assert.equal(model.heater.pressure, undefined);
  assert.equal(model.heater.waterTemperature, 45, 'only the obsolete ones');
});

test('Anna P1: the room and the smart meter', () => {
  const model = read('anna_p1');
  assert.equal(model.smile, 'anna');
  assert.equal(model.zones.length, 1);
  assert.equal(model.meter.power, 393);
  assert.deepEqual(model.meter.consumption, { peak: 576.014, offpeak: 618.001 });
  assert.deepEqual(model.meter.injection, { peak: 709.442, offpeak: 246.504 });
  assert.equal(model.meter.gas, 25.37);
});

test('Adam: zones, schedule, modes, plugs with their type and lock', () => {
  const model = read('adam_plus_anna_new');
  assert.equal(model.smile, 'adam');
  assert.equal(model.firmware, '3.9.0');
  const zones = Object.fromEntries(model.zones.map((z) => [z.name, z]));
  assert.deepEqual(Object.keys(zones).sort(), ['Bathroom', 'Living room']);
  assert.equal(zones['Living room'].temperature, 19.73);
  assert.equal(zones['Living room'].setpoint, 20.5);
  assert.equal(zones['Living room'].controlState, 'heating');
  assert.equal(zones['Living room'].schedule, 'Weekschema');
  assert.equal(zones['Living room'].mode, 'auto');
  assert.equal(zones['Living room'].preset, 'home');
  assert.equal(zones.Bathroom.preset, 'vacation');
  assert.equal(zones.Bathroom.schedule, 'off');
  assert.equal(zones.Bathroom.mode, 'heat');
  assert.equal(zones.Bathroom.upper, 99.9);
  assert.deepEqual(model.gateway, {
    outdoorTemperature: 15.06,
    regulationMode: 'heating',
    regulationModes: ['bleeding_cold', 'heating', 'off', 'bleeding_hot'],
    gatewayMode: 'full',
    gatewayModes: ['away', 'full', 'vacation'],
  });
  assert.equal(model.heater.flame, true);
  assert.equal(model.heater.waterTemperature, 43);
  const plugs = Object.fromEntries(model.plugs.map((p) => [p.name, p]));
  assert.deepEqual(plugs['Plug MediaTV'], {
    id: '2568cc4b9c1e401495d4741a5f89bee1',
    name: 'Plug MediaTV',
    type: 'hometheater',
    power: 15.81,
    relay: true,
    lock: true,
  });
  assert.equal(plugs['Plug Thermex Boiler'].type, 'water_heater_vessel');
  assert.equal(plugs['Plug Vloerverwarming'].type, 'central_heating_pump');
  assert.equal(plugs['SmartPlug Floor 0'].type, 'heater_central');
  assert.equal(plugs['Aanvoer water afsluiter (nous lz3)'].type, 'valve_actuator');
  assert.ok(!model.plugs.some((p) => p.id === model.heater.id), 'the boiler is not a plug');
});

test('unsupported Smiles are said, never read', () => {
  assert.deepEqual(read('legacy_anna'), { supported: false, reason: 'legacy' });
  assert.equal(read('anna_connected_to_adam').reason, 'annaOnAdam');
  const old = fixture('adam_plus_anna_new').replace(
    /<firmware_version>3\.9\.0<\/firmware_version>/,
    '<firmware_version>2.3.35</firmware_version>',
  );
  assert.equal(parseDomainObjects(parseXml(old)).reason, 'firmware');
  const other = fixture('p1v4_442_single').replace(
    /<vendor_model>smile<\/vendor_model>/,
    '<vendor_model>stretch</vendor_model>',
  );
  assert.equal(parseDomainObjects(parseXml(other)).reason, 'unknown');
});

test('not a Smile answer: refused', () => {
  assert.throws(() => parseDomainObjects(parseXml('<error>Not started</error>')), /domain_objects/);
  assert.throws(
    () =>
      parseDomainObjects(
        parseXml(
          '<domain_objects><gateway><vendor_model>smile</vendor_model><firmware_version>4.0</firmware_version></gateway></domain_objects>',
        ),
      ),
    /No gateway or home location/,
  );
});

// --- Hostile answers: bounded and linear ----------------------------------------------

/** A Plugwise id from a number and a one-letter prefix. */
const hexId = (prefix, n) => `${prefix}${n.toString(16).padStart(31, '0')}`;
const location = (id, thermostatId) =>
  `<location id='${id}'><name>L</name><type>room</type><actuator_functionalities>` +
  `<thermostat_functionality id='${thermostatId}'><type>thermostat</type><setpoint>20</setpoint>` +
  '</thermostat_functionality></actuator_functionalities></location>';
const appliance = (id, type, locationId, extra = '') =>
  `<appliance id='${id}'><type>${type}</type><location id='${locationId}'/>${extra}</appliance>`;
const scheduleRule = (id, locationIds) =>
  `<rule id='${id}'><name>S${id.slice(-4)}</name><active>true</active>` +
  "<template tag='zone_preset_based_on_time_and_presence_with_override'/><directives/><contexts>" +
  locationIds.map((l) => `<context><zone><location id='${l}'/></zone></context>`).join('') +
  '</contexts></rule>';
const adamWith = (extra) =>
  fixture('adam_plus_anna_new').replace('</domain_objects>', `${extra}</domain_objects>`);
const parseAdam = (xml) => parseDomainObjects(parseXml(xml), { now: timeOf(xml) });

test('a hostile answer of 2.5 MiB is read in linear time', () => {
  const parts = [];
  const locations = [];
  for (let i = 0; i < 4500; i += 1) {
    const id = hexId('a', i);
    locations.push(id);
    parts.push(location(id, hexId('b', i)));
  }
  // Many appliances, none a thermostat but in 400 of the locations: 402 zones.
  for (let i = 0; i < 9000; i += 1) {
    parts.push(appliance(hexId('c', i), 'valve_actuator', locations[i % locations.length]));
  }
  for (let i = 0; i < 400; i += 1) parts.push(appliance(hexId('d', i), 'thermostat', locations[i]));
  for (let i = 0; i < 300; i += 1) {
    parts.push(scheduleRule(hexId('e', i), locations.slice(i, i + 15)));
  }
  const xml = adamWith(parts.join(''));
  assert.ok(xml.length >= 2.5 * 1024 * 1024, `${xml.length} characters`);
  const root = parseXml(xml);
  const started = performance.now();
  const model = parseDomainObjects(root, { now: timeOf(xml) });
  const elapsed = performance.now() - started;
  assert.equal(model.zones.length, 402);
  assert.ok(elapsed < 200, `analysed in ${Math.round(elapsed)} ms`);
});

test('too many zones, plugs, rules or presets: the whole answer is refused', () => {
  const over = MODEL_LIMITS.ZONES + 1;
  const range = (n) => Array.from({ length: n }, (_, i) => i);
  const zones = range(over)
    .map(
      (i) =>
        location(hexId('a', i), hexId('b', i)) +
        appliance(hexId('d', i), 'thermostat', hexId('a', i)),
    )
    .join('');
  assert.throws(() => parseAdam(adamWith(zones)), /Too many zones/);
  const relay =
    "<actuator_functionalities><relay_functionality id='x'/></actuator_functionalities>";
  const plugs = range(MODEL_LIMITS.PLUGS + 1)
    .map((i) =>
      appliance(
        hexId('c', i),
        'lamp',
        hexId('a', 0),
        `<description>smart plug</description>${relay}`,
      ),
    )
    .join('');
  assert.throws(() => parseAdam(adamWith(plugs)), /Too many plugs/);
  const rules = range(MODEL_LIMITS.RULES + 1)
    .map((i) => `<rule id='${hexId('e', i)}'><name>R</name></rule>`)
    .join('');
  assert.throws(() => parseAdam(adamWith(rules)), /Too many rules/);
  const presets =
    "<rule id='ffffffffffffffffffffffffffffffff'><name>Thermostat presets</name>" +
    "<template tag='zone_setpoint_and_state_based_on_preset'/><directives>" +
    range(MODEL_LIMITS.PRESETS + 1)
      .map((i) => `<when preset='p${i}'/>`)
      .join('') +
    '</directives></rule>';
  assert.throws(() => parseAdam(adamWith(presets)), /Too many presets/);
  // The real Adam, nothing added: read.
  assert.equal(parseAdam(adamWith('')).zones.length, 2);
});

test('malformed values are undefined, never 0', () => {
  const xml = fixture('p1v4_442_single')
    .replace('>17643423.00<', '>n/a<')
    .replace(/(tariff="nl_offpeak">)486\.00</, '$1abc<');
  const { meter } = parseDomainObjects(parseXml(xml), { now: timeOf(xml) });
  assert.equal(meter.consumption.offpeak, undefined);
  assert.equal(meter.consumption.peak, 13966.608);
  assert.equal(meter.power, undefined, 'never the peak tariff alone');
});
