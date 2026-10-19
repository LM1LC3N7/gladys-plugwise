// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake Smile serving the
// test data of python-plugwise, through the exact wiring of the container
// (src/handlers.js).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { PlugwiseApp } from '../src/app.js';
import { normalizeConfig } from '../src/config.js';
import {
  ACTIONS,
  COMMAND_ACK_MS,
  INTERVALS,
  READ_AFTER_COMMAND_MS,
  TIMEOUTS,
} from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { CODES, SmileError } from '../src/smile/errors.js';
import { createMemoryStore } from '../src/store.js';
import { createFakeSmile, fixture, timeOf, unreachable } from './helpers/fakeSmile.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

const SELECTOR = 'plugwise';
const ID = 'abcdefgh';
const CONFIG = { host: '192.168.1.30', smile_id: ID };
const ALLOW = { ...CONFIG, allow_climate: true, allow_plugs: true };

const GATEWAY = 'da224107914542988a88561b4452b0f6';
const HEATER = '056ee145a816487eaa69243c3280f8bf';
const LIVING = 'f2bf9048bef64cc5b6d5110154e33c81';
const BATHROOM = 'f871b8c4d63549319221e294e4f88074';
const MEDIA_TV = '2568cc4b9c1e401495d4741a5f89bee1';
const BOILER_PLUG = '29542b2b6a6a4169acecc15c72a599b8';
const P1_GATEWAY_XML = 'p1v4_442_single';

const ext = (kind, id, key) => `ext:${SELECTOR}:${kind}:${id}${key ? `:${key}` : ''}`;

function createLogger() {
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  return { lines, info: log, warn: log, error: log, debug: log };
}

/** The Adam with the plug "MediaTV" unlocked (a TV: the one plug that may be switched). */
const adamUnlocked = () =>
  fixture('adam_plus_anna_new').replace(
    /(<relay_functionality id='45cfd0a5759e45699ec6e653cb867981'>\s*<updated_date>[^<]*<\/updated_date>\s*<lock>)true/,
    '$1false',
  );

async function setup({
  xml = adamUnlocked(),
  config = CONFIG,
  devices = [],
  store = createMemoryStore(),
  now,
} = {}) {
  const smile = createFakeSmile(xml);
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  await gladys.connect();
  const timers = createFakeTimers();
  const clock = { now: now ?? (timeOf(xml) || Date.parse('2026-10-18T10:00:00Z')) };
  const logger = createLogger();
  const app = new PlugwiseApp({
    gladys,
    logger,
    request: smile.request,
    now: () => clock.now,
    monotonic: () => clock.now,
    timers,
    store,
  });
  registerHandlers(gladys, app, logger);
  const start = async (c = config) => {
    await app.start(c);
  };
  /** Create every discovered device in Gladys, as the user would. */
  const createAll = async () => {
    for (const device of gladys.fake.discoveredDevices) await gladys.fake.deviceCreated(device);
  };
  /** The next reading round (the pending read timer). */
  const nextRead = async (ms) => {
    if (ms) clock.now += ms;
    await timers.run((delay) => delay >= INTERVALS.POWER_MS);
  };
  return { app, gladys, smile, timers, clock, logger, store, start, createAll, nextRead };
}

const status = (gladys) => gladys.fake.connectionStatus;
const last = (gladys, id) => gladys.fake.lastState(id);
const deviceOf = (gladys, kind, id) => gladys.devices.find((d) => d.external_id === ext(kind, id));
const featureOf = (gladys, kind, id, key) =>
  deviceOf(gladys, kind, id).features.find((f) => f.external_id === ext(kind, id, key));
const command = (gladys, kind, id, key, value) =>
  gladys.fake.setValue(deviceOf(gladys, kind, id), featureOf(gladys, kind, id, key), value);
const settle = () => new Promise((resolve) => setImmediate(resolve));
/** How long the next command waits at most for a request still running. */
const SETTLE_MS = TIMEOUTS.COMMAND + 1_000;
/** `promise`, or 'stuck' when it has not resolved within 1 s (real time). */
const orStuck = (promise) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('stuck'), 1000))]);
/** Gladys never answers the connection status. */
const statusHangs = (gladys) => {
  gladys.setConnectionStatus = () => new Promise(() => {});
};

// --- Configuration and lifecycle ------------------------------------------------------

test('configuration problems: said in the status, nothing is called', async () => {
  for (const [config, pattern] of [
    [{}, /Saisissez l’adresse du Smile/],
    [{ host: 'https://192.168.1.30', smile_id: ID }, /http simple/],
    [{ host: 'http://u:p@192.168.1.30', smile_id: ID }, /Retirez l’identifiant/],
    [{ host: '192.168.1.30' }, /Saisissez l’ID du Smile/],
    [{ host: '192.168.1.30', smile_id: 'abc' }, /8 lettres ou chiffres/],
  ]) {
    const { gladys, smile, timers, start } = await setup({ config });
    await start();
    assert.equal(status(gladys).connected, false);
    assert.match(status(gladys).message.fr, pattern);
    assert.equal(smile.calls.length, 0);
    assert.equal(timers.pending.size, 0);
  }
});

test('Adam: every device in Discovery, no value before creation, the status says what to do', async () => {
  const { gladys, smile, timers, start } = await setup();
  await start();
  assert.equal(smile.gets.length, 1);
  const ids = gladys.fake.discoveredDevices.map((d) => d.external_id).sort();
  assert.deepEqual(
    ids,
    [
      ext('gateway', GATEWAY),
      ext('heater', HEATER),
      ext('zone', LIVING),
      ext('zone', BATHROOM),
      ext('plug', MEDIA_TV),
      ext('plug', BOILER_PLUG),
      ext('plug', '10016900610d4c7481df78c89606ef22'),
      ext('plug', '67d73d0bd469422db25a618a5fb8eeb0'),
      ext('plug', '854f8a9b0e7e425db97f1f110e1ce4b3'),
    ].sort(),
  );
  assert.equal(gladys.fake.states.length, 0);
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.fr, /Adam \(firmware 3\.9\.0\) : 9 appareils trouvés/);
  assert.match(status(gladys).message.fr, /onglet « Découverte »/);
  assert.deepEqual(timers.delays(), [INTERVALS.THERMOSTAT_MS], 'the next read in 30 s');
});

test('created devices get their values: zone, heater, gateway, plugs', async () => {
  const { gladys, start, createAll, nextRead } = await setup();
  await start();
  await createAll();
  assert.equal(last(gladys, ext('zone', LIVING, 'temperature')), 19.73);
  assert.equal(last(gladys, ext('zone', LIVING, 'target')), 20.5);
  assert.equal(last(gladys, ext('zone', LIVING, 'operating')), 1, 'heating');
  assert.equal(last(gladys, ext('zone', LIVING, 'mode')), 3, 'auto: a schedule runs');
  assert.equal(last(gladys, ext('zone', LIVING, 'preset')), 'home');
  assert.equal(last(gladys, ext('zone', LIVING, 'schedule')), 'Weekschema');
  assert.equal(last(gladys, ext('zone', BATHROOM, 'mode')), 1, 'heat: no schedule');
  assert.equal(last(gladys, ext('zone', BATHROOM, 'operating')), 0);
  assert.equal(last(gladys, ext('heater', HEATER, 'flame')), 1);
  assert.equal(last(gladys, ext('heater', HEATER, 'water_temperature')), 43);
  assert.equal(last(gladys, ext('gateway', GATEWAY, 'outdoor_temperature')), 15.1);
  assert.equal(last(gladys, ext('gateway', GATEWAY, 'regulation_mode')), 'heating');
  assert.equal(last(gladys, ext('gateway', GATEWAY, 'gateway_mode')), 'full');
  assert.equal(last(gladys, ext('plug', MEDIA_TV, 'state')), 1);
  assert.equal(last(gladys, ext('plug', MEDIA_TV, 'power')), 15.8);
  assert.match(status(gladys).message.en, /9 devices found\.$/);
  // Unchanged values are not sent again at the next read.
  const count = gladys.fake.states.length;
  await nextRead(INTERVALS.THERMOSTAT_MS);
  assert.equal(gladys.fake.states.length, count);
  const badges = gladys.fake.transports.filter((t) => t.transport === 'local');
  assert.ok(badges.length >= 9);
});

test('plugs: only an unlocked lighting or entertainment plug is a switch', async () => {
  const { gladys, start } = await setup();
  await start();
  const plug = (id) => gladys.fake.discoveredDevices.find((d) => d.external_id === ext('plug', id));
  const state = (id) => plug(id).features.find((f) => f.external_id.endsWith(':state'));
  assert.equal(state(MEDIA_TV).category, 'switch');
  assert.equal(state(MEDIA_TV).read_only, false);
  for (const id of [
    BOILER_PLUG,
    '10016900610d4c7481df78c89606ef22',
    '67d73d0bd469422db25a618a5fb8eeb0',
    '854f8a9b0e7e425db97f1f110e1ce4b3',
  ]) {
    assert.equal(state(id).category, 'unknown', id);
    assert.equal(state(id).read_only, true, id);
  }
});

test('a device republished never loses a feature nor changes its shape', async () => {
  // The user created the MediaTV plug while it was a switch; it is locked since.
  const first = await setup();
  await first.start();
  const created = first.gladys.fake.discoveredDevices.find(
    (d) => d.external_id === ext('plug', MEDIA_TV),
  );
  const extra = { ...created.features[0], name: 'Old', external_id: ext('plug', MEDIA_TV, 'old') };
  const { gladys, start } = await setup({
    xml: fixture('adam_plus_anna_new'),
    devices: [{ ...created, features: [...created.features, extra] }],
  });
  await start();
  const again = gladys.fake.discoveredDevices.find((d) => d.external_id === ext('plug', MEDIA_TV));
  const state = again.features.find((f) => f.external_id.endsWith(':state'));
  assert.equal(state.category, 'switch', 'the shape of the created feature');
  assert.equal(state.read_only, false);
  assert.ok(
    again.features.some((f) => f.external_id === extra.external_id),
    'kept',
  );
});

test('reconnection to Gladys: status, Discovery and values published again; the loop goes on', async () => {
  const { gladys, smile, start, createAll } = await setup();
  await start();
  await createAll();
  const discoveries = gladys.fake.bodies('POST', '/discovered_device').length;
  const statuses = gladys.fake.connectionStatuses.length;
  const states = gladys.fake.states.length;
  gladys.emit('disconnected');
  gladys.emit('connected');
  for (let i = 0; i < 20; i += 1) await settle();
  assert.equal(smile.gets.length, 1, 'the same configuration: no new client, no new read');
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, discoveries + 1);
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.ok(gladys.fake.states.length > states, 'every value again');
});

test('unreachable: a retry 30 s later, then doubled; the status says so', async () => {
  const { gladys, smile, timers, start, nextRead } = await setup();
  smile.getAnswer = () => {
    throw unreachable();
  };
  await start();
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.en, /could not be read \(no connection\)\. New try in 30 s/);
  assert.deepEqual(timers.delays(), [30_000]);
  await nextRead(30_000);
  assert.deepEqual(timers.delays(), [60_000]);
  smile.getAnswer = null;
  await nextRead(60_000);
  assert.equal(status(gladys).connected, true);
  assert.deepEqual(timers.delays(), [INTERVALS.THERMOSTAT_MS]);
});

test('HTTP 401: blocked, kept in /data as a hash, never retried alone; a save retries', async () => {
  const store = createMemoryStore();
  const { gladys, smile, timers, start } = await setup({ store });
  smile.getAnswer = () => ({ status: 401, headers: {}, body: Buffer.alloc(0) });
  await start();
  assert.match(status(gladys).message.en, /refused the Smile ID/);
  assert.equal(timers.pending.size, 0);
  const saved = store.data._access.refusedKey;
  assert.match(saved, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(store.data).includes(ID), 'never the Smile ID in /data');
  // A restart of the container with the same configuration: not retried.
  const again = await setup({ store });
  again.smile.getAnswer = smile.getAnswer;
  await again.start();
  assert.equal(again.smile.calls.length, 0);
  assert.match(status(again.gladys).message.en, /refused the Smile ID/);
  // Saving the configuration tries again.
  again.smile.getAnswer = null;
  await again.gladys.fake.configUpdated(CONFIG);
  assert.equal(again.smile.gets.length, 1);
  assert.equal(status(again.gladys).connected, true);
  assert.equal(again.store.data._access.refusedKey, null);
});

test('HTTP 429: every request paused (Retry-After, bounded), kept across a restart', async () => {
  const store = createMemoryStore();
  const { gladys, smile, timers, start } = await setup({ store });
  smile.getAnswer = () => ({
    status: 429,
    headers: { 'retry-after': '30' },
    body: Buffer.alloc(0),
  });
  await start();
  assert.match(status(gladys).message.en, /slow down \(HTTP 429\).*New try in 1 min/);
  assert.deepEqual(timers.delays(), [INTERVALS.BUSY_MIN_MS], 'never under one minute');
  const again = await setup({ store });
  await again.start();
  assert.equal(again.smile.calls.length, 0, 'still paused after a restart');
  assert.match(status(again.gladys).message.en, /HTTP 429/);
});

test('not a Smile, an unsupported Smile: said; read again slowly', async () => {
  const { gladys, smile, timers, start } = await setup();
  smile.getAnswer = () => ({ status: 200, headers: {}, body: Buffer.from('<html/>') });
  await start();
  assert.match(status(gladys).message.en, /does not answer like a Plugwise Smile/);
  const legacy = await setup({ xml: fixture('legacy_anna') });
  await legacy.start();
  assert.match(status(legacy.gladys).message.en, /older firmware/);
  assert.deepEqual(legacy.timers.delays(), [INTERVALS.RETRY_MAX_MS]);
  assert.equal(legacy.gladys.fake.discoveredDevices.length, 0);
  assert.ok(timers.pending.size > 0);
});

test('the test button reads now and lists what it found', async () => {
  const { gladys, smile } = await setup();
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, true);
  assert.match(ack.data.message.fr, /Adam lu \(firmware 3\.9\.0\) : 2 zones, 5 prises/);
  smile.getAnswer = () => {
    throw unreachable();
  };
  const failed = await gladys.fake.action(ACTIONS.TEST);
  assert.match(failed.data.message.en, /could not be read/);
});

// --- Commands --------------------------------------------------------------------------

async function ready(options = {}) {
  const env = await setup({ config: ALLOW, ...options });
  await env.start();
  await env.createAll();
  return env;
}

test('commands are off by default: refused at once, nothing read nor sent', async () => {
  const env = await setup();
  await env.start();
  await env.createAll();
  const gets = env.smile.gets.length;
  const ack = await command(env.gladys, 'zone', LIVING, 'target', 21);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Allow the thermostat commands/);
  const plug = await command(env.gladys, 'plug', MEDIA_TV, 'state', 0);
  assert.match(plug.error, /Allow switching the plugs/);
  assert.equal(env.smile.gets.length, gets);
  assert.equal(env.smile.puts.length, 0);
});

test('setpoint: read again, then sent; the Smile read soon after to show the result', async () => {
  const { gladys, smile, timers } = await ready();
  const gets = smile.gets.length;
  const ack = await command(gladys, 'zone', LIVING, 'target', 21.04);
  assert.equal(ack.success, true, ack.error);
  assert.equal(smile.gets.length, gets + 1, 'a fresh read before acting');
  assert.equal(smile.puts.length, 1);
  assert.equal(
    smile.puts[0].path,
    `/core/locations;id=${LIVING}/thermostat;id=928d6446caad406d9eb2340dd1134e32`,
  );
  assert.equal(
    smile.puts[0].body,
    '<thermostat_functionality><setpoint>21</setpoint></thermostat_functionality>',
  );
  assert.ok(smile.puts[0].sendWithin > 0, 'connected by the deadline or not sent');
  assert.deepEqual(timers.delays(), [READ_AFTER_COMMAND_MS]);
  assert.equal(last(gladys, ext('zone', LIVING, 'target')), 20.5, 'never the value asked');
});

test('setpoint: the value checked strictly; the bounds of the zone on the fresh read', async () => {
  const xml = adamUnlocked().replace(
    /(<thermostat_functionality id='928d6446caad406d9eb2340dd1134e32'>[\s\S]*?<upper_bound>)35</,
    '$125<',
  );
  const { gladys, smile } = await ready({ xml });
  for (const value of [
    null,
    '',
    true,
    'abc',
    3.9,
    30.01,
    NaN,
    '0x14',
    '1e1',
    ' 21',
    '21.',
    '+21',
  ]) {
    const ack = await command(gladys, 'zone', LIVING, 'target', value);
    assert.equal(ack.success, false, String(value));
    assert.match(ack.error, /from 4 to 30/);
  }
  const gets = smile.gets.length;
  const above = await command(gladys, 'zone', LIVING, 'target', 26);
  assert.match(above.error, /from 4 to 25/, 'the bounds the Smile gives');
  assert.equal(smile.gets.length, gets + 1);
  const already = await command(gladys, 'zone', LIVING, 'target', 20.5);
  assert.equal(already.success, true);
  assert.equal(smile.puts.length, 0, 'nothing sent: out of bounds, or already set');
});

test('the option is checked again just before sending', async () => {
  const { app, gladys, smile } = await ready();
  smile.onGet = () => {
    app.config = normalizeConfig({ ...ALLOW, allow_climate: false });
  };
  const ack = await command(gladys, 'zone', LIVING, 'target', 21);
  assert.match(ack.error, /Allow the thermostat commands/);
  assert.equal(smile.puts.length, 0);
});

test('a slow Smile: past 3.5 s nothing is sent; a failed read sends nothing', async () => {
  const { gladys, smile, clock } = await ready();
  smile.onGet = () => {
    clock.now += 3000;
  };
  const slow = await command(gladys, 'zone', LIVING, 'target', 21);
  assert.match(slow.error, /too slow to answer: command not sent/);
  smile.onGet = null;
  smile.getAnswer = () => {
    throw unreachable();
  };
  const failed = await command(gladys, 'zone', LIVING, 'target', 21);
  assert.match(failed.error, /could not be read just before acting \(no connection\)/);
  assert.equal(smile.puts.length, 0);
});

test('the answer of a command: sent without confirmation, refused, not sent', async () => {
  const { gladys, smile, timers } = await ready();
  // No answer: Gladys is told at 4.3 s that it was sent, without confirmation.
  smile.putAnswer = () => new Promise(() => {});
  const pending = command(gladys, 'zone', LIVING, 'target', 21);
  while (smile.puts.length === 0) await settle();
  await settle();
  await timers.run((ms) => ms > 0 && ms <= COMMAND_ACK_MS);
  const late = await pending;
  assert.equal(late.success, false);
  assert.match(late.error, /^Command sent to the Smile, without confirmation/);
  assert.ok(timers.delays().includes(READ_AFTER_COMMAND_MS), 'read again soon');
  // The next commands wait for its request to end: here its time limit.
  await timers.run((ms) => ms === SETTLE_MS);
  // A 5xx after sending: it may have been applied.
  smile.putAnswer = () => {
    throw new SmileError(CODES.HTTP, 'HTTP 500', { status: 500 });
  };
  assert.match((await command(gladys, 'zone', LIVING, 'target', 21)).error, /without confirmation/);
  // A 4xx: the Smile refused it.
  smile.putAnswer = () => {
    throw new SmileError(CODES.HTTP, 'HTTP 400', { status: 400 });
  };
  assert.match((await command(gladys, 'zone', LIVING, 'target', 21)).error, /refused the command/);
});

test('a command never connected is "not sent"', async () => {
  const { gladys, smile } = await ready();
  smile.putConnects = false;
  smile.putAnswer = () => {
    throw unreachable();
  };
  const ack = await command(gladys, 'zone', LIVING, 'target', 21);
  assert.match(ack.error, /^Command not sent to the Smile \(no connection\)/);
});

test('preset and Adam modes: the Smile’s options only; off and bleeding never', async () => {
  const { gladys, smile } = await ready();
  assert.equal((await command(gladys, 'zone', LIVING, 'preset', 'asleep')).success, true);
  assert.match(smile.puts.at(-1).body, /<preset>asleep<\/preset>/);
  assert.match(
    (await command(gladys, 'zone', LIVING, 'preset', 'party')).error,
    /not one of the Smile/,
  );
  assert.equal((await command(gladys, 'zone', LIVING, 'preset', 'home')).success, true, 'already');
  const puts = smile.puts.length;
  for (const mode of ['off', 'bleeding_hot', 'bleeding_cold']) {
    const ack = await command(gladys, 'gateway', GATEWAY, 'regulation_mode', mode);
    assert.match(ack.error, /Only "heating" and "cooling"/, mode);
  }
  assert.match(
    (await command(gladys, 'gateway', GATEWAY, 'regulation_mode', 'cooling')).error,
    /not one of the Smile/,
    'no cooling on this Adam',
  );
  assert.equal(
    (await command(gladys, 'gateway', GATEWAY, 'regulation_mode', 'heating')).success,
    true,
  );
  assert.equal(smile.puts.length, puts, 'nothing sent for the modes so far');
  assert.equal(
    (await command(gladys, 'gateway', GATEWAY, 'gateway_mode', 'vacation')).success,
    true,
  );
  assert.match(smile.puts.at(-1).body, /<mode>vacation<\/mode><valid_from>/);
  assert.match(
    (await command(gladys, 'gateway', GATEWAY, 'gateway_mode', 'party')).error,
    /not one of the Smile/,
  );
});

test('plugs: switched only when unlocked AND a lighting or entertainment type, read now', async () => {
  const { gladys, smile } = await ready();
  assert.equal((await command(gladys, 'plug', MEDIA_TV, 'state', 0)).success, true);
  assert.equal(smile.puts.at(-1).path, `/core/appliances;id=${MEDIA_TV}/relay`);
  assert.equal(
    smile.puts.at(-1).body,
    '<relay_functionality><state>off</state></relay_functionality>',
  );
  assert.equal((await command(gladys, 'plug', MEDIA_TV, 'state', 1)).success, true, 'already on');
  assert.equal(smile.puts.length, 1);
  // The water heater: unlocked, but never switched.
  const boiler = await command(gladys, 'plug', BOILER_PLUG, 'state', 0);
  assert.match(boiler.error, /"water_heater_vessel" appliance/);
  // Locked since the last read: refused on the fresh read.
  smile.xml = fixture('adam_plus_anna_new');
  const locked = await command(gladys, 'plug', MEDIA_TV, 'state', 0);
  assert.match(locked.error, /locked in Plugwise/);
  for (const value of [2, '', null, true, 'on']) {
    assert.match((await command(gladys, 'plug', MEDIA_TV, 'state', value)).error, /0 or 1/);
  }
  assert.equal(smile.puts.length, 1);
});

/** The Adam with the setpoint of the living room at `value`. */
const livingAt = (value) =>
  adamUnlocked().replace(
    /(<thermostat_functionality id='928d6446caad406d9eb2340dd1134e32'>[\s\S]*?<setpoint>)20\.5</,
    `$1${value}<`,
  );

/** Send a command whose PUT does not answer; Gladys gets "without confirmation" at 4.3 s. */
async function unanswered(env, kind, id, key, value) {
  let answer;
  env.smile.putAnswer = () =>
    new Promise((resolve) => {
      answer = () => resolve({ status: 202, headers: {}, body: Buffer.alloc(0) });
    });
  const puts = env.smile.puts.length;
  const pending = command(env.gladys, kind, id, key, value);
  while (env.smile.puts.length === puts) await settle();
  await settle();
  await env.timers.run((ms) => ms > 0 && ms <= COMMAND_ACK_MS);
  const ack = await pending;
  assert.match(ack.error, /without confirmation/);
  env.smile.putAnswer = () => ({ status: 202, headers: {}, body: Buffer.alloc(0) });
  return () => answer();
}

test('plug off still on its way, then on: never "already on", the second one runs out of time', async () => {
  const env = await ready();
  const { gladys, smile, timers, clock } = env;
  await unanswered(env, 'plug', MEDIA_TV, 'state', 0);
  // The Smile still shows the plug on: the next command must not conclude "already".
  const gets = smile.gets.length;
  const on = command(gladys, 'plug', MEDIA_TV, 'state', 1);
  for (let i = 0; i < 20; i += 1) await settle();
  assert.equal(smile.gets.length, gets, 'it waits for the first request to end');
  // The first request ends at its time limit: too late for the second one.
  clock.now += SETTLE_MS;
  await timers.run((ms) => ms === SETTLE_MS);
  const ack = await on;
  assert.equal(ack.success, false);
  assert.match(ack.error, /too slow to answer: command not sent/);
  assert.equal(smile.puts.length, 1, 'only the first one was sent');
});

test('setpoint 22 still on its way, then 20: read once 22 is applied, 20 sent', async () => {
  const env = await ready({ xml: livingAt(20) });
  const { gladys, smile } = env;
  const answer = await unanswered(env, 'zone', LIVING, 'target', 22);
  const back = command(gladys, 'zone', LIVING, 'target', 20);
  for (let i = 0; i < 20; i += 1) await settle();
  assert.equal(smile.puts.length, 1, 'waiting, not "already 20"');
  // The Smile applies 22 and answers: the second command reads it, then sends 20.
  smile.xml = livingAt(22);
  answer();
  const ack = await back;
  assert.equal(ack.success, true, ack.error);
  assert.equal(smile.puts.length, 2);
  assert.match(smile.puts[1].body, /<setpoint>20<\/setpoint>/);
});

test('a 429 or a 401 met by a command: Gladys gets its answer even if the status hangs', async () => {
  const busy = await ready();
  statusHangs(busy.gladys);
  busy.smile.getAnswer = () => ({ status: 429, headers: {}, body: Buffer.alloc(0) });
  const read = await orStuck(command(busy.gladys, 'zone', LIVING, 'target', 21));
  assert.notEqual(read, 'stuck');
  assert.match(read.error, /could not be read just before acting/);
  assert.equal(busy.app.paused(), true, 'the pause applies to every path');

  const refused = await ready();
  statusHangs(refused.gladys);
  refused.smile.putAnswer = () => {
    throw new SmileError(CODES.HTTP, 'HTTP 401', { status: 401 });
  };
  const put = await orStuck(command(refused.gladys, 'zone', LIVING, 'target', 21));
  assert.notEqual(put, 'stuck');
  assert.match(put.error, /refused the command/);
  assert.equal(refused.app.blocked, true);
});

test('a permission taken away applies at once, before the queued restart', async () => {
  const { app, gladys, smile } = await ready();
  // A restart in progress holds the queue.
  let release;
  smile.onGet = () => new Promise((resolve) => (release = resolve));
  const restart = app.start(ALLOW, { force: true });
  while (!release) await settle();
  smile.onGet = null;
  void gladys.fake.configUpdated({ ...ALLOW, allow_climate: false, allow_plugs: false });
  for (let i = 0; i < 10; i += 1) await settle();
  assert.equal(app.config.allowClimate, false);
  assert.equal(app.config.allowPlugs, false);
  release();
  await restart;
});

test('preset without a zone type, setpoint bounds that contradict: nothing sent', async () => {
  const noType = adamUnlocked().replace(
    /(<location id='f2bf9048bef64cc5b6d5110154e33c81'>[\s\S]*?)<type>livingroom<\/type>/,
    '$1',
  );
  const first = await ready({ xml: noType });
  const preset = await command(first.gladys, 'zone', LIVING, 'preset', 'asleep');
  assert.match(preset.error, /no type or name for this zone/);
  assert.equal(first.smile.puts.length, 0);

  const crossed = adamUnlocked().replace(
    /(<thermostat_functionality id='928d6446caad406d9eb2340dd1134e32'>[\s\S]*?<lower_bound>)1</,
    '$125<',
  );
  const bounds = crossed.replace(
    /(<thermostat_functionality id='928d6446caad406d9eb2340dd1134e32'>[\s\S]*?<upper_bound>)35</,
    '$120<',
  );
  const second = await ready({ xml: bounds });
  const ack = await command(second.gladys, 'zone', LIVING, 'target', 21);
  assert.match(ack.error, /bounds for this zone that leave no valid value/);
  assert.equal(second.smile.puts.length, 0);
});

test('a status Gladys did not take is sent again at the reconnection', async () => {
  const { gladys, start } = await setup();
  const original = gladys.setConnectionStatus;
  gladys.setConnectionStatus = async () => {
    throw new Error('Gladys away');
  };
  await start();
  gladys.setConnectionStatus = original;
  const before = gladys.fake.connectionStatuses.length;
  gladys.emit('disconnected');
  gladys.emit('connected');
  for (let i = 0; i < 20; i += 1) await settle();
  assert.equal(gladys.fake.connectionStatuses.length, before + 1);
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.en, /9 devices found/);
});

// --- The smart meter (Smile P1) and its index -------------------------------------------

const P1 = (consumed = {}, extra = (x) => x) => {
  let xml = fixture(P1_GATEWAY_XML);
  if (consumed.offpeak !== undefined) {
    xml = xml.replace(/(tariff="nl_offpeak">)17643423\.00</, `$1${consumed.offpeak}<`);
  }
  if (consumed.peak !== undefined) {
    xml = xml.replace(/(tariff="nl_peak">)13966608\.00</, `$1${consumed.peak}<`);
  }
  return extra(xml);
};
const METER = '03e65b16e4b247a29ae0d75a78cb492e';

test('Smile P1: one index in the energy monitoring (peak + off-peak), the rest plain', async () => {
  const { gladys, timers, start, createAll } = await setup({ xml: P1() });
  await start();
  const [meter] = gladys.fake.discoveredDevices;
  const gateway = meter.external_id.split(':').at(-1);
  assert.match(gateway, /^[0-9a-f]{32}$/);
  const byKey = Object.fromEntries(meter.features.map((f) => [f.external_id.split(':').at(-1), f]));
  assert.equal(byKey.consumption_index.category, 'energy-sensor');
  assert.equal(byKey.consumption_index.type, 'index');
  assert.equal(byKey.consumption_index.unit, 'kilowatt-hour');
  assert.equal(byKey.power.type, 'power');
  for (const key of [
    'consumption_peak',
    'consumption_offpeak',
    'injection_peak',
    'injection_offpeak',
    'injection_power',
  ]) {
    assert.equal(byKey[key].category, 'unknown', key);
  }
  const energy = meter.features.filter(
    (f) => f.category === 'energy-sensor' && ['index', 'energy'].includes(f.type),
  );
  assert.equal(energy.length, 1, 'never the injection nor a tariff in the energy monitoring');
  assert.deepEqual(timers.delays(), [INTERVALS.POWER_MS], 'a P1 is read every 10 s');
  await createAll();
  const id = (key) => `${meter.external_id}:${key}`;
  assert.equal(last(gladys, id('power')), 486);
  assert.equal(last(gladys, id('consumption_index')), 31610.031);
  assert.equal(last(gladys, id('consumption_offpeak')), 17643.423);
  assert.equal(last(gladys, id('injection_peak')), undefined, 'a counter at 0 is never sent');
  assert.ok(METER);
});

test('Smile P1: a meter giving one tariff only has plain sensors, no index', async () => {
  const xml = P1({}, (x) =>
    x.replace(/<measurement[^>]*tariff="nl_peak">13966608\.00<\/measurement>/, ''),
  );
  const { gladys, start } = await setup({ xml });
  await start();
  const keys = gladys.fake.discoveredDevices[0].features.map((f) =>
    f.external_id.split(':').at(-1),
  );
  assert.ok(!keys.includes('consumption_index'));
  assert.ok(keys.includes('consumption_offpeak'));
});

test('Smile P1: a jump of the index is held until the user accepts it; never 0', async () => {
  const store = createMemoryStore();
  const { gladys, smile, start, createAll, nextRead } = await setup({ xml: P1(), store });
  await start();
  await createAll();
  const id = `${gladys.fake.discoveredDevices[0].external_id}:consumption_index`;
  const indexes = () =>
    gladys.fake.states.filter((s) => s.device_feature_external_id === id).map((s) => s.state);
  assert.deepEqual(indexes(), [31610.031]);
  // +5,000 kWh in one minute: held, the last accepted value stays.
  smile.xml = P1({ offpeak: '22643423.00' });
  await nextRead(60_000);
  assert.deepEqual([...new Set(indexes())], [31610.031]);
  assert.match(status(gladys).message.en, /jumped from 31610\.031 to 36610\.031 kWh: held back/);
  assert.equal(store.data[id].held.direction, 'up');
  // A register at 0: no index at all, never 0.
  smile.xml = P1({ offpeak: '0.00' });
  await nextRead(60_000);
  assert.ok(!indexes().includes(0));
  // The user accepts what is shown.
  smile.xml = P1({ offpeak: '22643423.00' });
  await nextRead(60_000);
  const ack = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(ack.data.message.en, /Accepted: the index 36610\.031 kWh/);
  await nextRead(10_000);
  assert.equal(indexes().at(-1), 36610.031);
  assert.equal(store.data[id].held, null);
  const nothing = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(nothing.data.message.en, /nothing to accept/);
});

test('another Smile: its meter gets its own guard, nothing of the first one under its key', async () => {
  const store = createMemoryStore();
  const { gladys, smile, start, createAll } = await setup({ xml: P1(), store });
  await start();
  await createAll();
  const first = gladys.fake.discoveredDevices[0].external_id;
  const firstGateway = first.split(':').at(-1);
  const firstIndex = `${first}:consumption_index`;
  assert.equal(last(gladys, firstIndex), 31610.031);
  const kept = structuredClone(store.data[firstIndex]);
  // The same address now answers with another Smile P1, at a much lower index.
  const OTHER = 'fedcba9876543210fedcba9876543210';
  smile.xml = P1({ offpeak: '1000000.00', peak: '500000.00' }).replaceAll(firstGateway, OTHER);
  await gladys.fake.configUpdated(CONFIG);
  await createAll();
  const otherIndex = ext('meter', OTHER, 'consumption_index');
  assert.equal(last(gladys, otherIndex), 1500, 'never held against the first meter');
  assert.equal(store.data[otherIndex].last.value, 1500);
  assert.equal(store.data[otherIndex].held, null);
  assert.deepEqual(store.data[firstIndex], kept, 'the first meter untouched');
  assert.doesNotMatch(status(gladys).message.en, /held back/);
  // Back to the first Smile, both meters created: each its own guard again.
  const otherKept = structuredClone(store.data[otherIndex]);
  smile.xml = P1();
  await gladys.fake.configUpdated(CONFIG);
  assert.equal(last(gladys, firstIndex), 31610.031, 'never the value of the other meter');
  assert.deepEqual(store.data[firstIndex], kept);
  assert.deepEqual(store.data[otherIndex], otherKept, 'the other meter untouched');
  assert.doesNotMatch(status(gladys).message.en, /held back/);
});

test('Smile P1: the meter not connected, or a frozen power: not published', async () => {
  const xml = P1({}, (x) =>
    x.replace(
      '</domain_objects>',
      "<notification id='aaaa0000aaaa0000aaaa0000aaaa0000'><type>warning</type><message>P1 does not seem to be connected to a smart meter.</message></notification></domain_objects>",
    ),
  );
  const off = await setup({ xml });
  await off.start();
  await off.createAll();
  assert.equal(off.gladys.fake.states.length, 0);
  assert.match(status(off.gladys).message.en, /smart meter is not connected/);

  const { gladys, start, createAll, nextRead } = await setup({ xml: P1() });
  await start();
  await createAll();
  const id = `${gladys.fake.discoveredDevices[0].external_id}:power`;
  const powers = () => gladys.fake.states.filter((s) => s.device_feature_external_id === id).length;
  const offpeak = () =>
    gladys.fake.states.filter((s) => s.device_feature_external_id.endsWith(':consumption_offpeak'))
      .length;
  // The same log date for 5 minutes: the power is stale.
  for (let i = 0; i < 31; i += 1) await nextRead(10_000);
  assert.match(status(gladys).message.en, /no new power reading/);
  gladys.forgetPublishedStates();
  const [count, indexes] = [powers(), offpeak()];
  await nextRead(60_000);
  assert.equal(powers(), count, 'no power once stale');
  assert.equal(offpeak(), indexes + 1, 'the indexes go on');
});

test('Anna: its room, the heating state from the boiler', async () => {
  const { gladys, start, createAll } = await setup({ xml: fixture('anna_v4') });
  await start();
  const names = gladys.fake.discoveredDevices.map((d) => d.name);
  assert.ok(
    names.some((n) => n.startsWith('Anna - ')),
    names.join(),
  );
  await createAll();
  const zone = gladys.fake.discoveredDevices.find((d) => d.external_id.includes(':zone:'));
  assert.equal(last(gladys, `${zone.external_id}:operating`), 1, 'the boiler heats');
  assert.equal(last(gladys, `${zone.external_id}:target`), 20.5);
});
