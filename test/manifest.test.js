// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEVICE_FEATURE_UNITS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULTS, LANGUAGES } from '../src/config.js';
import { ACTIONS, SWITCHABLE_PLUG_TYPES } from '../src/constants.js';
import { buildDevices } from '../src/devices.js';
import { parseDomainObjects } from '../src/smile/model.js';
import { parseXml } from '../src/smile/xml.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const keys = (list) => (list ?? []).map((item) => item.key);
const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));

test('the store basics; version 0.1.0 set by hand everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.gladys_version, '>=5.2.0');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-plugwise:${manifest.version}`);
  assert.equal(pkg.name, 'gladys-plugwise');
  assert.equal(lock.name, 'gladys-plugwise');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['climate', 'energy']);
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(fields.intro.description.en, /Unofficial integration, not affiliated with Plugwise/);
  assert.match(fields.intro.description.fr, /non officielle, sans lien avec Plugwise/);
  assert.match(fields.intro.description.en, /Never tested with a real Smile/);
  assert.match(fields.intro.description.fr, /Jamais testée avec un vrai Smile/);
  assert.match(read('docs/en.md'), /never been tested with a real Smile/);
  assert.match(read('docs/fr.md'), /jamais été testée avec un vrai Smile/);
  assert.match(read('README.md'), /Never tested with a\s+real Smile/);
});

test('the license and the notices ship in the image; no person named in LICENSE', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/, 'the standard text');
  assert.match(read('THIRD_PARTY_NOTICES.md'), /python-plugwise[\s\S]*MIT License/);
  assert.match(dockerfile, /COPY[^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('the configuration matches the code; every command off by default', () => {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.equal(fields[key].default, value, key);
  }
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    LANGUAGES,
  );
  assert.deepEqual(keys(manifest.config_schema), [
    'intro',
    'host',
    'smile_id',
    'options_section',
    'allow_climate',
    'allow_plugs',
    'language',
  ]);
  assert.equal(fields.smile_id.type, 'secret');
  assert.match(fields.smile_id.description.en, /never shown again, sent only to the Smile/);
  assert.match(fields.smile_id.description.fr, /jamais réaffiché, envoyé seulement au Smile/);
  assert.match(fields.smile_id.description.en, /in clear/, 'the risk of http is said');
  assert.doesNotMatch(
    JSON.stringify(manifest) + read('docs/fr.md') + read('docs/en.md') + read('README.md'),
    /chiffré|encrypted/i,
    'a secret is not encrypted',
  );
  for (const key of ['allow_climate', 'allow_plugs']) {
    assert.equal(fields[key].type, 'boolean', key);
    assert.equal(fields[key].default, false, key);
  }
  assert.match(fields.options_section.description.en, /hot water is never commanded/);
});

test('sections store nothing', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined, section.key);
    assert.equal(section.default, undefined, section.key);
    assert.ok(!(section.key in DEFAULTS), section.key);
    for (const link of section.links ?? []) assert.match(link.url, /^https:\/\//);
  }
});

test('the keys of the manifest are the keys of the code, all registered', () => {
  assert.deepEqual(keys(manifest.actions).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), name);
  }
  assert.ok(manifest.actions.every((a) => a.timeout_seconds >= 5 && a.timeout_seconds <= 120));
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.widgets, undefined);
  for (const handler of ['onScanRequest(', 'onSetValue(', 'onConfigUpdated(', 'onDeviceCreated(']) {
    assert.ok(handlers.includes(handler), handler);
  }
});

test('units: only those the core lists for the category (server/utils/constants.js)', () => {
  // DEVICE_FEATURE_UNITS_BY_CATEGORY of the core, for the categories used here.
  const allowed = {
    'temperature-sensor': ['celsius', 'fahrenheit', 'kelvin'],
    'pressure-sensor': ['pascal', 'hPa', 'kPa', 'bar', 'psi', 'milli-bar'],
    thermostat: ['celsius', 'fahrenheit'],
    'energy-sensor': [
      'milliampere',
      'ampere',
      'millivolt',
      'volt',
      'watt',
      'kilowatt',
      'watt-hour',
      'kilowatt-hour',
      'megawatt-hour',
      'kilovolt-ampere',
      'volt-ampere',
      'volt-ampere-reactive',
      'euro',
      'dollar',
    ],
    'volume-sensor': ['liter', 'milliliter', 'cubicmeter'],
    switch: ['ampere', 'millivolt', 'volt', 'watt', 'kilowatt', 'watt-hour', 'kilowatt-hour'],
  };
  const gladys = createFakeGladys({ selector: 'plugwise' });
  const features = [];
  for (const name of ['adam_plus_anna_new', 'anna_p1', 'p1v4_442_triple']) {
    const xml = read(`test/fixtures/${name}.xml`);
    const model = parseDomainObjects(parseXml(xml));
    for (const device of buildDevices(gladys, model, 'fr', [])) features.push(...device.features);
  }
  assert.ok(features.length > 40);
  for (const feature of features) {
    if (feature.unit === undefined) continue;
    assert.ok(Object.values(DEVICE_FEATURE_UNITS).includes(feature.unit), feature.unit);
    assert.ok(
      allowed[feature.category]?.includes(feature.unit),
      `${feature.name}: ${feature.unit}`,
    );
  }
  // Enums carry no unit (UNITS_BY_CATEGORY_AND_TYPE): mode, operating state.
  for (const feature of features.filter((f) => f.category === 'thermostat')) {
    if (feature.type !== 'target-temperature') assert.equal(feature.unit, undefined, feature.name);
  }
  // One energy index per meter at most, never the gas.
  const indexes = features.filter((f) => f.category === 'energy-sensor' && f.type === 'index');
  assert.equal(indexes.length, 2, 'the P1 and the Anna P1');
  assert.ok(
    features
      .filter((f) => f.external_id.endsWith(':gas'))
      .every((f) => f.category === 'volume-sensor'),
  );
});

test('the plug types that may be switched never feed heating, cold, water nor the network', () => {
  for (const type of [
    'heater_central',
    'central_heating_pump',
    'heater_electric',
    'valve_actuator',
    'water_heater_vessel',
    'refrigerator',
    'freezer',
    'router',
    'zz_misc',
    'watercooker',
  ]) {
    assert.ok(!SWITCHABLE_PLUG_TYPES.includes(type), type);
  }
});
