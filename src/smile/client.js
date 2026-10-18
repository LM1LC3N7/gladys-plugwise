// -----------------------------------------------------------------------------
// SmileClient: the local XML API of a Plugwise Smile (P1, Anna, Adam), as
// python-plugwise speaks it (smilecomm.py, smile.py): HTTP basic
// authentication `smile:<Smile ID>`, one read of /core/domain_objects for
// everything, PUT requests with a small XML body for the commands (answered
// 200 or 202, empty).
//
// The Smile ID never appears in a log or an error: errors carry a code and an
// HTTP status only.
// -----------------------------------------------------------------------------

import { MAX_BYTES, PATHS, TIMEOUTS, USERNAME, GATEWAY_MODE_END } from '../constants.js';
import { CODES, SmileError } from './errors.js';
import { httpRequest } from './http.js';
import { parseDomainObjects } from './model.js';
import { XmlError, escapeXml, parseXml } from './xml.js';

/** Retry-After in ms (seconds or an HTTP date), or undefined. */
export function retryAfterMs(value, now) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  if (/^\d{1,9}$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** A setpoint as the Smile reads it: "20.5". */
export const formatSetpoint = (value) => String(Math.round(value * 10) / 10);

export class SmileClient {
  /**
   * @param {object} options
   * @param {string} options.origin `http://host:port`
   * @param {string} options.smileId the 8 characters printed on the Smile
   * @param {Function} [options.request] the HTTP transport (tests inject a fake Smile)
   * @param {() => number} [options.now]
   */
  constructor({ origin, smileId, request = httpRequest, now = Date.now }) {
    this.origin = origin;
    this.authorization = `Basic ${Buffer.from(`${USERNAME}:${smileId}`, 'utf8').toString('base64')}`;
    this.request = request;
    this.now = now;
    this.closed = false;
  }

  close() {
    this.closed = true;
  }

  /**
   * One request. `deadline` (epoch ms): the exchange must end by then; for a
   * PUT, the connection must also be up by then, else nothing is sent.
   */
  async call(path, { method = 'GET', body, deadline, onSent } = {}) {
    if (this.closed) throw new SmileError(CODES.CLOSED, 'Client closed', { notSent: true });
    const base = method === 'GET' ? TIMEOUTS.READ : TIMEOUTS.COMMAND;
    const left = deadline === undefined ? base : deadline - this.now();
    if (left <= 0) throw new SmileError(CODES.NO_TIME, 'No time left: not sent', { notSent: true });
    const response = await this.request(`${this.origin}${path}`, {
      method,
      body,
      headers: { authorization: this.authorization },
      // A read must end by the deadline; a command, once sent, may take its time
      // (the app answers Gladys at COMMAND_ACK_MS whatever happens).
      timeout: method === 'GET' ? Math.min(base, left) : base,
      sendWithin: method === 'GET' || deadline === undefined ? undefined : left,
      maxBytes: MAX_BYTES,
      onSent,
    });
    if (this.closed) throw new SmileError(CODES.CLOSED, 'Client closed');
    if (response.status === 200 || response.status === 202) return response;
    throw new SmileError(CODES.HTTP, `HTTP ${response.status}`, {
      status: response.status,
      retryAfterMs:
        response.status === 429
          ? retryAfterMs(response.headers?.['retry-after'], this.now())
          : undefined,
    });
  }

  /** Read everything the Smile shows (src/smile/model.js). */
  async domainObjects({ deadline } = {}) {
    const response = await this.call(PATHS.DOMAIN_OBJECTS, { deadline });
    let root;
    try {
      root = parseXml(response.body);
    } catch (err) {
      if (err instanceof XmlError) {
        throw new SmileError(CODES.BAD_ANSWER, `Not the XML of a Smile (${err.message})`);
      }
      throw err;
    }
    return parseDomainObjects(root, { now: this.now() });
  }

  put(path, body, options) {
    return this.call(path, { method: 'PUT', body, ...options });
  }

  /** The setpoint of a zone (python-plugwise set_temperature). */
  setSetpoint(zoneId, functionalityId, value, options) {
    return this.put(
      `${PATHS.LOCATIONS};id=${zoneId}/thermostat;id=${functionalityId}`,
      `<thermostat_functionality><setpoint>${formatSetpoint(value)}</setpoint></thermostat_functionality>`,
      options,
    );
  }

  /** The preset of a zone (python-plugwise set_preset): the location sent back with it. */
  setPreset(zone, preset, options) {
    return this.put(
      `${PATHS.LOCATIONS};id=${zone.id}`,
      `<locations><location id="${zone.id}"><name>${escapeXml(zone.name)}</name>` +
        `<type>${escapeXml(zone.type ?? '')}</type><preset>${escapeXml(preset)}</preset>` +
        '</location></locations>',
      options,
    );
  }

  /**
   * The Adam gateway mode (python-plugwise set_gateway_mode): away from the
   * time of the Smile, vacation from yesterday 23:00 UTC, both until 2037.
   */
  setGatewayMode(gatewayId, mode, { gatewayTime, ...options } = {}) {
    let valid = '';
    if (mode === 'away') {
      const at = Date.parse(gatewayTime ?? '');
      const from = new Date(Number.isFinite(at) ? at : this.now()).toISOString();
      valid = `<valid_from>${from}</valid_from><valid_to>${GATEWAY_MODE_END}</valid_to>`;
    } else if (mode === 'vacation') {
      const yesterday = new Date(this.now() - 86_400_000).toISOString().slice(0, 10);
      valid = `<valid_from>${yesterday}T23:00:00.000Z</valid_from><valid_to>${GATEWAY_MODE_END}</valid_to>`;
    }
    return this.put(
      `${PATHS.APPLIANCES};id=${gatewayId}/gateway_mode_control`,
      `<gateway_mode_control_functionality><mode>${escapeXml(mode)}</mode>${valid}</gateway_mode_control_functionality>`,
      options,
    );
  }

  /** The Adam regulation mode (python-plugwise set_regulation_mode), never a bleeding cycle. */
  setRegulationMode(mode, options) {
    return this.put(
      `${PATHS.APPLIANCES};type=gateway/regulation_mode_control`,
      `<regulation_mode_control_functionality><mode>${escapeXml(mode)}</mode></regulation_mode_control_functionality>`,
      options,
    );
  }

  /** The relay of a plug (python-plugwise set_switch_state, model "relay"). */
  setRelay(plugId, on, options) {
    return this.put(
      `${PATHS.APPLIANCES};id=${plugId}/relay`,
      `<relay_functionality><state>${on ? 'on' : 'off'}</state></relay_functionality>`,
      options,
    );
  }
}
