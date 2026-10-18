// -----------------------------------------------------------------------------
// What a Smile shows, read from its /core/domain_objects answer. Pure. Ported
// from python-plugwise (MIT, see THIRD_PARTY_NOTICES.md): helper.py,
// common.py, data.py and util.py, for the current firmwares only (the
// answer has a <gateway> element: Smile P1 v4, Anna v4, Adam v3).
//
//   parseDomainObjects(root, { now }) -> {
//     supported: false, reason } | {
//     supported: true, smile: 'p1' | 'anna' | 'adam', firmware, gatewayId,
//     homeId, gatewayTime, notifications,
//     meter?    (P1 or Anna P1): powers, indexes per tariff, gas, phases
//     gateway?  (Adam, Anna): outdoor temperature, regulation and gateway modes
//     heater?   (Adam, Anna): flame, heating, hot water, temperatures, pressure
//     zones     (Adam: the zones with a thermostat; Anna: its room)
//     plugs     (Adam): power, relay, lock, type
//   }
//
// Every value is optional: a missing or malformed one is undefined, never 0.
// -----------------------------------------------------------------------------

import { SMILE_MODELS, PLUGWISE_ID, OBSOLETE_AFTER_MS } from '../constants.js';
import { CODES, SmileError } from './errors.js';
import { attr, child, children, path, paths, textAt } from './xml.js';

/** A number as the Smile writes it ("20.50", "-3", "0.00"); anything else is undefined. */
export const number = (text) =>
  typeof text === 'string' && /^-?\d{1,12}(\.\d{1,12})?$/.test(text) ? Number(text) : undefined;

/** "on" / "true" and "off" / "false"; anything else is undefined. */
export const onOff = (text) =>
  text === 'on' || text === 'true' ? true : text === 'off' || text === 'false' ? false : undefined;

/** Thermostat appliance types and their rank in a zone (python-plugwise THERMO_MATCHING). */
const THERMO_MATCHING = new Map([
  ['thermostat', 2],
  ['zone_thermometer', 2],
  ['zone_thermostat', 2],
  ['thermostatic_radiator_valve', 1],
]);

const PRESET_TAG = 'zone_setpoint_and_state_based_on_preset';
const PRESET_RULE_NAME = 'Thermostat presets';
const SCHEDULE_TAG = 'zone_preset_based_on_time_and_presence_with_override';
const P1_NOT_CONNECTED = 'P1 does not seem to be connected';
const NO_OPENTHERM = 'no OpenTherm communication';

/** The logs of `kind` (point_log, cumulative_log, interval_log) of `type` in a container. */
const logsOf = (container, kind, type) =>
  children(child(container, 'logs'), kind).filter((log) => textAt(log, 'type') === type);

/** The measurements of the first log of `kind` and `type`. */
const measurementsOf = (container, kind, type) => {
  const log = logsOf(container, kind, type)[0];
  return log ? paths(log, 'period/measurement') : [];
};

/** The first measurement of a log: { text, date, updated }. */
function reading(container, type, kind = 'point_log') {
  const log = logsOf(container, kind, type)[0];
  const measurement = log ? path(log, 'period/measurement') : undefined;
  if (!measurement) return undefined;
  return {
    text: measurement.text,
    date: attr(measurement, 'log_date'),
    updated: textAt(log, 'updated_date'),
  };
}

const valueOf = (container, type, kind) => number(reading(container, type, kind)?.text);

/** A measurement per tariff: { peak, offpeak, single }. */
function byTariff(container, kind, type) {
  const result = {};
  for (const measurement of measurementsOf(container, kind, type)) {
    const value = number(measurement.text);
    const tariff = attr(measurement, 'tariff');
    if (value === undefined) result.invalid = true;
    if (tariff === 'nl_peak') result.peak = value;
    else if (tariff === 'nl_offpeak') result.offpeak = value;
    else if (tariff === undefined) result.single = value;
  }
  return result;
}

/** A power of the meter: the sum of the tariffs present (one is 0 at any time), W. */
function powerOf(tariffs) {
  // A tariff unreadable: never a partial sum.
  if (tariffs.invalid) return undefined;
  if (tariffs.single !== undefined) return tariffs.single;
  if (tariffs.peak === undefined && tariffs.offpeak === undefined) return undefined;
  return (tariffs.peak ?? 0) + (tariffs.offpeak ?? 0);
}

const kWh = (wh) => (wh === undefined ? undefined : Math.round(wh) / 1000);

/** The smart meter, from the logs of the home location (python-plugwise _power_data_from_location). */
export function parseMeter(home, notifications) {
  const consumed = byTariff(home, 'cumulative_log', 'electricity_consumed');
  const produced = byTariff(home, 'cumulative_log', 'electricity_produced');
  const phases = ['one', 'two', 'three'].map((n) => ({
    consumed: valueOf(home, `electricity_phase_${n}_consumed`),
    produced: valueOf(home, `electricity_phase_${n}_produced`),
    voltage: valueOf(home, `voltage_phase_${n}`),
  }));
  const powerReading = measurementsOf(home, 'point_log', 'electricity_consumed')[0];
  return {
    connected: !notifications.some((n) => n.message.includes(P1_NOT_CONNECTED)),
    power: powerOf(byTariff(home, 'point_log', 'electricity_consumed')),
    injectionPower: powerOf(byTariff(home, 'point_log', 'electricity_produced')),
    /** When the power was last logged by the Smile (its freshness). */
    powerDate: attr(powerReading, 'log_date'),
    consumption: { peak: kWh(consumed.peak), offpeak: kWh(consumed.offpeak) },
    injection: { peak: kWh(produced.peak), offpeak: kWh(produced.offpeak) },
    gas: valueOf(home, 'gas_consumed', 'cumulative_log'),
    phases: phases.filter(
      (p) => p.consumed !== undefined || p.produced !== undefined || p.voltage !== undefined,
    ),
  };
}

/** The boiler: the heater_central named "Central heating boiler" (python-plugwise check_heater_central). */
function findHeater(appliances) {
  const candidates = appliances.filter(
    (a) => textAt(a, 'type') === 'heater_central' && textAt(a, 'name') === 'Central heating boiler',
  );
  if (candidates.length > 1) {
    return (
      candidates.find((a) => (child(a, 'actuator_functionalities')?.children.length ?? 0) > 0) ??
      candidates[0]
    );
  }
  return candidates[0];
}

/** A heater value not logged for a week is obsolete (python-plugwise skip_obsolete_measurements). */
function fresh(container, type, now) {
  const found = reading(container, type);
  if (!found) return undefined;
  const updated = Date.parse(found.updated ?? '');
  if (Number.isFinite(updated) && now - updated > OBSOLETE_AFTER_MS) return undefined;
  return number(found.text);
}

function parseHeater(element, { onOffBoiler, notifications, now }) {
  const point = (type) => reading(element, type)?.text;
  let modulation = number(point('modulation_level'));
  // Older firmware: a fraction (python-plugwise format_measure, PERCENTAGE).
  if (modulation !== undefined && modulation > 0 && modulation <= 1) modulation *= 100;
  return {
    id: attr(element, 'id'),
    available: onOffBoiler || !notifications.some((n) => n.message.includes(NO_OPENTHERM)),
    flame: onOff(point('flame_state')),
    heating:
      onOff(point('intended_central_heating_state')) ?? onOff(point('central_heating_state')),
    cooling: onOff(point('cooling_state')),
    hotWater: onOff(point('domestic_hot_water_state')),
    waterTemperature: number(point('boiler_temperature')),
    returnTemperature: number(point('return_water_temperature')),
    hotWaterTemperature: number(point('domestic_hot_water_temperature')),
    pressure: fresh(element, 'central_heater_water_pressure', now),
    modulation: modulation === undefined ? undefined : Math.round(modulation),
    outdoorTemperature: fresh(element, 'outdoor_temperature', now),
  };
}

/** The mode of an actuator of the gateway appliance, and its allowed modes. */
function actuatorMode(appliance, functionality) {
  const found = path(appliance, `actuator_functionalities/${functionality}`);
  if (!found) return undefined;
  return {
    mode: textAt(found, 'mode'),
    allowed: children(child(found, 'allowed_modes'), 'mode')
      .map((m) => m.text)
      .filter(Boolean),
  };
}

function parseGateway(appliance, home, smile) {
  const result = { outdoorTemperature: valueOf(home, 'outdoor_temperature') };
  if (smile === 'adam' && appliance) {
    const regulation = actuatorMode(appliance, 'regulation_mode_control_functionality');
    if (regulation?.allowed.length) {
      result.regulationMode = regulation.mode;
      result.regulationModes = regulation.allowed;
    }
    // python-plugwise: the allowed modes present means away / full / vacation.
    const gatewayMode = children(
      child(appliance, 'actuator_functionalities'),
      'gateway_mode_control_functionality',
    ).find((f) => textAt(f, 'type') === 'gateway_mode' && child(f, 'allowed_modes'));
    if (gatewayMode) {
      result.gatewayMode = textAt(gatewayMode, 'mode');
      result.gatewayModes = ['away', 'full', 'vacation'];
    }
  }
  return result;
}

/** The preset names (python-plugwise _presets): global to the Smile. */
function parsePresets(rules) {
  let found = rules.filter((r) => attr(child(r, 'template'), 'tag') === PRESET_TAG);
  if (found.length === 0) found = rules.filter((r) => textAt(r, 'name') === PRESET_RULE_NAME);
  const names = [];
  for (const rule of found) {
    for (const when of children(child(rule, 'directives'), 'when')) {
      const preset = attr(when, 'preset');
      if (preset && !names.includes(preset)) names.push(preset);
    }
  }
  return names;
}

/** The schedules of a location and the one active there (python-plugwise _schedules). */
function parseSchedule(rules, locationId) {
  let selected;
  const available = [];
  for (const rule of rules) {
    if (attr(child(rule, 'template'), 'tag') !== SCHEDULE_TAG || !child(rule, 'directives')) {
      continue;
    }
    const name = textAt(rule, 'name');
    if (!name) continue;
    available.push(name);
    const here = paths(rule, 'contexts/context/zone/location').some(
      (l) => attr(l, 'id') === locationId,
    );
    if (here && textAt(rule, 'active') === 'true') selected = name;
  }
  return { available, selected };
}

/** The thermostat functionality of a location (the setpoint and its bounds). */
const thermostatOf = (location) =>
  children(child(location, 'actuator_functionalities'), 'thermostat_functionality').find(
    (f) => textAt(f, 'type') === 'thermostat',
  );

function parseZone(location, { rules, presets, temperatureFrom, regulationMode }) {
  const functionality = thermostatOf(location);
  const id = attr(location, 'id');
  const schedule = parseSchedule(rules, id);
  let mode = schedule.selected ? 'auto' : 'heat';
  if (!schedule.selected && regulationMode === 'cooling') mode = 'cool';
  if (regulationMode === 'off') mode = 'off';
  return {
    id,
    name: textAt(location, 'name') ?? '',
    type: textAt(location, 'type'),
    functionalityId: attr(functionality, 'id'),
    temperature: valueOf(temperatureFrom, 'temperature') ?? valueOf(location, 'temperature'),
    setpoint: number(textAt(functionality, 'setpoint')),
    lower: number(textAt(functionality, 'lower_bound')),
    upper: number(textAt(functionality, 'upper_bound')),
    controlState: textAt(functionality, 'control_state'),
    preset: textAt(location, 'preset'),
    presets,
    schedule: schedule.selected ?? 'off',
    mode,
  };
}

const isPlugDescription = (text) =>
  typeof text === 'string' && (text.includes('ZigBee protocol') || text.includes('smart plug'));

function parsePlug(appliance) {
  const relay = path(appliance, 'actuator_functionalities/relay_functionality');
  return {
    id: attr(appliance, 'id'),
    name: textAt(appliance, 'name') ?? '',
    type: textAt(appliance, 'type'),
    power: valueOf(appliance, 'electricity_consumed'),
    relay: onOff(textAt(relay, 'state')) ?? onOff(reading(appliance, 'relay')?.text),
    lock: onOff(textAt(relay, 'lock')),
  };
}

/**
 * Read a /core/domain_objects document.
 * @param {object} root the parsed XML root (src/smile/xml.js)
 * @param {{ now?: number }} [options] `now` dates the obsolete measurements
 */
export function parseDomainObjects(root, { now = Date.now() } = {}) {
  if (root?.name !== 'domain_objects') {
    throw new SmileError(CODES.BAD_ANSWER, 'Not a domain_objects answer');
  }
  const gatewayElement = child(root, 'gateway');
  if (!gatewayElement) return { supported: false, reason: 'legacy' };
  const vendorModel = textAt(gatewayElement, 'vendor_model');
  const firmware = textAt(gatewayElement, 'firmware_version') ?? '';
  const major = Number.parseInt(firmware, 10);
  const smile = SMILE_MODELS[vendorModel];
  if (!smile || !Number.isFinite(major)) return { supported: false, reason: 'unknown' };
  // python-plugwise: smile_open_therm_v2 and smile_thermo_v3 need a firmware
  // update; a P1 before v2 is not a known Smile (its "fail_firmware" test data).
  if ((smile === 'adam' && major < 3) || (smile === 'anna' && major < 4) || major < 2) {
    return { supported: false, reason: 'firmware', smile, firmware };
  }
  const moduleModels = paths(root, 'module/vendor_model').map((m) => m.text);
  if (smile === 'anna' && moduleModels.includes('159.2')) {
    return { supported: false, reason: 'annaOnAdam', smile, firmware };
  }

  const locations = children(root, 'location');
  const home = locations.find((l) => textAt(l, 'type') === 'building');
  const appliances = children(root, 'appliance');
  const gatewayAppliance = appliances.find((a) => textAt(a, 'type') === 'gateway');
  const gatewayId = attr(gatewayAppliance, 'id');
  if (!home || !PLUGWISE_ID.test(gatewayId ?? '') || !PLUGWISE_ID.test(attr(home, 'id') ?? '')) {
    throw new SmileError(CODES.BAD_ANSWER, 'No gateway or home location');
  }
  const notifications = children(root, 'notification').map((n) => ({
    type: textAt(n, 'type') ?? '',
    message: textAt(n, 'message') ?? '',
  }));
  const result = {
    supported: true,
    smile,
    firmware,
    gatewayId,
    homeId: attr(home, 'id'),
    gatewayTime: textAt(gatewayElement, 'time'),
    notifications,
    zones: [],
    plugs: [],
  };

  const annaP1 =
    smile === 'anna' &&
    paths(root, 'location/logs/point_log/electricity_point_meter').some((m) => attr(m, 'id'));
  if (smile === 'p1' || annaP1) result.meter = parseMeter(home, notifications);
  if (smile === 'p1') return result;

  result.gateway = parseGateway(gatewayAppliance, home, smile);
  const heaterElement = findHeater(appliances);
  if (heaterElement && PLUGWISE_ID.test(attr(heaterElement, 'id') ?? '')) {
    const onOffBoiler = paths(root, 'module/protocols/onoff_boiler').length > 0;
    result.heater = parseHeater(heaterElement, { onOffBoiler, notifications, now });
  }

  const rules = children(root, 'rule');
  const presets = parsePresets(rules);
  const regulationMode = result.gateway.regulationMode;
  const locationOf = (a) => attr(child(a, 'location'), 'id');
  const byId = new Map(locations.map((l) => [attr(l, 'id'), l]));

  if (smile === 'anna') {
    // The Anna: the room of the thermostat (one with actuators: python-plugwise skips the orphans).
    const anna = appliances.find(
      (a) =>
        textAt(a, 'type') === 'thermostat' &&
        (child(a, 'actuator_functionalities')?.children.length ?? 0) > 0 &&
        byId.has(locationOf(a)),
    );
    const room = anna ? byId.get(locationOf(anna)) : undefined;
    if (room && thermostatOf(room) && PLUGWISE_ID.test(attr(room, 'id') ?? '')) {
      result.zones.push(
        parseZone(room, { rules, presets, temperatureFrom: anna, regulationMode: undefined }),
      );
    }
  } else {
    // Adam: every location with a thermostat functionality and a thermostat in it.
    for (const location of locations) {
      const id = attr(location, 'id');
      if (!PLUGWISE_ID.test(id ?? '') || textAt(location, 'type') === 'building') continue;
      if (!thermostatOf(location)) continue;
      const hasThermostat = appliances.some(
        (a) => THERMO_MATCHING.has(textAt(a, 'type')) && locationOf(a) === id,
      );
      if (!hasThermostat) continue;
      result.zones.push(
        parseZone(location, { rules, presets, temperatureFrom: undefined, regulationMode }),
      );
    }
    for (const appliance of appliances) {
      const id = attr(appliance, 'id');
      if (!PLUGWISE_ID.test(id ?? '') || id === attr(heaterElement, 'id')) continue;
      if (!path(appliance, 'actuator_functionalities/relay_functionality')) continue;
      if (!isPlugDescription(textAt(appliance, 'description'))) continue;
      result.plugs.push(parsePlug(appliance));
    }
  }
  return result;
}
