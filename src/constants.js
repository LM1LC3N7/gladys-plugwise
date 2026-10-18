// -----------------------------------------------------------------------------
// Keys, limits and timings. The manifest keys, the external id shapes and the
// feature keys are stored in user devices and scenes: never rename them
// (test/manifest.test.js ties them to the manifest).
// -----------------------------------------------------------------------------

export const ACTIONS = Object.freeze({
  TEST: 'test_connection',
  ACCEPT_HELD: 'accept_held_index',
});

/** The external id types: `ext:<selector>:<type>:<Plugwise id>`. */
export const KINDS = Object.freeze({
  /** The smart meter of a Smile P1 (or of an Anna P1): `meter:<gateway appliance id>`. */
  METER: 'meter',
  /** The Smile itself (Adam, Anna): outdoor temperature, modes. */
  GATEWAY: 'gateway',
  /** The boiler or heat pump (heater_central). */
  HEATER: 'heater',
  /** A heating zone (Adam) or the room of the Anna: `zone:<location id>`. */
  ZONE: 'zone',
  /** A Plugwise plug (Adam). */
  PLUG: 'plug',
});

/** Plugwise ids: 32 hexadecimal characters. */
export const PLUGWISE_ID = /^[0-9a-f]{32}$/;

export const METER_FEATURES = Object.freeze({
  POWER: 'power',
  INJECTION_POWER: 'injection_power',
  CONSUMPTION_INDEX: 'consumption_index',
  CONSUMPTION_PEAK: 'consumption_peak',
  CONSUMPTION_OFFPEAK: 'consumption_offpeak',
  INJECTION_PEAK: 'injection_peak',
  INJECTION_OFFPEAK: 'injection_offpeak',
  GAS: 'gas',
  phasePower: (n) => `power_l${n}`,
  phaseInjection: (n) => `injection_power_l${n}`,
  phaseVoltage: (n) => `voltage_l${n}`,
});

export const GATEWAY_FEATURES = Object.freeze({
  OUTDOOR_TEMPERATURE: 'outdoor_temperature',
  REGULATION_MODE: 'regulation_mode',
  GATEWAY_MODE: 'gateway_mode',
});

export const HEATER_FEATURES = Object.freeze({
  FLAME: 'flame',
  HEATING: 'heating',
  HOT_WATER: 'hot_water',
  WATER_TEMPERATURE: 'water_temperature',
  RETURN_TEMPERATURE: 'return_temperature',
  HOT_WATER_TEMPERATURE: 'hot_water_temperature',
  PRESSURE: 'pressure',
  MODULATION: 'modulation',
  OUTDOOR_TEMPERATURE: 'outdoor_temperature',
});

export const ZONE_FEATURES = Object.freeze({
  TEMPERATURE: 'temperature',
  TARGET: 'target',
  OPERATING: 'operating',
  MODE: 'mode',
  PRESET: 'preset',
  SCHEDULE: 'schedule',
});

export const PLUG_FEATURES = Object.freeze({
  STATE: 'state',
  POWER: 'power',
});

/**
 * The room setpoint a command may set: 4 to 30 °C (python-plugwise
 * MIN_SETPOINT / MAX_SETPOINT), narrowed to the bounds the Smile gives for
 * the zone. A value outside is refused, never clamped.
 */
export const SETPOINT = Object.freeze({ MIN: 4, MAX: 30, STEP: 0.1 });

/** Adam regulation modes a command may set: never "off" nor a bleeding cycle. */
export const COMMANDABLE_REGULATION_MODES = Object.freeze(['heating', 'cooling']);
/** Adam gateway modes (python-plugwise limits them to these three). */
export const GATEWAY_MODES = Object.freeze(['away', 'full', 'vacation']);
/** The end of an away / vacation period, as python-plugwise sends it. */
export const GATEWAY_MODE_END = '2037-04-21T08:00:53.000Z';

/**
 * Plug types (the appliance type set in the Plugwise app) whose relay a
 * command may switch: lighting and entertainment only. Everything else is
 * refused, whatever the lock: a boiler, a heating pump, a valve, a water
 * heater, a fridge or a freezer, a router (the network of the Smile itself),
 * an appliance in the middle of a cycle, a kettle, and every type this list
 * does not know (`zz_misc` "other" included).
 */
export const SWITCHABLE_PLUG_TYPES = Object.freeze([
  'lamp',
  'lighting',
  'tv',
  'hometheater',
  'settop',
  'vcr',
  'game_console',
  'charger',
]);

/** Smile types this integration reads (`vendor_model` of the gateway). */
export const SMILE_MODELS = Object.freeze({
  smile: 'p1',
  smile_open_therm: 'adam',
  smile_thermo: 'anna',
});

/** The username of the local API: always `smile` for a Smile (P1, Anna, Adam). */
export const USERNAME = 'smile';

export const PATHS = Object.freeze({
  DOMAIN_OBJECTS: '/core/domain_objects',
  LOCATIONS: '/core/locations',
  APPLIANCES: '/core/appliances',
});

export const TIMEOUTS = Object.freeze({
  /** One read of /core/domain_objects (python-plugwise waits 10 s). */
  READ: 10_000,
  /** One command request, once the connection is up. */
  COMMAND: 10_000,
});

/**
 * Size cap of an answer. A large Adam sends about 220 KB of
 * /core/domain_objects (python-plugwise test data); 4 MiB leaves room for the
 * biggest installations while bounding the memory of a hostile answer.
 */
export const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Gladys waits 5 s for the acknowledgement of a command: past this budget,
 * counted from the moment the command arrives, nothing is sent (an action
 * must never run after Gladys showed a failure).
 */
export const COMMAND_BUDGET_MS = 3_500;
/** Room kept after the fresh read for the command request itself. */
export const COMMAND_MIN_SEND_MS = 800;
/** Room needed to start the fresh read at all. */
export const COMMAND_MIN_READ_MS = 1_500;
/** Once sent, Gladys gets its answer at the latest this long after the command arrived. */
export const COMMAND_ACK_MS = 4_300;
/** After a command was sent, the Smile is read again this soon to show the result. */
export const READ_AFTER_COMMAND_MS = 5_000;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export const INTERVALS = Object.freeze({
  /** A Smile P1: read every 10 s (Home Assistant's interval for a P1). */
  POWER_MS: 10 * SECOND,
  /** An Adam or an Anna: read every 30 s. */
  THERMOSTAT_MS: 30 * SECOND,
  /** The electricity index: published once a minute. */
  INDEX_MS: MINUTE,
  /** Smile unreachable: first retry, then doubled. */
  RETRY_MIN_MS: 30 * SECOND,
  RETRY_MAX_MS: 10 * MINUTE,
  /** HTTP 429: pause of every request, within these bounds (Retry-After if given). */
  BUSY_MIN_MS: MINUTE,
  BUSY_MAX_MS: 6 * HOUR,
  /** A stable value is published again after this long (dated recently in Gladys). */
  HEARTBEAT_MS: 10 * MINUTE,
  /** The test button answers within this delay (its manifest timeout is 30 s). */
  TEST_MS: 25 * SECOND,
});

/**
 * The power of the meter has not been logged again (same log date) for this
 * long: it is stale (P1 cable out), no longer published. Our clock only.
 */
export const READING_STALE_AFTER = 5 * MINUTE;

/** A heater measurement not updated for this long is obsolete (python-plugwise: 7 days). */
export const OBSOLETE_AFTER_MS = 7 * 24 * HOUR;

/** POST /state admits 300 states per minute per integration: we keep under. */
export const STATES_PER_MINUTE = 250;

// --- Plausibility of the electricity index (src/guard.js, from gladys-p1-monitor) ---
/** A home never draws more than this on average between two reads. */
export const INDEX_MAX_KW = 100;
/** kWh always accepted on top of INDEX_MAX_KW × hours (rounding, a late read). */
export const INDEX_SLACK_KWH = 0.5;
/** A power above this (W) is a glitch: a home connection never draws nor injects as much. */
export const POWER_MAX = 100_000;
