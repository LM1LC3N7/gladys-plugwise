// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// -----------------------------------------------------------------------------

import { randomBytes, scryptSync } from 'node:crypto';

export const LANGUAGES = Object.freeze(['fr', 'en']);

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = Object.freeze({
  language: 'fr',
  allow_climate: false,
  allow_plugs: false,
});

/** The Smile ID: the 8 letters printed on the back of the Smile (python-plugwise: the password). */
const SMILE_ID = /^[A-Za-z0-9]{8}$/;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const bool = (value, fallback) => {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return fallback;
};

/**
 * The address of the Smile: `192.168.1.20`, `smile.local`, `host:port` or
 * `http://host[:port]`. The local API speaks plain HTTP only: https is
 * refused (said to the user rather than failing in silence). Credentials, a
 * path, a query and a fragment are refused (an address ends up in logs).
 *   -> { origin, hostname, port } or { error: 'empty' | 'invalid' | 'credentials' | 'https' }
 */
export function parseHost(value) {
  const raw = text(value);
  if (!raw) return { error: 'empty' };
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1]?.toLowerCase();
  if (scheme === 'https') return { error: 'https' };
  if (scheme && scheme !== 'http') return { error: 'invalid' };
  let url;
  try {
    url = new URL(scheme ? raw : `http://${raw}`);
  } catch {
    return { error: 'invalid' };
  }
  if (url.username || url.password) return { error: 'credentials' };
  if (url.search || url.hash || !url.hostname || url.pathname.replace(/\/+$/, '') !== '') {
    return { error: 'invalid' };
  }
  const port = url.port ? Number(url.port) : 80;
  const hostname = url.hostname.toLowerCase();
  return { origin: `http://${hostname}:${port}`, hostname, port };
}

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const host = parseHost(raw.host);
  const smileId = text(raw.smile_id);
  const language = LANGUAGES.includes(String(raw.language))
    ? String(raw.language)
    : DEFAULTS.language;
  return {
    smile: host.error ? null : host,
    hostError: host.error ?? null,
    smileId,
    smileIdError: smileId === '' ? 'empty' : SMILE_ID.test(smileId) ? null : 'invalid',
    language,
    allowClimate: bool(raw.allow_climate, DEFAULTS.allow_climate),
    allowPlugs: bool(raw.allow_plugs, DEFAULTS.allow_plugs),
  };
}

/**
 * What a refusal of the Smile ID is about: a salted scrypt hash of the
 * address and the ID, so that it can be kept in /data without the ID itself
 * (an 8-character ID behind a plain fast hash could be found back by brute
 * force; scrypt with a random salt makes that impractical).
 */
export const credentialsKey = (config, salt) =>
  scryptSync(JSON.stringify([config.smile?.origin ?? null, config.smileId]), salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
  }).toString('hex');

/** A new random salt for credentialsKey. */
export const newSalt = () => randomBytes(16).toString('hex');
