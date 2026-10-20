// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, buttons, errors).
// Errors thrown to Gladys are English (one language per message, like the
// core's); the statuses and button answers are { en, fr }. No text ever holds
// the token nor anything System Bridge sent.
// -----------------------------------------------------------------------------

import { CODES } from './bridge/errors.js';

const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));

/** Why System Bridge failed, in a few words. */
export function reasonOf(err) {
  switch (err?.code) {
    case CODES.UNREACHABLE:
      return { en: 'no connection', fr: 'pas de connexion' };
    case CODES.TIMEOUT:
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case CODES.HTTP:
      return { en: `HTTP error ${err.status}`, fr: `erreur HTTP ${err.status}` };
    case CODES.BAD_ANSWER:
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case CODES.TOO_LARGE:
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case CODES.REFUSED:
      return {
        en: `refused (${err.subtype ?? 'error'})`,
        fr: `refusé (${err.subtype ?? 'erreur'})`,
      };
    case CODES.CLOSED:
      return { en: 'connection closed', fr: 'connexion fermée' };
    case CODES.BAD_TOKEN:
      return { en: 'token refused', fr: 'jeton refusé' };
    case CODES.BUSY:
      return { en: 'too many requests', fr: 'trop de requêtes' };
    default:
      return { en: 'error', fr: 'erreur' };
  }
}

const RETRY = (delay) => ({
  en: `Retried in ${minutes(delay)} min.`,
  fr: `Nouvel essai dans ${minutes(delay)} min.`,
});

const join = (...parts) => ({
  en: parts
    .map((p) => p.en)
    .filter(Boolean)
    .join(' '),
  fr: parts
    .map((p) => p.fr)
    .filter(Boolean)
    .join(' '),
});

const value = (n, unit) => (n === null || n === undefined ? '?' : `${n} ${unit}`);

export const T = {
  status: {
    ok: ({ hostname, version, cpu, memory, openUrlMissing }) =>
      join(
        {
          en: `System Bridge${version ? ` ${version}` : ''} answers on ${hostname ?? 'the PC'}: CPU ${value(cpu, '%')}, memory ${value(memory, '%')}.`,
          fr: `System Bridge${version ? ` ${version}` : ''} répond sur ${hostname ?? 'le PC'} : CPU ${value(cpu, '%')}, mémoire ${value(memory, '%')}.`,
        },
        openUrlMissing
          ? {
              en: 'The URL to open is missing or not valid (http or https only): the "Open the URL" button is refused.',
              fr: 'L’URL à ouvrir manque ou n’est pas valide (http ou https seulement) : le bouton « Ouvrir l’URL » est refusé.',
            }
          : {},
      ),
    addressEmpty: {
      en: 'Type the address of the PC that runs System Bridge (e.g. 192.168.1.20).',
      fr: 'Saisissez l’adresse du PC où tourne System Bridge (ex. 192.168.1.20).',
    },
    addressInvalid: {
      en: 'The address of the PC is not valid: type host or host:port (e.g. 192.168.1.20 or my-pc.local:9170), without a path.',
      fr: 'L’adresse du PC n’est pas valide : saisissez hôte ou hôte:port (ex. 192.168.1.20 ou mon-pc.local:9170), sans chemin.',
    },
    addressTls: {
      en: 'System Bridge does not offer https / wss: type the address without https:// (the token then crosses your network in clear, keep it on a trusted network).',
      fr: 'System Bridge ne propose pas https / wss : saisissez l’adresse sans https:// (le jeton traverse alors votre réseau en clair, gardez-le sur un réseau de confiance).',
    },
    missingToken: {
      en: 'Type the token of System Bridge (its settings, API token).',
      fr: 'Saisissez le jeton de System Bridge (ses réglages, jeton d’API).',
    },
    tokenInvalid: {
      en: 'The token holds a space or an invisible character (copied with it?): paste it again, only the token.',
      fr: 'Le jeton contient une espace ou un caractère invisible (copié avec ?) : collez-le de nouveau, le jeton seul.',
    },
    tokenRefused: (delay) =>
      join(
        {
          en: 'System Bridge refused the token. Copy the token shown in its settings, paste it and save, or press "Test the connection".',
          fr: 'System Bridge a refusé le jeton. Copiez le jeton affiché dans ses réglages, collez-le et enregistrez, ou appuyez sur « Tester la connexion ».',
        },
        {
          en: `Gladys tries again alone once in ${Math.max(1, Math.round(delay / 3_600_000))} h.`,
          fr: `Gladys réessaie seul une fois dans ${Math.max(1, Math.round(delay / 3_600_000))} h.`,
        },
      ),
    offline: (err, delay) =>
      join(
        {
          en: 'The PC does not answer (off, asleep, or System Bridge not running):',
          fr: 'Le PC ne répond pas (éteint, en veille, ou System Bridge arrêté) :',
        },
        reasonOf(err),
        { en: '—', fr: '—' },
        RETRY(delay),
      ),
    notBridge: (err, delay) =>
      join(
        {
          en: 'This address does not answer like System Bridge (check the port, 9170 by default):',
          fr: 'Cette adresse ne répond pas comme System Bridge (vérifiez le port, 9170 par défaut) :',
        },
        reasonOf(err),
        { en: '—', fr: '—' },
        RETRY(delay),
      ),
    busy: (delay) =>
      join(
        {
          en: 'System Bridge asks Gladys to slow down (HTTP 429 or 503): every request is paused.',
          fr: 'System Bridge demande à Gladys de ralentir (HTTP 429 ou 503) : toutes les requêtes sont suspendues.',
        },
        RETRY(delay),
      ),
  },
  test: {
    ok: ({ hostname, version }) => ({
      en: `Connected: ${hostname ?? 'PC'}, System Bridge ${version ?? '?'}.`,
      fr: `Connecté : ${hostname ?? 'PC'}, System Bridge ${version ?? '?'}.`,
    }),
  },
  errors: {
    unknownDevice: 'Unknown device or feature: pick one of this integration',
    notCommand: 'This feature is a reading, not a command',
    notConnected: 'System Bridge is not connected: see the configuration of the integration',
    invalidValue: 'Invalid value: 1 expected (a push button)',
    powerDisabled:
      'Sleep, hibernate, restart and shut down are off: allow them first in the configuration of the integration ("Allow sleep, hibernate, restart and shut down")',
    openDisabled:
      'Opening a URL is off: allow it first in the configuration of the integration ("Allow opening the URL")',
    openUrlMissing:
      'The URL to open is missing or not valid (http or https only): type it in the configuration of the integration',
    busy: 'System Bridge asked Gladys to slow down: nothing was sent, try again later',
    stillRunning:
      'The previous command to this PC is still waiting for its answer: nothing was sent, try again in a moment',
    tooSlow:
      'The command could not be checked in time (Gladys waits 5 s for its answer): nothing was sent, try again',
    unknownState: (err) =>
      `The PC could not be read just before the command (${reasonOf(err).en}): nothing was sent`,
    otherPc:
      'Another PC answers at this address now (its machine id differs): nothing was sent. Run a Discovery',
    configChanged: 'The configuration changed meanwhile: nothing was sent, try again',
    cancelledByLock: 'Cancelled by a Lock command sent meanwhile: nothing was sent',
    tokenRefused: 'System Bridge refused the token: nothing was done. See the configuration',
    notSent: (err) =>
      `The command could not reach System Bridge (${reasonOf(err).en}): nothing was sent`,
    refused: (err) => `System Bridge refused the command (${reasonOf(err).en})`,
    sentUnconfirmed: (err) =>
      `Sent to System Bridge, without confirmation (${reasonOf(err).en}): the PC may have done it, check it before sending again`,
    testTooLong:
      'System Bridge has not answered yet: see the connection status in a moment (nothing else to do)',
  },
};
