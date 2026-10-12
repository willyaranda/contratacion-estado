import test from 'ava';
import { spawnSync } from 'child_process';
import { join } from 'path';

import {
  MAX_ENTRIES_IN_BODY, MAX_RECIPIENTS_PER_MESSAGE, buildDigest, loadMailConfig, parseRecipients, sendDigest,
} from '../lib/notify.js';
import { ROOT, entryFor, loadFixture } from './helpers.js';

// Valores falsos reconocibles: sirven para comprobar que nunca aparecen en mensajes ni en la salida.
const FAKE_KEY_ID = 'AKIAFAKEFAKEFAKE0000';
const FAKE_SECRET = 'fake/secret+KEY0123456789abcdefghijklmnopqrstuv';
const goodEnv = (extra = {}) => ({
  SEND_EMAILS: '1',
  NOTIFY_TO: 'uno@example.com, dos@example.org',
  AWS_ACCESS_KEY_ID: FAKE_KEY_ID,
  AWS_SECRET_ACCESS_KEY: FAKE_SECRET,
  ...extra,
});

// ---- parseRecipients

test('parseRecipients separa por comas, recorta espacios y elimina repetidos', (t) => {
  t.deepEqual(parseRecipients('a@x.com'), ['a@x.com']);
  t.deepEqual(parseRecipients(' a@x.com ,b@y.org,A@X.com'), ['a@x.com', 'b@y.org']);
});

test('parseRecipients falla si la lista está vacía o no es texto', (t) => {
  for (const value of [undefined, null, '', '   ', 42]) {
    t.throws(() => parseRecipients(value), { message: /vacía o no definida/ });
  }
});

test('parseRecipients falla con elementos vacíos y dice en qué posición', (t) => {
  t.throws(() => parseRecipients('a@x.com,,b@y.org'), { message: /posiciones 2 / });
  t.throws(() => parseRecipients('a@x.com,'), { message: /posiciones 2 / });
  t.throws(() => parseRecipients(',a@x.com'), { message: /posiciones 1 / });
});

test('parseRecipients falla con direcciones no válidas o con otros separadores', (t) => {
  t.throws(() => parseRecipients('a@x.com,no-es-correo'), { message: /no válidas en las posiciones 2/ });
  t.throws(() => parseRecipients('a@x.com;b@y.org'), { message: /no válidas/ });
  t.throws(() => parseRecipients('a@x.com b@y.org'), { message: /no válidas/ });
  t.throws(() => parseRecipients('Nombre <a@x.com>'), { message: /no válidas/ });
  t.throws(() => parseRecipients('a@x'), { message: /no válidas/ });
});

test('los errores de parseRecipients no incluyen las direcciones', (t) => {
  const error = t.throws(() => parseRecipients('secreto.persona@example.com,esto-no-vale'));
  t.notRegex(error.message, /secreto|persona|example\.com/);
});

// ---- loadMailConfig

test('loadMailConfig: sin SEND_EMAILS=1 el aviso queda desactivado y no valida nada', (t) => {
  t.deepEqual(loadMailConfig({}), { enabled: false });
  t.deepEqual(loadMailConfig({ SEND_EMAILS: '0', NOTIFY_TO: 'lo-que-sea' }), { enabled: false });
});

test('loadMailConfig devuelve destinatarios, remitente y región por defecto', (t) => {
  const config = loadMailConfig(goodEnv());
  t.true(config.enabled);
  t.deepEqual(config.recipients, ['uno@example.com', 'dos@example.org']);
  t.is(config.from, 'info@sentiraranda.es');
  t.is(config.region, 'eu-west-1');
});

test('loadMailConfig acepta remitente y región propios (y vacíos cuentan como no definidos)', (t) => {
  const own = loadMailConfig(goodEnv({ MAIL_FROM: 'avisos@example.com', AWS_REGION: 'eu-south-2' }));
  t.is(own.from, 'avisos@example.com');
  t.is(own.region, 'eu-south-2');
  const empty = loadMailConfig(goodEnv({ MAIL_FROM: '', AWS_REGION: '' }));
  t.is(empty.from, 'info@sentiraranda.es');
  t.is(empty.region, 'eu-west-1');
});

test('loadMailConfig falla si la lista es incorrecta', (t) => {
  t.throws(() => loadMailConfig(goodEnv({ NOTIFY_TO: undefined })), { message: /NOTIFY_TO/ });
  t.throws(() => loadMailConfig(goodEnv({ NOTIFY_TO: 'a@x.com,,b@y.org' })), { message: /vacíos/ });
  t.throws(() => loadMailConfig(goodEnv({ NOTIFY_TO: 'a@x.com;b@y.org' })), { message: /no válidas/ });
});

test('loadMailConfig falla si faltan credenciales, sin revelar ningún valor', (t) => {
  const error = t.throws(() => loadMailConfig(goodEnv({ AWS_SECRET_ACCESS_KEY: '' })), { message: /AWS_SECRET_ACCESS_KEY/ });
  t.notRegex(error.message, new RegExp(FAKE_KEY_ID));
  t.throws(() => loadMailConfig(goodEnv({ AWS_ACCESS_KEY_ID: undefined })), { message: /AWS_ACCESS_KEY_ID/ });
});

test('loadMailConfig falla si el remitente no es una dirección', (t) => {
  t.throws(() => loadMailConfig(goodEnv({ MAIL_FROM: 'no-es-correo' })), { message: /MAIL_FROM/ });
});

// ---- buildDigest

test('buildDigest resume los anuncios con título, órgano, resumen y enlace', (t) => {
  const entries = [loadFixture('menores', '10094109-1652862625721'), loadFixture('licitaciones', '1007341-1481547245528')];
  const { subject, body } = buildDigest(entries);
  t.is(subject, '[Licitaciones] 2 anuncios nuevos del Ayuntamiento de Aranda de Duero');
  t.regex(body, /Alcaldía del Ayuntamiento de Aranda de Duero/);
  t.regex(body, /Junta de Gobierno del Ayuntamiento de Aranda de Duero/);
  t.regex(body, /https:\/\/contrataciondelestado\.es\//);
});

test('buildDigest usa singular y tolera anuncios sin título, resumen ni enlace', (t) => {
  const { subject, body } = buildDigest([{ id: 'https://x/1', updated: '2026-01-01T00:00:00Z' }]);
  t.is(subject, '[Licitaciones] 1 anuncio nuevo del Ayuntamiento de Aranda de Duero');
  t.regex(body, /\(sin título\)/);
  t.regex(body, /Órgano no indicado/);
});

test('buildDigest limita el cuerpo y resume el resto', (t) => {
  const extra = 7;
  const entries = Array.from(
    { length: MAX_ENTRIES_IN_BODY + extra },
    (_, i) => entryFor('Pleno del Ayuntamiento de Aranda de Duero', { title: `Anuncio ${i}` }),
  );
  const { subject, body } = buildDigest(entries);
  t.regex(subject, new RegExp(`${MAX_ENTRIES_IN_BODY + extra} anuncios nuevos`));
  t.regex(body, /… y 7 más/);
  t.is(body.split('\n').filter((line) => line.startsWith('- ')).length, MAX_ENTRIES_IN_BODY);
});

// ---- sendDigest

const fakeClient = () => {
  const sent = [];
  return { sent, send: async (command) => { sent.push(command.input); } };
};

test('sendDigest envía los destinatarios solo en CCO', async (t) => {
  const client = fakeClient();
  const config = loadMailConfig(goodEnv());
  const messages = await sendDigest({ config, entries: [entryFor('Alcaldía del Ayuntamiento de Aranda de Duero')], client });

  t.is(messages, 1);
  const [input] = client.sent;
  t.deepEqual(input.Destination, { BccAddresses: ['uno@example.com', 'dos@example.org'] });
  t.false('ToAddresses' in input.Destination);
  t.false('CcAddresses' in input.Destination);
  t.is(input.Source, 'info@sentiraranda.es');
  t.regex(input.Message.Subject.Data, /1 anuncio nuevo/);
  // el cuerpo no contiene a los destinatarios
  t.notRegex(input.Message.Body.Text.Data, /example\.(com|org)/);
});

test('sendDigest reparte en varios mensajes si hay más de 50 destinatarios', async (t) => {
  const client = fakeClient();
  const total = (MAX_RECIPIENTS_PER_MESSAGE * 2) + 5;
  const recipients = Array.from({ length: total }, (_, i) => `persona${i}@example.com`);
  const messages = await sendDigest({
    config: {
      enabled: true, recipients, from: 'info@sentiraranda.es', region: 'eu-west-1',
    },
    entries: [entryFor('Pleno del Ayuntamiento de Aranda de Duero')],
    client,
  });
  t.is(messages, 3);
  t.deepEqual(client.sent.map((m) => m.Destination.BccAddresses.length), [50, 50, 5]);
});

test('sendDigest no envía nada si el aviso está desactivado o no hay anuncios nuevos', async (t) => {
  const client = fakeClient();
  t.is(await sendDigest({ config: { enabled: false }, entries: [entryFor('X')], client }), 0);
  t.is(await sendDigest({ config: loadMailConfig(goodEnv()), entries: [], client }), 0);
  t.is(client.sent.length, 0);
});

// ---- index.js: el job debe fallar si la configuración es incorrecta, sin imprimir secretos

const runIndex = (env) => spawnSync(process.execPath, [join(ROOT, 'index.js')], {
  env: { PATH: process.env.PATH, ...env },
  encoding: 'utf8',
  timeout: 20000,
});

test('index.js falla antes de descargar si NOTIFY_TO está mal formada y no imprime secretos', (t) => {
  const result = runIndex(goodEnv({ NOTIFY_TO: 'uno@example.com,,dos@example.org' }));
  const output = result.stdout + result.stderr;
  t.is(result.status, 1);
  t.regex(result.stderr, /elementos vacíos/);
  t.false(output.includes(FAKE_SECRET));
  t.false(output.includes(FAKE_KEY_ID));
  t.notRegex(output, /Descargando/); // no llegó a pedir ningún feed
});

test('index.js falla antes de descargar si faltan las credenciales de AWS', (t) => {
  const result = runIndex({ SEND_EMAILS: '1', NOTIFY_TO: 'uno@example.com' });
  t.is(result.status, 1);
  t.regex(result.stderr, /AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY/);
  t.notRegex(result.stdout, /Descargando/);
});
