// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. The connection status and the button answers
// are { en, fr }; errors thrown to Gladys (a refused command) are English, one
// language per message like the core's; the device texts (feature names)
// follow the language chosen in the configuration. They never quote a text
// of the Smile: only our own words, codes and HTTP statuses.
// -----------------------------------------------------------------------------

import { CODES } from './smile/errors.js';

const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const delay = (ms) => (ms >= 60_000 ? `${minutes(ms)} min` : `${seconds(ms)} s`);
const plural = (n, one, many) => (n === 1 ? one : many);

/** Why the Smile failed, in a few words (codes and statuses only). */
export function reasonOf(err) {
  switch (err?.code) {
    case CODES.UNREACHABLE:
      return { en: 'no connection', fr: 'pas de connexion' };
    case CODES.TIMEOUT:
    case CODES.NO_TIME:
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case CODES.HTTP:
      return { en: `HTTP error ${err.status}`, fr: `erreur HTTP ${err.status}` };
    case CODES.BAD_ANSWER:
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case CODES.TOO_LARGE:
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case CODES.CLOSED:
      return { en: 'configuration changed', fr: 'configuration changée' };
    default:
      return { en: 'error', fr: 'erreur' };
  }
}

const join = (...parts) => ({
  en: parts
    .map((p) => p?.en)
    .filter(Boolean)
    .join(' '),
  fr: parts
    .map((p) => p?.fr)
    .filter(Boolean)
    .join(' '),
});

const RETRY = (ms) => ({ en: `New try in ${delay(ms)}.`, fr: `Nouvel essai dans ${delay(ms)}.` });

const SMILE_NAMES = { p1: 'Smile P1', anna: 'Anna', adam: 'Adam' };

export const T = {
  status: {
    ok: ({ smile, firmware, devices, created, notes = [] }) =>
      join(
        {
          en: `Connected to the ${SMILE_NAMES[smile]} (firmware ${firmware}): ${devices} ${plural(devices, 'device', 'devices')} found.`,
          fr: `Connecté au ${SMILE_NAMES[smile]} (firmware ${firmware}) : ${devices} ${plural(devices, 'appareil trouvé', 'appareils trouvés')}.`,
        },
        created === 0
          ? {
              en: 'Create them from the "Discover" tab to receive their values.',
              fr: 'Créez-les depuis l’onglet « Découverte » pour recevoir leurs valeurs.',
            }
          : undefined,
        ...notes,
      ),
    hostEmpty: {
      en: 'Type the address of the Smile (its IP address on your network, e.g. 192.168.1.30).',
      fr: 'Saisissez l’adresse du Smile (son adresse IP sur votre réseau, ex. 192.168.1.30).',
    },
    hostInvalid: {
      en: 'The address of the Smile is not valid: type its IP address or host name (e.g. 192.168.1.30), without a path.',
      fr: 'L’adresse du Smile n’est pas valide : saisissez son adresse IP ou son nom (ex. 192.168.1.30), sans chemin.',
    },
    hostCredentials: {
      en: 'Remove the user name and password from the address: the Smile ID has its own field.',
      fr: 'Retirez l’identifiant et le mot de passe de l’adresse : l’ID du Smile a son propre champ.',
    },
    hostHttps: {
      en: 'The local API of the Smile only speaks plain http: type its address without https://.',
      fr: 'L’API locale du Smile ne parle qu’en http simple : saisissez son adresse sans https://.',
    },
    idEmpty: {
      en: 'Type the Smile ID: the 8 characters printed on the back of the Smile (also in the Plugwise app).',
      fr: 'Saisissez l’ID du Smile : les 8 caractères imprimés au dos du Smile (aussi dans l’app Plugwise).',
    },
    idInvalid: {
      en: 'The Smile ID is 8 letters or digits (printed on the back of the Smile): type it again.',
      fr: 'L’ID du Smile fait 8 lettres ou chiffres (imprimés au dos du Smile) : saisissez-le de nouveau.',
    },
    authRefused: {
      en: 'The Smile refused the Smile ID (HTTP 401). Gladys does not try again by itself: fix it and save, or press "Test the connection".',
      fr: 'Le Smile a refusé l’ID du Smile (HTTP 401). Gladys ne réessaie pas seul : corrigez-le et enregistrez, ou appuyez sur « Tester la connexion ».',
    },
    busy: (ms) =>
      join(
        {
          en: 'The Smile asks Gladys to slow down (HTTP 429): every request is paused.',
          fr: 'Le Smile demande à Gladys de ralentir (HTTP 429) : toutes les requêtes sont suspendues.',
        },
        RETRY(ms),
      ),
    notSmile: (ms) =>
      join(
        {
          en: 'This address does not answer like a Plugwise Smile: check the address and the port (80 by default).',
          fr: 'Cette adresse ne répond pas comme un Smile Plugwise : vérifiez l’adresse et le port (80 par défaut).',
        },
        RETRY(ms),
      ),
    unreachable: (err, ms) =>
      join(
        {
          en: `The Smile could not be read (${reasonOf(err).en}).`,
          fr: `Le Smile n’a pas pu être lu (${reasonOf(err).fr}).`,
        },
        RETRY(ms),
      ),
    unsupported: (reason) =>
      ({
        legacy: {
          en: 'This Smile has an older firmware (no <gateway> in its answer: Smile P1 v2/v3, Anna v1/v3, Stretch): not supported by this integration.',
          fr: 'Ce Smile a un ancien firmware (pas de <gateway> dans sa réponse : Smile P1 v2/v3, Anna v1/v3, Stretch) : non pris en charge par cette intégration.',
        },
        firmware: {
          en: 'This Smile needs a firmware update (Adam before v3, Anna before v4): update it from the Plugwise app.',
          fr: 'Ce Smile a besoin d’une mise à jour du firmware (Adam avant v3, Anna avant v4) : mettez-le à jour depuis l’app Plugwise.',
        },
        annaOnAdam: {
          en: 'This Anna is connected to an Adam: type the address and the ID of the Adam instead.',
          fr: 'Cet Anna est relié à un Adam : saisissez plutôt l’adresse et l’ID de l’Adam.',
        },
      })[reason] ?? {
        en: 'This Plugwise gateway is not a Smile P1, Anna or Adam: not supported.',
        fr: 'Cette passerelle Plugwise n’est ni un Smile P1, ni un Anna, ni un Adam : non prise en charge.',
      },
  },
  notes: {
    meterNotConnected: {
      en: 'The Smile says the smart meter is not connected (P1 cable?): its values are not sent.',
      fr: 'Le Smile indique que le compteur n’est pas connecté (câble P1 ?) : ses valeurs ne sont pas envoyées.',
    },
    stale: {
      en: 'The Smile gives no new power reading of the meter: the power is no longer sent.',
      fr: 'Le Smile ne donne plus de nouvelle puissance du compteur : elle n’est plus envoyée.',
    },
    noIndex: {
      en: 'The meter gives no index for both tariffs right now: the consumption index waits for it.',
      fr: 'Le compteur ne donne pas l’index des deux tarifs en ce moment : l’index de consommation l’attend.',
    },
    heaterUnavailable: {
      en: 'The Smile has no OpenTherm communication with the boiler: its values are not sent.',
      fr: 'Le Smile n’a plus de communication OpenTherm avec la chaudière : ses valeurs ne sont pas envoyées.',
    },
    held: ({ direction, from, to }) => {
      if (direction === 'down') {
        return {
          en: `The consumption index dropped from ${from} to ${to} kWh: held back, the last accepted value is sent again. If the meter was really replaced or reset, click "Accept the held index" in the configuration of the integration: nothing is billed for the drop, the consumption goes on from there. Saving the configuration accepts nothing.`,
          fr: `L’index de consommation a baissé de ${from} à ${to} kWh : retenu, la dernière valeur acceptée est renvoyée. Si le compteur a vraiment été remplacé ou remis à zéro, cliquez sur « Accepter l’index retenu » dans la configuration de l’intégration : rien n’est facturé pour la baisse, la consommation repart de là. Enregistrer la configuration n’accepte rien.`,
        };
      }
      const kwh = Math.round((to - from) * 1000) / 1000;
      return {
        en: `The consumption index jumped from ${from} to ${to} kWh: held back, not sent to the energy monitoring. If you click "Accept the held index" in the configuration of the integration, ${kwh} kWh will be counted at once as consumption; accept only if this energy was really consumed. Saving the configuration accepts nothing.`,
        fr: `L’index de consommation a sauté de ${from} à ${to} kWh : retenu, non envoyé au suivi énergétique. Si vous cliquez sur « Accepter l’index retenu » dans la configuration de l’intégration, ${kwh} kWh seront comptés d’un coup comme consommation ; n’acceptez que si cette énergie a vraiment été consommée. Enregistrer la configuration n’accepte rien.`,
      };
    },
  },
  accept: {
    nothing: {
      en: 'No consumption index is held back: nothing to accept.',
      fr: 'Aucun index de consommation n’est retenu : rien à accepter.',
    },
    up: ({ from, to }) => {
      const kwh = Math.round((to - from) * 1000) / 1000;
      return {
        en: `Accepted: the index ${to} kWh will be sent at the next read, and ${kwh} kWh (plus what the home uses meanwhile) will be counted at once as consumption. A different value stays held.`,
        fr: `Accepté : l’index ${to} kWh sera envoyé à la prochaine lecture, et ${kwh} kWh (plus ce que le foyer consomme d’ici là) seront comptés d’un coup comme consommation. Une autre valeur reste retenue.`,
      };
    },
    down: ({ from, to }) => ({
      en: `Accepted: the index goes from ${from} down to ${to} kWh at the next read; 0 kWh is counted for the drop, the consumption goes on from there. A different value stays held.`,
      fr: `Accepté : l’index passe de ${from} à ${to} kWh à la prochaine lecture ; 0 kWh est compté pour la baisse, la consommation repart de là. Une autre valeur reste retenue.`,
    }),
  },
  test: {
    ok: ({ smile, firmware, zones, plugs, meter }) => {
      const parts = [];
      if (meter) parts.push({ en: 'smart meter', fr: 'compteur' });
      if (zones)
        parts.push({
          en: `${zones} ${plural(zones, 'zone', 'zones')}`,
          fr: `${zones} ${plural(zones, 'zone', 'zones')}`,
        });
      if (plugs)
        parts.push({
          en: `${plugs} ${plural(plugs, 'plug', 'plugs')}`,
          fr: `${plugs} ${plural(plugs, 'prise', 'prises')}`,
        });
      const list = (lang) => (parts.length ? parts.map((p) => p[lang]).join(', ') : '-');
      return {
        en: `${SMILE_NAMES[smile]} read (firmware ${firmware}): ${list('en')}.`,
        fr: `${SMILE_NAMES[smile]} lu (firmware ${firmware}) : ${list('fr')}.`,
      };
    },
    slow: {
      en: 'The Smile is slow to answer: look at the integration status in a minute.',
      fr: 'Le Smile tarde à répondre : regardez l’état de l’intégration dans une minute.',
    },
  },
  // Errors thrown to Gladys for a refused command: English, our own words only.
  errors: {
    unknownDevice: 'Unknown Plugwise feature',
    climateDisabled:
      'Commands of the thermostats are off: tick "Allow the thermostat commands" in the configuration of the integration',
    plugsDisabled:
      'Commands of the plugs are off: tick "Allow switching the plugs" in the configuration of the integration',
    notConnected: 'The Smile is not connected',
    busy: 'The Smile asked Gladys to slow down (HTTP 429): try again later',
    configChanged: 'The configuration changed meanwhile: command not sent',
    tooSlow: 'The Smile is too slow to answer: command not sent',
    unknownState: (err) =>
      `The Smile could not be read just before acting (${reasonOf(err).en}): command not sent`,
    gone: 'This device is no longer on the Smile: command not sent',
    invalidSetpoint: (min, max) => `The setpoint must be a number from ${min} to ${max} °C`,
    noSetpoint: 'The Smile gives no setpoint for this zone right now: command not sent',
    badBounds:
      'The Smile gives setpoint bounds for this zone that leave no valid value: command not sent',
    invalidPreset: 'This preset is not one of the Smile: command not sent',
    noZoneType: 'The Smile gives no type or name for this zone right now: preset not sent',
    invalidMode: 'This mode is not one of the Smile: command not sent',
    unsafeRegulationMode:
      'Only "heating" and "cooling" can be set from Gladys (off and the bleeding cycles stay in the Plugwise app): command not sent',
    invalidSwitch: 'The plug value must be 0 or 1',
    lockedPlug:
      'This plug is locked in Plugwise, or its lock is unknown: command not sent (unlock it in the Plugwise app)',
    unsafePlug: (type) =>
      `This plug feeds a "${type ?? 'unknown'}" appliance: only lighting and entertainment plugs can be switched from Gladys (a boiler, a pump, a fridge, a freezer, a router... never). Command not sent`,
    plugUnknownState: 'The Smile gives no state for this plug right now: command not sent',
    notSent: (err) => `Command not sent to the Smile (${reasonOf(err).en})`,
    refused: (err) => `The Smile refused the command (${reasonOf(err).en})`,
    unconfirmed: (err) =>
      `Command sent to the Smile, without confirmation (${reasonOf(err).en}): the next read will show whether it was applied`,
    testTooLong: 'The Smile did not answer within 25 s',
  },
};

/** The names of the devices and features, in the language of the configuration. */
const DEVICE_TEXTS = {
  en: {
    meter: 'Smart meter (Plugwise P1)',
    gateway: (smile) => `Plugwise ${SMILE_NAMES[smile]}`,
    heater: 'Boiler (Plugwise)',
    zone: (name) => `${name} (Plugwise)`,
    plug: (name) => `${name} (Plugwise plug)`,
    features: {
      power: 'Power taken from the grid',
      injection_power: 'Power injected into the grid (W)',
      consumption_index: 'Consumption index',
      consumption_peak: 'Consumption index, peak tariff (kWh)',
      consumption_offpeak: 'Consumption index, off-peak tariff (kWh)',
      injection_peak: 'Injection index, peak tariff (kWh)',
      injection_offpeak: 'Injection index, off-peak tariff (kWh)',
      gas: 'Gas index',
      phasePower: (n) => `Power taken L${n} (W)`,
      phaseInjection: (n) => `Power injected L${n} (W)`,
      phaseVoltage: (n) => `Voltage L${n}`,
      outdoor_temperature: 'Outdoor temperature',
      regulation_mode: 'Regulation mode',
      gateway_mode: 'Gateway mode',
      flame: 'Flame',
      heating: 'Heating',
      hot_water: 'Hot water running',
      water_temperature: 'Heating water temperature',
      return_temperature: 'Return water temperature',
      hot_water_temperature: 'Hot water temperature',
      pressure: 'Water pressure',
      modulation: 'Modulation (%)',
      temperature: 'Temperature',
      target: 'Setpoint',
      operating: 'Heating state',
      mode: 'Mode',
      preset: 'Preset',
      schedule: 'Active schedule',
      state: 'State',
      plug_power: 'Power',
    },
    options: {
      heating: 'Heating',
      cooling: 'Cooling',
      off: 'Off',
      bleeding_hot: 'Bleeding (hot)',
      bleeding_cold: 'Bleeding (cold)',
      away: 'Away',
      full: 'Home',
      vacation: 'Vacation',
      home: 'Home',
      asleep: 'Night',
      no_frost: 'Frost protection',
    },
  },
  fr: {
    meter: 'Compteur (Plugwise P1)',
    gateway: (smile) => `Plugwise ${SMILE_NAMES[smile]}`,
    heater: 'Chaudière (Plugwise)',
    zone: (name) => `${name} (Plugwise)`,
    plug: (name) => `${name} (prise Plugwise)`,
    features: {
      power: 'Puissance prélevée',
      injection_power: 'Puissance injectée (W)',
      consumption_index: 'Index de consommation',
      consumption_peak: 'Index de consommation, tarif plein (kWh)',
      consumption_offpeak: 'Index de consommation, tarif creux (kWh)',
      injection_peak: 'Index d’injection, tarif plein (kWh)',
      injection_offpeak: 'Index d’injection, tarif creux (kWh)',
      gas: 'Index gaz',
      phasePower: (n) => `Puissance prélevée L${n} (W)`,
      phaseInjection: (n) => `Puissance injectée L${n} (W)`,
      phaseVoltage: (n) => `Tension L${n}`,
      outdoor_temperature: 'Température extérieure',
      regulation_mode: 'Mode de régulation',
      gateway_mode: 'Mode de la passerelle',
      flame: 'Flamme',
      heating: 'Chauffage',
      hot_water: 'Eau chaude en cours',
      water_temperature: 'Température de l’eau de chauffage',
      return_temperature: 'Température de l’eau de retour',
      hot_water_temperature: 'Température de l’eau chaude',
      pressure: 'Pression de l’eau',
      modulation: 'Modulation (%)',
      temperature: 'Température',
      target: 'Consigne',
      operating: 'État du chauffage',
      mode: 'Mode',
      preset: 'Préréglage',
      schedule: 'Programme actif',
      state: 'État',
      plug_power: 'Puissance',
    },
    options: {
      heating: 'Chauffage',
      cooling: 'Refroidissement',
      off: 'Arrêt',
      bleeding_hot: 'Purge (chaud)',
      bleeding_cold: 'Purge (froid)',
      away: 'Absent',
      full: 'Présent',
      vacation: 'Vacances',
      home: 'Maison',
      asleep: 'Nuit',
      no_frost: 'Hors-gel',
    },
  },
};

export const texts = (language) => DEVICE_TEXTS[language] ?? DEVICE_TEXTS.fr;
