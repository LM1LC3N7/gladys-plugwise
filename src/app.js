// -----------------------------------------------------------------------------
// PlugwiseApp: the integration. One Smile (P1, Anna or Adam), read through its
// local XML API.
//
//   start(config)  (re)connects: the Smile read, Discovery published, the
//                  reading loop started. The same configuration again (Gladys
//                  reconnected) only publishes everything again: the client,
//                  a refusal of the Smile ID and an HTTP 429 pause stay.
//   reading loop   /core/domain_objects every 10 s (P1) or 30 s (Adam, Anna);
//                  the electricity index once a minute, through the index
//                  guard of gladys-p1-monitor (src/guard.js). Unreachable: a
//                  retry 30 s to 10 min later; HTTP 429: a pause of 1 min to
//                  6 h for every path; HTTP 401: nothing sent again until the
//                  user saves the configuration or presses "Test the
//                  connection". The refusal (a hash, never the ID) and the
//                  pause are kept in /data.
//   setValue       the commands, see "Commands" below.
//
// Each loop is one chain of timers: halt() bumps an epoch, and a run of an
// older epoch never schedules itself again. The created devices are read from
// `gladys.devices`, which the SDK keeps up to date: never a copy of our own.
// Two clocks: `now` (wall clock) dates the index, the pauses and the
// commands; `monotonic` paces the index and the freshness of the power.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { Budget } from './budget.js';
import { credentialsKey, newSalt, normalizeConfig } from './config.js';
import {
  COMMAND_ACK_MS,
  COMMAND_BUDGET_MS,
  COMMAND_MIN_READ_MS,
  COMMAND_MIN_SEND_MS,
  COMMANDABLE_REGULATION_MODES,
  GATEWAY_FEATURES as GF,
  GATEWAY_MODES,
  INTERVALS,
  KINDS,
  METER_FEATURES as MF,
  PLUG_FEATURES as PF,
  READ_AFTER_COMMAND_MS,
  READING_STALE_AFTER,
  SETPOINT,
  STATES_PER_MINUTE,
  SWITCHABLE_PLUG_TYPES,
  ZONE_FEATURES as ZF,
} from './constants.js';
import {
  buildDevices,
  climateStates,
  idsOf,
  meterIndexStates,
  meterLiveStates,
  parseExternalId,
  round,
  setpointBounds,
} from './devices.js';
import { IndexGuard, indexOfTariffs } from './guard.js';
import { T } from './i18n.js';
import { SmileClient } from './smile/client.js';
import { CODES, isAuthRefused } from './smile/errors.js';
import { httpRequest } from './smile/http.js';
import { createFileStore } from './store.js';

/** Entries per publishTransports call (the SDK refuses more). */
const TRANSPORTS_PER_CALL = 100;
/** The key of the access state (refusal, pause) in /data, next to the index guards. */
const ACCESS_KEY = '_access';
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** The index Gladys already holds for a feature of a created device, when it says so. */
function lastValueOf(device, featureId) {
  const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
  const value = Number(feature?.last_value);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return feature?.last_value !== null &&
    feature?.last_value !== undefined &&
    Number.isFinite(value) &&
    Number.isFinite(at)
    ? { value, at }
    : undefined;
}

/** The tariffs kept in /data with the guard: `{ low, high }` of the last index accepted. */
const validTariffs = (tariffs) =>
  tariffs && Number.isFinite(tariffs.low) && Number.isFinite(tariffs.high)
    ? { low: tariffs.low, high: tariffs.high }
    : undefined;

export class PlugwiseApp {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {object} [options.logger]
   * @param {Function} [options.request] the HTTP transport (tests inject a fake Smile)
   * @param {() => number} [options.now]
   * @param {() => number} [options.monotonic]
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   * @param {object} [options.store] the /data store (src/store.js)
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'plugwise' }),
    request = httpRequest,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = createFileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.request = request;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.budget = new Budget({ perMinute: STATES_PER_MINUTE, now });
    this.budgetCursor = 0;
    this.rawConfig = {};
    this.config = normalizeConfig();
    this.configKey = null;
    this.client = null;
    this.generation = 0;
    this.epoch = 0;
    this.handles = new Set();
    this.queue = Promise.resolve();
    /** One Smile: the commands run one after the other. */
    this.commands = Promise.resolve();
    this.lastStatus = null;
    /** The index guard of the meter (src/guard.js), its tariffs, what was saved. */
    this.guard = undefined;
    this.tariffRef = undefined;
    this.savedGuard = undefined;
    this.indexUndefined = false;
    this.lastIndexAt = undefined;
    this.readingStamp = undefined;
    this.freshAt = 0;
    const access = this.loadAccess();
    /** credentialsKey() of the Smile ID refused (HTTP 401), kept in /data. */
    this.refusedKey = access.refusedKey;
    /** HTTP 429: no request before this time (wall clock), kept in /data. */
    this.pausedUntil = access.pausedUntil;
    /** The salt of credentialsKey(), kept with it. */
    this.salt = access.salt;
    this.reset();
  }

  reset() {
    this.online = false;
    this.blocked = false;
    this.unsupported = null;
    this.retryDelay = INTERVALS.RETRY_MIN_MS;
    this.nextReadAt = 0;
    this.model = null;
    this.discoveredKey = null;
    this.transports = new Map();
  }

  // --- /data: the refusal of the Smile ID and the 429 pause -------------------------

  loadAccess() {
    const saved = this.store.load()[ACCESS_KEY];
    const refusedKey =
      typeof saved?.refusedKey === 'string' && /^[0-9a-f]{64}$/.test(saved.refusedKey)
        ? saved.refusedKey
        : null;
    // A pause read back is never longer than the longest one we set.
    const until = Number(saved?.pausedUntil);
    const pausedUntil = Number.isFinite(until)
      ? Math.min(until, this.now() + INTERVALS.BUSY_MAX_MS)
      : 0;
    const salt =
      typeof saved?.salt === 'string' && /^[0-9a-f]{32}$/.test(saved.salt) ? saved.salt : newSalt();
    return { refusedKey, pausedUntil: pausedUntil > this.now() ? pausedUntil : 0, salt };
  }

  async saveAccess() {
    try {
      await this.store.save({
        ...this.store.load(),
        [ACCESS_KEY]: {
          refusedKey: this.refusedKey,
          salt: this.salt,
          pausedUntil: this.pausedUntil,
        },
      });
    } catch (err) {
      this.logger.warn(`Saving the access state in /data failed (${err?.code ?? 'error'})`);
    }
  }

  // --- Lifecycle -------------------------------------------------------------------

  /** Run `task` after every start already queued. */
  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * (Re)start with a configuration. Calls are serialized. `force`: the user
   * asked (button, saved configuration): a refused Smile ID is tried again
   * and an HTTP 429 pause is lifted. It accepts no held index: only its own
   * button does.
   */
  start(rawConfig, { force = false } = {}) {
    return this.enqueue(() => this.run(rawConfig, { force }));
  }

  async stop() {
    this.generation += 1;
    this.halt();
    this.dropClient();
  }

  /** Gladys went away: the loop stops, everything else (client, refusal, pause) stays. */
  pause() {
    this.halt();
  }

  /** Clear every timer; the runs still in flight will not schedule again. */
  halt() {
    this.epoch += 1;
    for (const handle of this.handles) this.timers.clearTimeout(handle);
    this.handles.clear();
  }

  dropClient() {
    this.client?.close();
    this.client = null;
  }

  async run(rawConfig, { force = false } = {}) {
    const config = normalizeConfig(rawConfig);
    const key = JSON.stringify(config);
    if (!force && this.client && key === this.configKey && !this.blocked) {
      await this.resume();
      return;
    }
    this.halt();
    this.dropClient();
    const generation = ++this.generation;
    this.rawConfig = rawConfig ?? {};
    this.config = config;
    this.configKey = key;
    this.reset();
    this.lastStatus = null;
    this.gladys.forgetPublishedStates?.();
    this.lastIndexAt = undefined;

    const invalid = this.configProblem(config);
    if (invalid) {
      await this.setStatus(false, invalid);
      return;
    }
    if (force && (this.refusedKey || this.pausedUntil)) {
      this.refusedKey = null;
      this.pausedUntil = 0;
      await this.saveAccess();
    }
    if (this.refusedKey && this.refusedKey === credentialsKey(config, this.salt)) {
      // Refused earlier with these very values: not tried again alone.
      this.blocked = true;
      await this.setStatus(false, T.status.authRefused);
      return;
    }
    if (this.refusedKey) {
      // Another ID or address: the old refusal does not apply.
      this.refusedKey = null;
      await this.saveAccess();
    }
    this.client = new SmileClient({
      origin: config.smile.origin,
      smileId: config.smileId,
      request: this.request,
      now: this.now,
    });
    this.logger.info(`Using the Smile at ${config.smile.origin}`);
    if (this.paused()) {
      const delay = this.pausedUntil - this.now();
      await this.setStatus(false, T.status.busy(delay));
      this.scheduleRead(delay, generation);
      return;
    }
    await this.read(generation, this.epoch, { publish: true });
  }

  configProblem(config) {
    if (config.hostError) {
      return (
        {
          empty: T.status.hostEmpty,
          credentials: T.status.hostCredentials,
          https: T.status.hostHttps,
        }[config.hostError] ?? T.status.hostInvalid
      );
    }
    if (config.smileIdError) {
      return config.smileIdError === 'empty' ? T.status.idEmpty : T.status.idInvalid;
    }
    return null;
  }

  /**
   * Gladys reconnected with the same configuration: the status, Discovery and
   * every value are published again (a restarted Gladys lost them), the
   * reading loop goes on where it was.
   */
  async resume() {
    this.halt();
    const generation = this.generation;
    const status = this.lastStatus ? JSON.parse(this.lastStatus) : null;
    this.lastStatus = null;
    this.transports.clear();
    this.discoveredKey = null;
    this.lastIndexAt = undefined;
    this.gladys.forgetPublishedStates?.();
    if (status) await this.setStatus(status[0], status[1]);
    if (this.model) {
      await this.publishDiscovered();
      await this.publishStates();
    }
    await this.publishTransports();
    if (this.client && !this.blocked) {
      const wait = Math.max(this.nextReadAt, this.pausedUntil) - this.now();
      this.scheduleRead(Math.max(0, wait), generation);
    }
  }

  schedule(delay, task) {
    const handle = this.timers.setTimeout(async () => {
      this.handles.delete(handle);
      try {
        await task();
      } catch (err) {
        this.logger.error(`Loop failed (${err?.name ?? 'Error'})`);
      }
    }, delay);
    this.handles.add(handle);
    return handle;
  }

  scheduleRead(delay, generation) {
    const epoch = this.epoch;
    this.schedule(delay, () => this.read(generation, epoch, { publish: false }));
  }

  /** May a loop of this generation and epoch go on? */
  current(generation, epoch) {
    return generation === this.generation && epoch === this.epoch && !this.blocked;
  }

  paused() {
    return this.now() < this.pausedUntil;
  }

  interval() {
    return this.model?.smile === 'p1' ? INTERVALS.POWER_MS : INTERVALS.THERMOSTAT_MS;
  }

  /** One round of the reading loop. Never throws. */
  async read(generation, epoch, { publish }) {
    if (!this.client || !this.current(generation, epoch)) return;
    this.nextReadAt = this.now() + this.interval();
    let applied;
    try {
      applied = await this.refresh({ publish });
    } catch (err) {
      // A round halted meanwhile (Gladys away, new configuration) schedules
      // nothing: the next start or resume reads again.
      if (generation === this.generation && epoch === this.epoch)
        await this.failed(err, generation);
      else this.online = false;
      return;
    }
    if (!this.current(generation, epoch)) return;
    // An unsupported Smile will not change by itself: read again slowly.
    this.scheduleRead(
      applied === 'unsupported' ? INTERVALS.RETRY_MAX_MS : this.interval(),
      generation,
    );
  }

  /** A reading failed: final refusal, or a retry with a growing delay. */
  async failed(err, generation) {
    const wasOnline = this.online;
    this.online = false;
    this.halt();
    await this.publishTransports();
    if (isAuthRefused(err)) {
      this.blocked = true;
      this.refusedKey = credentialsKey(this.config, this.salt);
      await this.saveAccess();
      this.logger.warn('The Smile refused the Smile ID (HTTP 401): not retried until changed');
      await this.setStatus(false, T.status.authRefused);
      return;
    }
    let delay;
    if (err?.status === 429) {
      delay = clamp(
        err.retryAfterMs ?? INTERVALS.BUSY_MIN_MS,
        INTERVALS.BUSY_MIN_MS,
        INTERVALS.BUSY_MAX_MS,
      );
      this.pausedUntil = this.now() + delay;
      await this.saveAccess();
    } else {
      // Never faster than the reading itself.
      delay = Math.max(this.retryDelay, this.interval());
      this.retryDelay = Math.min(this.retryDelay * 2, INTERVALS.RETRY_MAX_MS);
    }
    this.nextReadAt = this.now() + delay;
    if (wasOnline || delay <= INTERVALS.RETRY_MIN_MS) {
      // Our own message: a code or an HTTP status, never the text of the answer.
      this.logger.warn(
        `The Smile fails: ${err?.code ?? 'error'}${err?.status ? ` ${err.status}` : ''}`,
      );
    }
    await this.setStatus(false, this.errorMessage(err, delay));
    this.scheduleRead(delay, generation);
  }

  errorMessage(err, delay) {
    let message;
    if (err?.status === 429) message = T.status.busy(delay);
    else if (err?.status === 404 || err?.code === CODES.BAD_ANSWER || err?.code === CODES.TOO_LARGE)
      message = T.status.notSmile(delay);
    else message = T.status.unreachable(err, delay);
    // The index held back is shown while waiting too: the user must see it.
    const held = this.currentGuard()?.held;
    return held ? join(message, T.notes.held(held)) : message;
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = null;
      this.logger.warn(`Connection status not sent: ${err.message}`);
    });
  }

  // --- Reading -----------------------------------------------------------------------

  /**
   * Read the Smile and publish. Throws on a failure of the request; resolves
   * 'unsupported' for a Smile this integration does not read, true otherwise.
   */
  async refresh({ publish }) {
    const client = this.client;
    if (!client) return true;
    const model = await client.domainObjects();
    if (client !== this.client) return true;
    this.retryDelay = INTERVALS.RETRY_MIN_MS;
    if (!model.supported) {
      this.online = false;
      this.model = null;
      if (this.unsupported !== model.reason) {
        this.logger.warn(`Unsupported Smile (${model.reason})`);
      }
      this.unsupported = model.reason;
      await this.setStatus(false, T.status.unsupported(model.reason));
      return 'unsupported';
    }
    this.unsupported = null;
    this.model = model;
    this.online = true;
    const devices = this.discoveredDevices();
    const key = JSON.stringify(devices);
    if (publish || key !== this.discoveredKey) await this.publishDiscovered(devices);
    await this.publishStates();
    await this.publishTransports();
    await this.setStatus(true, this.okMessage());
    return true;
  }

  discoveredDevices() {
    return this.model ? buildDevices(this.gladys, this.model, this.config.language) : [];
  }

  okMessage() {
    const model = this.model;
    const notes = [];
    const meterCreated = this.createdDevice(KINDS.METER, model.gatewayId);
    if (model.meter && meterCreated) {
      if (!model.meter.connected) notes.push(T.notes.meterNotConnected);
      else if (this.isStale()) notes.push(T.notes.stale);
      if (this.hasIndex(meterCreated) && this.indexUndefined && model.meter.connected) {
        notes.push(T.notes.noIndex);
      }
      if (this.guard?.held) notes.push(T.notes.held(this.guard.held));
    }
    if (model.heater && !model.heater.available) notes.push(T.notes.heaterUnavailable);
    const devices = this.discoveredDevices();
    const ids = new Set(devices.map((d) => d.external_id));
    const created = (this.gladys.devices ?? []).filter((d) => ids.has(d.external_id)).length;
    return T.status.ok({
      smile: model.smile,
      firmware: model.firmware,
      devices: devices.length,
      created,
      notes,
    });
  }

  /** Never throws: a refusal of Gladys is not a failure of the Smile. */
  async publishDiscovered(devices = this.discoveredDevices()) {
    this.discoveredKey = JSON.stringify(devices);
    await this.gladys.publishDiscoveredDevices(devices).catch((err) => {
      this.discoveredKey = null;
      this.logger.warn(`Discovery not published: ${err.message}`);
    });
  }

  /** Discovery (scan button): read again when connected, else what is known. */
  async publishDiscovery() {
    if (this.online && this.client && !this.blocked && !this.paused()) {
      const generation = this.generation;
      const applied = await this.refresh({ publish: true }).catch(async (err) => {
        if (isAuthRefused(err) || err?.status === 429) await this.failed(err, generation);
        return false;
      });
      if (applied) return;
    }
    await this.publishDiscovered();
  }

  /** The created device of a kind and Plugwise id, undefined until the user creates it. */
  createdDevice(kind, id) {
    const externalId = idsOf(this.gladys, kind, id).device;
    return (this.gladys.devices ?? []).find((d) => d.external_id === externalId);
  }

  hasIndex(created) {
    const indexId = idsOf(this.gladys, KINDS.METER, this.model.gatewayId).feature(
      MF.CONSUMPTION_INDEX,
    );
    return (created?.features ?? []).some((f) => f.external_id === indexId);
  }

  /** The power is stale when its log date has not changed for a while (monotonic clock). */
  followFreshness(stamp) {
    const mono = this.monotonic();
    if (stamp === undefined || stamp !== this.readingStamp) {
      this.readingStamp = stamp;
      this.freshAt = mono;
    }
  }

  isStale() {
    return (
      this.readingStamp !== undefined && this.monotonic() - this.freshAt >= READING_STALE_AFTER
    );
  }

  /** The states of the created devices, within the per-minute budget. Never throws. */
  async publishStates() {
    const model = this.model;
    if (!model) return;
    const states = [];
    const meterCreated = model.meter ? this.createdDevice(KINDS.METER, model.gatewayId) : undefined;
    if (meterCreated && model.meter.connected) {
      this.followFreshness(model.meter.powerDate);
      states.push(...meterLiveStates(this.gladys, model, { stale: this.isStale() }));
      const mono = this.monotonic();
      if (this.lastIndexAt !== undefined && mono < this.lastIndexAt) this.lastIndexAt = undefined;
      if (this.lastIndexAt === undefined || mono - this.lastIndexAt >= INTERVALS.INDEX_MS) {
        this.lastIndexAt = mono;
        const index = await this.guardedIndex(meterCreated);
        if (this.model !== model) return;
        states.push(...meterIndexStates(this.gladys, model, index));
      }
    }
    states.push(...climateStates(this.gladys, model));
    // Only the features the created devices have (fixed at their creation).
    const features = new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
    let list = states.filter((s) => features.has(s.device_feature_external_id));
    if (list.length === 0) return;
    const remaining = this.budget.remaining();
    if (list.length > remaining) {
      // In turn: the next cut starts where this one stopped, so no feature
      // is held back for ever (the SDK skips the unchanged ones anyway).
      this.logger.debug(`${list.length - remaining} state(s) held back (state budget)`);
      const start = this.budgetCursor % list.length;
      list = [...list.slice(start), ...list.slice(0, start)].slice(0, remaining);
      this.budgetCursor = start + remaining;
    }
    if (list.length === 0) return;
    try {
      const result = await this.gladys.publishChangedStates(list, {
        heartbeat: INTERVALS.HEARTBEAT_MS,
      });
      this.budget.record(result?.count ?? list.length);
    } catch (err) {
      this.logger.warn(`States not published: ${err.message}`);
    }
  }

  /**
   * The consumption index to publish now (src/guard.js): peak + off-peak,
   * both tariffs checked, then the sum against the last accepted value.
   * While a value is held, the last accepted one is sent again (no delta for
   * the core). Undefined: nothing this time.
   */
  async guardedIndex(created) {
    if (!this.hasIndex(created)) return undefined;
    const indexId = idsOf(this.gladys, KINDS.METER, this.model.gatewayId).feature(
      MF.CONSUMPTION_INDEX,
    );
    const guard = this.guardOf(created, indexId);
    const { peak, offpeak } = this.model.meter.consumption;
    const sum = indexOfTariffs(offpeak, peak, this.tariffRef);
    const total = sum === undefined ? undefined : round(sum, 3);
    this.indexUndefined = total === undefined;
    const plausible = total !== undefined && guard.accept(total, this.now());
    if (plausible) this.tariffRef = { low: offpeak, high: peak };
    await this.saveGuard(indexId);
    if (total !== undefined && !plausible) {
      this.logger.warn(
        `Consumption index ${guard.held?.direction === 'down' ? 'drop' : 'jump'} held back: the "Accept the held index" button takes it`,
      );
    }
    if (plausible) return total;
    return guard.held ? guard.last?.value : undefined;
  }

  /** The guard of the created meter, built from Gladys and /data when needed. */
  guardOf(created, indexId) {
    if (!this.guard) {
      const saved = this.store.load()[indexId];
      this.guard = new IndexGuard(lastValueOf(created, indexId), saved, this.now());
      this.tariffRef = validTariffs(saved?.tariffs);
    }
    return this.guard;
  }

  currentGuard() {
    if (this.guard) return this.guard;
    const gatewayId = this.model?.gatewayId;
    const created = gatewayId ? this.createdDevice(KINDS.METER, gatewayId) : undefined;
    if (!created || !this.hasIndex(created)) return undefined;
    return this.guardOf(
      created,
      idsOf(this.gladys, KINDS.METER, gatewayId).feature(MF.CONSUMPTION_INDEX),
    );
  }

  /** Keeps the guard in /data when its reference, its value held or the tariffs changed. */
  async saveGuard(indexId) {
    const state = { ...this.guard.state(), tariffs: this.tariffRef ?? null };
    const key = JSON.stringify([
      indexId,
      state.last,
      state.held && {
        direction: state.held.direction,
        from: state.held.from,
        threshold: state.held.threshold,
      },
      state.tariffs,
    ]);
    if (key === this.savedGuard) return;
    try {
      await this.store.save({ ...this.store.load(), [indexId]: state });
      this.savedGuard = key;
    } catch (err) {
      this.logger.warn(`Saving the index state in /data failed (${err?.code ?? 'error'})`);
    }
  }

  /** The badge of every created device: local while the Smile answers and shows it. */
  async publishTransports() {
    const model = this.online ? this.model : null;
    const shown = new Set(
      model
        ? [
            model.meter && model.meter.connected
              ? idsOf(this.gladys, KINDS.METER, model.gatewayId).device
              : null,
            model.gateway ? idsOf(this.gladys, KINDS.GATEWAY, model.gatewayId).device : null,
            model.heater?.available
              ? idsOf(this.gladys, KINDS.HEATER, model.heater.id).device
              : null,
            ...model.zones.map((z) => idsOf(this.gladys, KINDS.ZONE, z.id).device),
            ...model.plugs.map((p) => idsOf(this.gladys, KINDS.PLUG, p.id).device),
          ].filter(Boolean)
        : [],
    );
    const entries = [];
    for (const device of this.gladys.devices ?? []) {
      const parsed = parseExternalId(this.gladys, device?.external_id);
      if (!parsed || parsed.feature !== null) continue;
      entries.push({
        external_id: device.external_id,
        transport: shown.has(device.external_id) ? 'local' : 'unreachable',
      });
    }
    const changed = entries.filter((e) => this.transports.get(e.external_id) !== e.transport);
    for (let start = 0; start < changed.length; start += TRANSPORTS_PER_CALL) {
      const batch = changed.slice(start, start + TRANSPORTS_PER_CALL);
      for (const entry of batch) this.transports.set(entry.external_id, entry.transport);
      await this.gladys.publishTransports(batch).catch((err) => {
        for (const entry of batch) this.transports.delete(entry.external_id);
        this.logger.debug(`Transports not published: ${err.message}`);
      });
    }
  }

  // --- Devices created / updated / deleted in Gladys ---------------------------------

  async deviceCreated(device) {
    const parsed = parseExternalId(this.gladys, device?.external_id);
    if (!parsed || parsed.feature !== null) return;
    if (parsed.kind === KINDS.METER) {
      // A new meter device: no reference of the index yet (nor a value held
      // in /data for a deleted device of the same id).
      const indexId = idsOf(this.gladys, KINDS.METER, parsed.id).feature(MF.CONSUMPTION_INDEX);
      const kept = this.store.load();
      if (indexId in kept) {
        delete kept[indexId];
        await this.store
          .save(kept)
          .catch((err) =>
            this.logger.warn(`Clearing the index state failed (${err?.code ?? 'error'})`),
          );
      }
      this.guard = undefined;
      this.savedGuard = undefined;
      this.tariffRef = undefined;
      this.lastIndexAt = undefined;
    }
    if (!this.online) return;
    await this.publishStates();
    await this.publishTransports();
    if (this.model) await this.setStatus(true, this.okMessage());
  }

  async deviceUpdated(device) {
    this.transports.delete(device?.external_id);
    if (!parseExternalId(this.gladys, device?.external_id) || !this.online) return;
    // New features (Update in Discovery): their values right away.
    this.lastIndexAt = undefined;
    this.gladys.forgetPublishedStates?.();
    await this.publishStates();
    await this.publishTransports();
  }

  deviceDeleted(device) {
    this.transports.delete(device?.external_id);
  }

  // --- Commands ----------------------------------------------------------------------
  //
  // The setpoint, the preset and the Adam modes need `allow_climate`, the
  // relay of a plug `allow_plugs`; both are off by default and checked when
  // the command arrives AND just before it is sent. The value is checked
  // strictly (null, '' and true are not numbers). The commands run one after
  // the other (one Smile), use the client of the moment they arrived (a new
  // configuration in between refuses them), and read the Smile just before
  // acting: the decision is taken on that fresh read only, never on memory;
  // a device gone, a value missing, a read that fails, and nothing is sent;
  // the value already there, and nothing is sent either. Gladys waits 5 s:
  // past 3.5 s after the command arrived, nothing is sent any more; once
  // sent, Gladys gets its answer at most 4.3 s after the command, and a
  // command that may have left is never told "not sent".

  async setValue(device, feature, value) {
    const received = this.now();
    const parsed = parseExternalId(this.gladys, feature?.external_id);
    if (!parsed?.feature) throw new Error(T.errors.unknownDevice);
    const command = this.validate(parsed, value);
    if (command.permission === 'plugs' ? !this.config.allowPlugs : !this.config.allowClimate) {
      throw new Error(
        command.permission === 'plugs' ? T.errors.plugsDisabled : T.errors.climateDisabled,
      );
    }
    const client = this.client;
    if (!client || this.blocked) throw new Error(T.errors.notConnected);
    if (this.paused()) throw new Error(T.errors.busy);
    const generation = this.generation;
    const run = this.commands.then(() =>
      this.command(received, { client, generation, parsed, command }),
    );
    this.commands = run.catch(() => {});
    return run;
  }

  /** The command a feature and a value ask for, checked before anything is read. */
  validate(parsed, value) {
    const key = `${parsed.kind}/${parsed.feature}`;
    const text = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null);
    switch (key) {
      case `${KINDS.ZONE}/${ZF.TARGET}`: {
        const raw =
          typeof value === 'number'
            ? value
            : typeof value === 'string' && value.trim() !== ''
              ? Number(value)
              : NaN;
        if (!Number.isFinite(raw) || raw < SETPOINT.MIN || raw > SETPOINT.MAX) {
          throw new Error(T.errors.invalidSetpoint(SETPOINT.MIN, SETPOINT.MAX));
        }
        return { action: 'setpoint', value: raw, permission: 'climate' };
      }
      case `${KINDS.ZONE}/${ZF.PRESET}`: {
        if (!text(value)) throw new Error(T.errors.invalidPreset);
        return { action: 'preset', value, permission: 'climate' };
      }
      case `${KINDS.GATEWAY}/${GF.REGULATION_MODE}`: {
        if (!text(value)) throw new Error(T.errors.invalidMode);
        if (!COMMANDABLE_REGULATION_MODES.includes(value)) {
          throw new Error(T.errors.unsafeRegulationMode);
        }
        return { action: 'regulation', value, permission: 'climate' };
      }
      case `${KINDS.GATEWAY}/${GF.GATEWAY_MODE}`: {
        if (!GATEWAY_MODES.includes(value)) throw new Error(T.errors.invalidMode);
        return { action: 'gatewayMode', value, permission: 'climate' };
      }
      case `${KINDS.PLUG}/${PF.STATE}`: {
        if (value !== 0 && value !== 1 && value !== '0' && value !== '1') {
          throw new Error(T.errors.invalidSwitch);
        }
        return { action: 'relay', value: Number(value) === 1, permission: 'plugs' };
      }
      default:
        throw new Error(T.errors.unknownDevice);
    }
  }

  /** The client, the configuration and the permission are still those of the command. */
  stillValid({ client, generation, command }) {
    if (client !== this.client || generation !== this.generation || this.blocked) {
      throw new Error(T.errors.configChanged);
    }
    if (command.permission === 'plugs' ? !this.config.allowPlugs : !this.config.allowClimate) {
      throw new Error(
        command.permission === 'plugs' ? T.errors.plugsDisabled : T.errors.climateDisabled,
      );
    }
    if (this.paused()) throw new Error(T.errors.busy);
  }

  /** A failure of the Smile met by a command: a 429 or a 401 applies to every path. */
  async shared(err, generation) {
    if ((err?.status === 429 || isAuthRefused(err)) && generation === this.generation) {
      await this.failed(err, generation);
    }
  }

  async command(received, { client, generation, parsed, command }) {
    this.stillValid({ client, generation, command });
    const deadline = received + COMMAND_BUDGET_MS;
    if (deadline - this.now() < COMMAND_MIN_READ_MS) throw new Error(T.errors.tooSlow);
    let model;
    try {
      model = await client.domainObjects({ deadline: deadline - COMMAND_MIN_SEND_MS });
    } catch (err) {
      await this.shared(err, generation);
      throw new Error(T.errors.unknownState(err), { cause: err });
    }
    if (!model.supported) throw new Error(T.errors.unknownState({ code: CODES.BAD_ANSWER }));
    if (client === this.client && this.online) {
      // What the command just read is the newest state: shown without waiting
      // (Gladys must get its answer within 5 s).
      this.model = model;
      void this.publishStates();
    }
    const plan = this.plan(parsed, command, model);
    if (plan.already) return;
    if (deadline - this.now() < COMMAND_MIN_SEND_MS) throw new Error(T.errors.tooSlow);
    // The last check before acting: the user may have changed things meanwhile.
    this.stillValid({ client, generation, command });
    await this.send({ client, generation, plan, received, deadline });
  }

  /** What to send, decided on the fresh read only: { already } or { label, send(options) }. */
  plan(parsed, command, model) {
    const { kind, id } = parsed;
    switch (command.action) {
      case 'setpoint': {
        const zone = model.zones.find((z) => z.id === id);
        if (!zone) throw new Error(T.errors.gone);
        if (zone.setpoint === undefined || !zone.functionalityId) {
          throw new Error(T.errors.noSetpoint);
        }
        const { min, max } = setpointBounds(zone);
        const temperature = Math.round(command.value * 10) / 10;
        if (command.value < min || command.value > max || temperature < min || temperature > max) {
          throw new Error(T.errors.invalidSetpoint(min, max));
        }
        if (Math.abs(zone.setpoint - temperature) < SETPOINT.STEP / 2) return { already: true };
        return {
          label: `Setpoint of zone ${zone.id}`,
          request: (client, options) =>
            client.setSetpoint(zone.id, zone.functionalityId, temperature, options),
        };
      }
      case 'preset': {
        const zone = model.zones.find((z) => z.id === id);
        if (!zone) throw new Error(T.errors.gone);
        if (!zone.presets.includes(command.value)) throw new Error(T.errors.invalidPreset);
        if (zone.preset === command.value) return { already: true };
        return {
          label: `Preset of zone ${zone.id}`,
          request: (client, options) => client.setPreset(zone, command.value, options),
        };
      }
      case 'regulation': {
        const gateway = model.gateway;
        if (model.gatewayId !== id || model.smile !== 'adam' || !gateway)
          throw new Error(T.errors.gone);
        if (!gateway.regulationModes?.includes(command.value))
          throw new Error(T.errors.invalidMode);
        if (gateway.regulationMode === command.value) return { already: true };
        return {
          label: 'Regulation mode',
          request: (client, options) => client.setRegulationMode(command.value, options),
        };
      }
      case 'gatewayMode': {
        const gateway = model.gateway;
        if (model.gatewayId !== id || model.smile !== 'adam' || !gateway)
          throw new Error(T.errors.gone);
        if (!gateway.gatewayModes?.includes(command.value)) throw new Error(T.errors.invalidMode);
        if (gateway.gatewayMode === command.value) return { already: true };
        return {
          label: 'Gateway mode',
          request: (client, options) =>
            client.setGatewayMode(model.gatewayId, command.value, {
              gatewayTime: model.gatewayTime,
              ...options,
            }),
        };
      }
      case 'relay': {
        const plug = kind === KINDS.PLUG ? model.plugs.find((p) => p.id === id) : undefined;
        if (!plug) throw new Error(T.errors.gone);
        // The lock of Plugwise, then the type: both read now, never from memory.
        if (plug.lock !== false) throw new Error(T.errors.lockedPlug);
        if (!SWITCHABLE_PLUG_TYPES.includes(plug.type))
          throw new Error(T.errors.unsafePlug(plug.type));
        if (plug.relay === undefined) throw new Error(T.errors.plugUnknownState);
        if (plug.relay === command.value) return { already: true };
        return {
          label: `Relay of plug ${plug.id}`,
          request: (client, options) => client.setRelay(plug.id, command.value, options),
        };
      }
      default:
        throw new Error(T.errors.unknownDevice);
    }
  }

  /**
   * Send, then answer Gladys on the Smile's answer or at COMMAND_ACK_MS,
   * whichever first. Whatever the outcome once it may have left, the Smile
   * is read again soon to show what it really did.
   */
  async send({ client, generation, plan, received, deadline }) {
    let sent = false;
    const request = plan.request(client, {
      deadline,
      onSent: () => {
        sent = true;
      },
    });
    let handle;
    const ack = new Promise((resolve) => {
      handle = this.timers.setTimeout(resolve, Math.max(0, received + COMMAND_ACK_MS - this.now()));
    });
    const outcome = await Promise.race([
      request.then(
        () => ({ done: true }),
        (err) => ({ err }),
      ),
      ack.then(() => ({ pending: true })),
    ]);
    this.timers.clearTimeout(handle);
    if (sent && generation === this.generation) this.readSoon(generation);
    if (outcome.done) {
      this.logger.info(`${plan.label} sent`);
      return;
    }
    if (outcome.pending) {
      // Sent, the Smile still at work: Gladys is told exactly that.
      request.catch(async (err) => {
        this.logger.warn(`${plan.label} not confirmed: ${err?.code ?? 'error'}`);
        // A late 401 / 429 still applies to every path.
        await this.shared(err, generation);
      });
      this.logger.info(`${plan.label} sent, the Smile has not answered yet`);
      if (!sent) throw new Error(T.errors.notSent({ code: CODES.TIMEOUT }));
      throw new Error(T.errors.unconfirmed({ code: CODES.TIMEOUT }));
    }
    const { err } = outcome;
    await this.shared(err, generation);
    if (err?.notSent || !sent) throw new Error(T.errors.notSent(err), { cause: err });
    // An HTTP 4xx: the Smile answered and refused. Anything else may have been applied.
    if (err?.code === CODES.HTTP && err.status >= 400 && err.status < 500) {
      throw new Error(T.errors.refused(err), { cause: err });
    }
    throw new Error(T.errors.unconfirmed(err), { cause: err });
  }

  /** Read the Smile again soon (after a command): the reading loop restarts from there. */
  readSoon(generation) {
    if (!this.client || this.blocked || this.paused()) return;
    this.halt();
    this.scheduleRead(READ_AFTER_COMMAND_MS, generation);
  }

  // --- Configuration screen buttons --------------------------------------------------

  /** Resolves `promise`, or rejects with `message` after `ms`. */
  within(promise, ms, message) {
    let handle;
    const limit = new Promise((_, reject) => {
      handle = this.timers.setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, limit]).finally(() => this.timers.clearTimeout(handle));
  }

  /** Reconnects (a refused ID included: the user asked), then reports, within 25 s. */
  async testConnection() {
    // The configuration as saved now (the one in memory if Gladys cannot give it).
    const raw = await this.gladys.getConfig().catch(() => this.rawConfig);
    try {
      await this.within(this.start(raw, { force: true }), INTERVALS.TEST_MS, T.errors.testTooLong);
    } catch {
      return T.test.slow;
    }
    if (!this.online || !this.model) {
      const message = this.lastStatus ? JSON.parse(this.lastStatus)[1] : null;
      return message ?? { en: T.errors.notConnected, fr: 'Le Smile n’est pas connecté' };
    }
    return T.test.ok({
      smile: this.model.smile,
      firmware: this.model.firmware,
      zones: this.model.zones.length,
      plugs: this.model.plugs.length,
      meter: Boolean(this.model.meter),
    });
  }

  /**
   * The "Accept the held index" button: takes the value held as shown now
   * (plus what the home may draw until the next read, src/guard.js), never
   * anything else. Answers with what will be counted.
   */
  async acceptHeldIndex() {
    const accepted = this.currentGuard()?.acceptHeld();
    if (!accepted) return T.accept.nothing;
    this.logger.info(
      `Consumption index ${accepted.direction === 'down' ? 'drop' : 'jump'} accepted by the user`,
    );
    // Published at the next read.
    this.lastIndexAt = undefined;
    return accepted.direction === 'down' ? T.accept.down(accepted) : T.accept.up(accepted);
  }
}

function join(...parts) {
  return {
    en: parts.map((p) => p.en).join(' '),
    fr: parts.map((p) => p.fr).join(' '),
  };
}
