// -----------------------------------------------------------------------------
// The Gladys devices of a Smile and their states. Pure.
//
//   meter    `meter:<gateway id>`   Smile P1 (or Anna P1): powers, indexes, gas
//   gateway  `gateway:<gateway id>` Adam / Anna: outdoor temperature, modes
//   heater   `heater:<appliance id>` the boiler or heat pump (read only)
//   zone     `zone:<location id>`  Adam zone or Anna room: temperature,
//                                    setpoint, preset, mode, schedule
//   plug     `plug:<appliance id>`  Adam plug: power, relay
//
// The ids are the Plugwise ones (32 hexadecimal characters), stable for a
// device: a new address of the same Smile keeps every device and history.
//
// Energy rules of the Gladys core (server/utils/constants.js and the
// energy-monitoring service), as in gladys-p1-monitor:
// - `consumption_index` is the ONLY energy-sensor / index feature: the core
//   derives consumption and cost from its deltas. Peak + off-peak, both
//   cumulative; never a daily total, never the injection. It exists only when
//   the meter gave both tariffs at discovery (a "reliable" meter); otherwise
//   the meter has plain sensors only;
// - the tariff indexes and the injection are plain sensors (kWh in the name);
// - gas is NEVER in the energy monitoring (the core would bill it at the
//   electricity tariff): a volume sensor in m³;
// - units: only the ones the core lists for the category.
//
// Commands (all checked again at each command, src/app.js): the setpoint
// (thermostat / target-temperature), the preset and the Adam modes (text /
// select, the options are the Smile's), the relay of a plug (switch / binary)
// only for lighting and entertainment plugs not locked at discovery; any other
// plug shows its relay read only (unknown / binary), so that "turn everything
// off" never reaches a boiler, a pump or a fridge.
//
// A device republished never loses a feature of the one the user created,
// and keeps the shape (category, type, unit, bounds, read_only) of its
// features: a difference would show "Update" in Discovery, and updating would
// drop history (mergeWithCreated).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  GATEWAY_FEATURES as GF,
  HEATER_FEATURES as HF,
  KINDS,
  METER_FEATURES as MF,
  PLUG_FEATURES as PF,
  PLUGWISE_ID,
  POWER_MAX,
  SETPOINT,
  SWITCHABLE_PLUG_TYPES,
  ZONE_FEATURES as ZF,
} from './constants.js';
import { texts } from './i18n.js';

export const idsOf = (gladys, kind, id) => gladys.externalIds(kind, id);

/** Gladys THERMOSTAT_MODE (server/utils/constants.js). */
export const THERMOSTAT_MODE = Object.freeze({ off: 0, heat: 1, cool: 2, auto: 3 });
/** Gladys THERMOSTAT_OPERATING_STATE. */
export const OPERATING_STATE = Object.freeze({ IDLE: 0, HEATING: 1, COOLING: 2 });

const base = (extra) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  min: 0,
  max: 1_000_000_000,
  ...extra,
});
const plain = (extra) => base({ category: C.UNKNOWN, type: T.SENSOR.DECIMAL, ...extra });
const binary = () => base({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const temperature = (type = T.SENSOR.DECIMAL) =>
  base({ category: C.TEMPERATURE_SENSOR, type, unit: U.CELSIUS, min: -50, max: 150 });
const words = () =>
  base({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });
const select = (values, labels) =>
  base({
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    read_only: false,
    has_feedback: true,
    keep_history: false,
    supported_options: values.map((value, i) => ({
      value,
      label: labels[value] ?? value,
      sort_order: i,
    })),
  });

/** Whether a plug's relay may be commanded at all (type and lock). */
export const isSwitchablePlug = (plug) =>
  plug.lock === false && SWITCHABLE_PLUG_TYPES.includes(plug.type);

/** The setpoint bounds a command accepts for a zone: 4-30 °C narrowed to the Smile's. */
export function setpointBounds(zone) {
  const min = Math.max(SETPOINT.MIN, Number.isFinite(zone.lower) ? zone.lower : SETPOINT.MIN);
  const max = Math.min(SETPOINT.MAX, Number.isFinite(zone.upper) ? zone.upper : SETPOINT.MAX);
  return min <= max ? { min, max } : { min: SETPOINT.MIN, max: SETPOINT.MAX };
}

function device(gladys, kind, id, name, model, list, t) {
  const ids = idsOf(gladys, kind, id);
  return {
    name,
    external_id: ids.device,
    model,
    should_poll: false,
    features: list.map(([key, feature, nameKey]) => ({
      name: typeof nameKey === 'string' ? nameKey : t.features[key],
      external_id: ids.feature(key),
      ...feature,
    })),
  };
}

export function meterDevice(gladys, model, t) {
  const { meter } = model;
  const reliable = meter.consumption.peak !== undefined && meter.consumption.offpeak !== undefined;
  const list = [
    [
      MF.POWER,
      base({
        category: C.ENERGY_SENSOR,
        type: T.ENERGY_SENSOR.POWER,
        unit: U.WATT,
        max: POWER_MAX,
      }),
    ],
  ];
  if (reliable) {
    list.push([
      MF.CONSUMPTION_INDEX,
      base({ category: C.ENERGY_SENSOR, type: T.ENERGY_SENSOR.INDEX, unit: U.KILOWATT_HOUR }),
    ]);
  }
  if (meter.consumption.peak !== undefined) list.push([MF.CONSUMPTION_PEAK, plain()]);
  if (meter.consumption.offpeak !== undefined) list.push([MF.CONSUMPTION_OFFPEAK, plain()]);
  if (meter.injectionPower !== undefined) {
    list.push([MF.INJECTION_POWER, plain({ max: POWER_MAX })]);
  }
  if (meter.injection.peak !== undefined) list.push([MF.INJECTION_PEAK, plain()]);
  if (meter.injection.offpeak !== undefined) list.push([MF.INJECTION_OFFPEAK, plain()]);
  if (meter.gas !== undefined) {
    list.push([
      MF.GAS,
      base({ category: C.VOLUME_SENSOR, type: T.VOLUME_SENSOR.DECIMAL, unit: U.CUBIC_METER }),
    ]);
  }
  meter.phases.forEach((phase, i) => {
    const n = i + 1;
    // A value every 10 s: no history unless the user turns it on.
    if (phase.consumed !== undefined) {
      list.push([
        MF.phasePower(n),
        plain({ max: POWER_MAX, keep_history: false }),
        t.features.phasePower(n),
      ]);
    }
    if (phase.produced !== undefined) {
      list.push([
        MF.phaseInjection(n),
        plain({ max: POWER_MAX, keep_history: false }),
        t.features.phaseInjection(n),
      ]);
    }
    if (phase.voltage !== undefined) {
      list.push([
        MF.phaseVoltage(n),
        base({
          category: C.ENERGY_SENSOR,
          type: T.ENERGY_SENSOR.VOLTAGE,
          unit: U.VOLT,
          max: 500,
          keep_history: false,
        }),
        t.features.phaseVoltage(n),
      ]);
    }
  });
  return device(gladys, KINDS.METER, model.gatewayId, t.meter, 'Plugwise Smile P1', list, t);
}

export function gatewayDevice(gladys, model, t) {
  const { gateway } = model;
  const list = [];
  if (gateway.outdoorTemperature !== undefined) list.push([GF.OUTDOOR_TEMPERATURE, temperature()]);
  if (gateway.regulationModes?.length) {
    list.push([GF.REGULATION_MODE, select(gateway.regulationModes, t.options)]);
  }
  if (gateway.gatewayModes?.length) {
    list.push([GF.GATEWAY_MODE, select(gateway.gatewayModes, t.options)]);
  }
  return device(
    gladys,
    KINDS.GATEWAY,
    model.gatewayId,
    t.gateway(model.smile),
    `Plugwise ${model.smile === 'adam' ? 'Adam' : 'Anna'}`,
    list,
    t,
  );
}

export function heaterDevice(gladys, heater, t) {
  const list = [];
  const probe = () => temperature(T.TEMPERATURE_SENSOR.PROBE);
  if (heater.flame !== undefined) list.push([HF.FLAME, binary()]);
  if (heater.heating !== undefined) list.push([HF.HEATING, binary()]);
  if (heater.hotWater !== undefined) list.push([HF.HOT_WATER, binary()]);
  if (heater.waterTemperature !== undefined) list.push([HF.WATER_TEMPERATURE, probe()]);
  if (heater.returnTemperature !== undefined) list.push([HF.RETURN_TEMPERATURE, probe()]);
  if (heater.hotWaterTemperature !== undefined) list.push([HF.HOT_WATER_TEMPERATURE, probe()]);
  if (heater.pressure !== undefined) {
    list.push([
      HF.PRESSURE,
      base({ category: C.PRESSURE_SENSOR, type: T.SENSOR.DECIMAL, unit: U.BAR, max: 10 }),
    ]);
  }
  if (heater.modulation !== undefined) list.push([HF.MODULATION, plain({ max: 100 })]);
  if (heater.outdoorTemperature !== undefined) list.push([HF.OUTDOOR_TEMPERATURE, temperature()]);
  return device(gladys, KINDS.HEATER, heater.id, t.heater, 'Plugwise heater_central', list, t);
}

export function zoneDevice(gladys, zone, smile, t) {
  const { min, max } = setpointBounds(zone);
  const list = [
    [ZF.TEMPERATURE, temperature()],
    // A command, refused unless the user allowed it (`allow_climate`, off by
    // default): read_only is fixed when the device is created, so the
    // permission is checked at each command instead.
    [
      ZF.TARGET,
      base({
        category: C.THERMOSTAT,
        type: T.THERMOSTAT.TARGET_TEMPERATURE,
        unit: U.CELSIUS,
        min,
        max,
        read_only: false,
        has_feedback: true,
      }),
    ],
    [ZF.OPERATING, base({ category: C.THERMOSTAT, type: T.THERMOSTAT.OPERATING_STATE, max: 2 })],
    [ZF.MODE, base({ category: C.THERMOSTAT, type: T.THERMOSTAT.MODE, max: 3 })],
  ];
  if (zone.presets.length) list.push([ZF.PRESET, select(zone.presets, t.options)]);
  list.push([ZF.SCHEDULE, words()]);
  const name = smile === 'anna' ? `Anna - ${zone.name}` : zone.name;
  return device(
    gladys,
    KINDS.ZONE,
    zone.id,
    t.zone(name || 'Zone'),
    smile === 'anna' ? 'Plugwise Anna' : 'Plugwise Adam zone',
    list,
    t,
  );
}

export function plugDevice(gladys, plug, t) {
  const state = isSwitchablePlug(plug)
    ? base({
        category: C.SWITCH,
        type: T.SWITCH.BINARY,
        max: 1,
        read_only: false,
        has_feedback: true,
      })
    : binary();
  const list = [[PF.STATE, state]];
  if (plug.power !== undefined) {
    list.push([
      PF.POWER,
      base({ category: C.SWITCH, type: T.SWITCH.POWER, unit: U.WATT, max: 10_000 }),
      t.features.plug_power,
    ]);
  }
  return device(
    gladys,
    KINDS.PLUG,
    plug.id,
    t.plug(plug.name || 'Plug'),
    `Plugwise plug (${plug.type ?? 'unknown'})`,
    list,
    t,
  );
}

const SHAPE = ['category', 'type', 'unit', 'min', 'max', 'read_only'];

/**
 * The device as published, never with fewer features than the created one,
 * nor a different shape for a feature it already has.
 */
export function mergeWithCreated(built, created) {
  if (!created?.features?.length) return built;
  const existing = new Map(created.features.map((f) => [f.external_id, f]));
  const features = built.features.map((feature) => {
    const kept = existing.get(feature.external_id);
    if (!kept) return feature;
    const shaped = { ...feature };
    for (const key of SHAPE) {
      if (kept[key] === undefined || kept[key] === null) delete shaped[key];
      else shaped[key] = kept[key];
    }
    return shaped;
  });
  const ids = new Set(features.map((f) => f.external_id));
  for (const kept of created.features) {
    if (ids.has(kept.external_id)) continue;
    const copy = {
      name: kept.name,
      external_id: kept.external_id,
      has_feedback: kept.has_feedback ?? false,
      keep_history: kept.keep_history ?? true,
    };
    for (const key of SHAPE)
      if (kept[key] !== undefined && kept[key] !== null) copy[key] = kept[key];
    if (Array.isArray(kept.supported_options)) copy.supported_options = kept.supported_options;
    features.push(copy);
  }
  return { ...built, features };
}

/** Every device a Smile shows, merged with the created ones. */
export function buildDevices(gladys, model, language, createdList = gladys.devices ?? []) {
  const t = texts(language);
  const created = new Map(createdList.map((d) => [d.external_id, d]));
  const built = [];
  if (model.meter) built.push(meterDevice(gladys, model, t));
  if (model.gateway) built.push(gatewayDevice(gladys, model, t));
  if (model.heater) built.push(heaterDevice(gladys, model.heater, t));
  for (const zone of model.zones) built.push(zoneDevice(gladys, zone, model.smile, t));
  for (const plug of model.plugs) built.push(plugDevice(gladys, plug, t));
  return built
    .filter((d) => d.features.length > 0)
    .map((d) => mergeWithCreated(d, created.get(d.external_id)));
}

/**
 * What a device or feature external id of this integration designates:
 * { kind, id, feature } (feature null for a device), or null.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string') return null;
  for (const kind of Object.values(KINDS)) {
    const prefix = gladys.externalId(`${kind}:`);
    if (!externalId.startsWith(prefix)) continue;
    const [id, feature, ...rest] = externalId.slice(prefix.length).split(':');
    if (rest.length > 0 || !PLUGWISE_ID.test(id ?? '')) return null;
    return { kind, id, feature: feature ?? null };
  }
  return null;
}

// --- States --------------------------------------------------------------------------

export const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const bit = (value) => (value === undefined ? undefined : value ? 1 : 0);

/** A list of states built with `add(id, value)`: numbers rounded, strings as text, undefined skipped. */
function collector() {
  const states = [];
  const add = (id, value, digits = 2) => {
    if (typeof value === 'string') {
      states.push({ device_feature_external_id: id, text: value });
    } else if (isNumber(value)) {
      states.push({ device_feature_external_id: id, state: round(value, digits) });
    }
  };
  return { states, add };
}

/** The live values of the meter (each read): powers and phases. */
export function meterLiveStates(gladys, model, { stale }) {
  const { states, add } = collector();
  const ids = idsOf(gladys, KINDS.METER, model.gatewayId);
  const { meter } = model;
  if (stale) return states;
  const power = (value) =>
    isNumber(value) && value >= 0 && value <= POWER_MAX ? value : undefined;
  add(ids.feature(MF.POWER), power(meter.power), 0);
  add(ids.feature(MF.INJECTION_POWER), power(meter.injectionPower), 0);
  meter.phases.forEach((phase, i) => {
    add(ids.feature(MF.phasePower(i + 1)), power(phase.consumed), 0);
    add(ids.feature(MF.phaseInjection(i + 1)), power(phase.produced), 0);
    add(ids.feature(MF.phaseVoltage(i + 1)), phase.voltage, 1);
  });
  return states;
}

/**
 * The indexes of the meter, once a minute. `consumptionIndex`: the value the
 * IndexGuard let through (undefined: not published this time). Every other
 * index is a plain or volume sensor, never published at 0.
 */
export function meterIndexStates(gladys, model, consumptionIndex) {
  const { states, add } = collector();
  const ids = idsOf(gladys, KINDS.METER, model.gatewayId);
  const { meter } = model;
  const counter = (value) => (isNumber(value) && value > 0 ? value : undefined);
  add(ids.feature(MF.CONSUMPTION_INDEX), counter(consumptionIndex), 3);
  add(ids.feature(MF.CONSUMPTION_PEAK), counter(meter.consumption.peak), 3);
  add(ids.feature(MF.CONSUMPTION_OFFPEAK), counter(meter.consumption.offpeak), 3);
  add(ids.feature(MF.INJECTION_PEAK), counter(meter.injection.peak), 3);
  add(ids.feature(MF.INJECTION_OFFPEAK), counter(meter.injection.offpeak), 3);
  add(ids.feature(MF.GAS), counter(meter.gas), 3);
  return states;
}

/** The states of the thermostat devices (gateway, heater, zones) and the plugs. */
export function climateStates(gladys, model) {
  const { states, add } = collector();
  if (model.gateway) {
    const ids = idsOf(gladys, KINDS.GATEWAY, model.gatewayId);
    add(ids.feature(GF.OUTDOOR_TEMPERATURE), model.gateway.outdoorTemperature, 1);
    add(ids.feature(GF.REGULATION_MODE), model.gateway.regulationMode);
    add(ids.feature(GF.GATEWAY_MODE), model.gateway.gatewayMode);
  }
  const heater = model.heater;
  if (heater?.available) {
    const ids = idsOf(gladys, KINDS.HEATER, heater.id);
    add(ids.feature(HF.FLAME), bit(heater.flame));
    add(ids.feature(HF.HEATING), bit(heater.heating));
    add(ids.feature(HF.HOT_WATER), bit(heater.hotWater));
    add(ids.feature(HF.WATER_TEMPERATURE), heater.waterTemperature, 1);
    add(ids.feature(HF.RETURN_TEMPERATURE), heater.returnTemperature, 1);
    add(ids.feature(HF.HOT_WATER_TEMPERATURE), heater.hotWaterTemperature, 1);
    add(ids.feature(HF.PRESSURE), heater.pressure, 2);
    add(ids.feature(HF.MODULATION), heater.modulation, 0);
    add(ids.feature(HF.OUTDOOR_TEMPERATURE), heater.outdoorTemperature, 1);
  }
  for (const zone of model.zones) {
    const ids = idsOf(gladys, KINDS.ZONE, zone.id);
    add(ids.feature(ZF.TEMPERATURE), zone.temperature, 2);
    add(ids.feature(ZF.TARGET), zone.setpoint, 2);
    add(ids.feature(ZF.OPERATING), operatingOf(model, zone));
    add(ids.feature(ZF.MODE), THERMOSTAT_MODE[zone.mode]);
    if (zone.preset && zone.presets.includes(zone.preset)) add(ids.feature(ZF.PRESET), zone.preset);
    add(ids.feature(ZF.SCHEDULE), zone.schedule);
  }
  for (const plug of model.plugs) {
    const ids = idsOf(gladys, KINDS.PLUG, plug.id);
    add(ids.feature(PF.STATE), bit(plug.relay));
    add(ids.feature(PF.POWER), plug.power, 1);
  }
  return states;
}

/** Heating / cooling / idle of a zone: the Adam's control state, the Anna's boiler. */
export function operatingOf(model, zone) {
  if (model.smile === 'adam') {
    if (zone.controlState === 'heating' || zone.controlState === 'preheating') {
      return OPERATING_STATE.HEATING;
    }
    if (zone.controlState === 'cooling') return OPERATING_STATE.COOLING;
    return zone.controlState === undefined ? undefined : OPERATING_STATE.IDLE;
  }
  const heater = model.heater;
  if (!heater?.available) return undefined;
  if (heater.cooling) return OPERATING_STATE.COOLING;
  if (heater.heating) return OPERATING_STATE.HEATING;
  return heater.heating === undefined ? undefined : OPERATING_STATE.IDLE;
}
