import test from 'ava';
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  MAX_ENTRIES_IN_BODY, MAX_RECIPIENTS_PER_MESSAGE, buildDigest, loadMailConfig, parseRecipients, sendDigest,
} from '../lib/notify.js';
import { statusOf } from '../lib/changes.js';
import { sampleDigestInputs } from '../lib/muestra.js';
import { PRIVACY_URL, SITE_URL } from '../transparencia/site.js';
import {
  FIXTURES_DUMP, ROOT, entryFor, loadFixture, tmpDir,
} from './helpers.js';

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
  t.is(config.from, 'no-reply@arandadeduero.dev');
  t.is(config.region, 'eu-west-1');
});

test('loadMailConfig acepta remitente y región propios (y vacíos cuentan como no definidos)', (t) => {
  const own = loadMailConfig(goodEnv({ MAIL_FROM: 'avisos@example.com', AWS_REGION: 'eu-south-2' }));
  t.is(own.from, 'avisos@example.com');
  t.is(own.region, 'eu-south-2');
  const empty = loadMailConfig(goodEnv({ MAIL_FROM: '', AWS_REGION: '' }));
  t.is(empty.from, 'no-reply@arandadeduero.dev');
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

const FOLDER = 'cac-place-ext:ContractFolderStatus';
const PARTY = 'Alcaldía del Ayuntamiento de Aranda de Duero';
const NOW = new Date('2026-10-19T10:00:00+02:00');

// Anuncio sintético: estado, importes, resultado de adjudicación y plazo opcionales.
const mk = (n, {
  status = 'EV', title = `Anuncio ${n}`, link = `https://contrataciondelestado.es/detalle/${n}`, menor = false,
  budget, winners, net, gross, deadline, deadlineTime, docs = [], folder = `EXP/${n}`,
} = {}) => {
  const e = entryFor(PARTY, {
    id: `https://contrataciondelestado.es/sindicacion/${menor ? 'datosAbiertosMenores' : 'licitacionesPerfilContratante'}/${n}`,
    title,
    updated: `2026-10-0${(n % 9) + 1}T10:00:00.000+02:00`,
    link: { '@_href': link },
  });
  const cf = e[FOLDER];
  cf['cbc:ContractFolderID'] = folder;
  cf['cbc-place-ext:ContractFolderStatusCode'] = { '#text': status };
  cf['cac:ProcurementProject'] = { 'cbc:Name': title, 'cac:BudgetAmount': { 'cbc:TaxExclusiveAmount': budget ?? 31364.16 } };
  if (winners) {
    cf['cac:TenderResult'] = {
      'cbc:ResultCode': 8,
      'cac:WinningParty': winners.map((name) => ({ 'cac:PartyName': { 'cbc:Name': name } })),
      'cac:AwardedTenderedProject': { 'cac:LegalMonetaryTotal': { 'cbc:TaxExclusiveAmount': net, 'cbc:PayableAmount': gross } },
    };
  }
  if (deadline) {
    cf['cac:TenderingProcess'] = { 'cac:TenderSubmissionDeadlinePeriod': { 'cbc:EndDate': deadline, 'cbc:EndTime': deadlineTime } };
  }
  cf['cac:LegalDocumentReference'] = docs.map((d) => ({
    'cbc:ID': d, 'cac:Attachment': { 'cac:ExternalReference': { 'cbc:URI': `https://x/doc?DocumentIdParam=${d}` } },
  }));
  return e;
};
const prevOf = (e, status, docs = []) => {
  const p = structuredClone(e);
  p[FOLDER]['cbc-place-ext:ContractFolderStatusCode'] = { '#text': status };
  p[FOLDER]['cac:LegalDocumentReference'] = docs.map((d) => ({
    'cbc:ID': d, 'cac:Attachment': { 'cac:ExternalReference': { 'cbc:URI': `https://x/doc?DocumentIdParam=${d}` } },
  }));
  return p;
};
const digestOf = (entries, previous = new Map(), openings = new Map()) => buildDigest(
  entries, (e) => previous.get(e) ?? null, (e) => openings.get(e) ?? null, { now: NOW },
);
const count = (html, re) => (html.match(re) ?? []).length;

test('buildDigest resume los anuncios con título, órgano, resumen y enlace', (t) => {
  const entries = [loadFixture('menores', '10094109-1652862625721'), loadFixture('licitaciones', '1007341-1481547245528')];
  const { subject, body, html } = buildDigest(entries);
  t.is(subject, 'Novedades de contratación: 2 anuncios nuevos');
  t.regex(body, /Alcaldía del Ayuntamiento de Aranda de Duero/);
  t.regex(body, /Junta de Gobierno del Ayuntamiento de Aranda de Duero/);
  t.regex(body, /https:\/\/contrataciondelestado\.es\//);
  t.regex(html, /Cont\. menor/);
  t.regex(html, /Cont\. mayor/);
});

test('buildDigest usa singular y tolera anuncios sin título, resumen ni enlace', (t) => {
  const { subject, body, html } = buildDigest([{ id: 'https://x/1', updated: '2026-01-01T00:00:00Z' }]);
  t.is(subject, 'Novedades de contratación: 1 anuncio nuevo');
  t.regex(body, /\(sin título\)/);
  t.regex(body, /Órgano no indicado/);
  t.notRegex(html, /Ver en la Plataforma/);
});

test('asunto: cada combinación de categorías, sin ceros y con singular y plural', (t) => {
  const adj = mk(1, { status: 'ADJ' });
  const adj2 = mk(2, { status: 'ADJ' });
  const fresh = mk(3, { status: 'PUB' });
  const fresh2 = mk(4, { status: 'PUB' });
  const change = mk(5, { status: 'EV' });
  const change2 = mk(6, { status: 'RES' });
  const docs = [10, 11, 12, 13, 14, 15].map((n) => mk(n, { docs: ['a', 'b'] }));
  const same = mk(20);
  const previous = new Map([
    [adj, prevOf(adj, 'EV')], [adj2, prevOf(adj2, 'EV')], [change, prevOf(change, 'PUB')], [change2, prevOf(change2, 'ADJ')],
    [same, prevOf(same, 'EV')],
    ...docs.map((d) => [d, prevOf(d, 'EV', ['a'])]),
  ]);
  const subj = (entries) => digestOf(entries, previous).subject;
  const P = 'Novedades de contratación: ';
  t.is(subj([adj, fresh, ...docs]), `${P}1 adjudicación, 1 anuncio nuevo y 6 con documentos nuevos`);
  t.is(subj([fresh, fresh2, mk(7, { status: 'PUB' })]), `${P}3 anuncios nuevos`);
  t.is(subj([change, change2]), `${P}2 cambios de estado`);
  t.is(subj([change]), `${P}1 cambio de estado`);
  t.is(subj([adj, adj2]), `${P}2 adjudicaciones`);
  t.is(subj([adj, change, fresh]), `${P}1 adjudicación, 1 anuncio nuevo y 1 cambio de estado`);
  t.is(subj([docs[0]]), `${P}1 con documentos nuevos`);
  t.is(subj([same]), `${P}1 anuncio`);
  const same2 = mk(21);
  previous.set(same2, prevOf(same2, 'EV'));
  t.is(subj([same, same2]), `${P}2 anuncios`);
  t.is(subj([fresh, same]), `${P}1 anuncio nuevo y 1 con otras novedades`);
  t.true(subj([adj, adj2, fresh, fresh2, change, change2, ...docs, same]).length < 120);
});

test('orden: nuevas publicaciones, luego cambios de estado y luego solo documentos (en texto y HTML)', (t) => {
  const docsOnly = mk(1, { docs: ['a', 'b'] });
  const changed = mk(2, { status: 'ADJ' });
  const fresh = mk(3, { status: 'PUB' });
  const previous = new Map([[docsOnly, prevOf(docsOnly, 'EV', ['a'])], [changed, prevOf(changed, 'EV')]]);
  const { body, html } = digestOf([docsOnly, changed, fresh], previous);
  const at = (text, ...titles) => titles.map((x) => text.indexOf(x));
  const [a, b, c] = at(body, 'Anuncio 3', 'Anuncio 2', 'Anuncio 1');
  t.true(a > 0 && a < b && b < c);
  const [x, y, z] = at(html, '>Anuncio 3<', '>Anuncio 2<', '>Anuncio 1<');
  t.true(x > 0 && x < y && y < z);
});

test('HTML: etiquetas y colores por estado, flecha de cambio y nueva publicación', (t) => {
  const changed = mk(1, { status: 'ADJ' });
  const fresh = mk(2, { status: 'PUB' });
  const same = mk(3, { status: 'RES' });
  const minor = mk(4, { status: 'ANUL', menor: true });
  const previous = new Map([
    [changed, prevOf(changed, 'EV')], [same, prevOf(same, 'RES')], [minor, prevOf(minor, 'EV')],
  ]);
  const { html } = digestOf([changed, fresh, same, minor], previous);
  // etiquetas con los colores de la página
  t.regex(html, /t-mid[^>]*background:#ffd3a3;border:1px solid #b35400[^>]*>En evaluación</);
  t.regex(html, /t-warn[^>]*background:#fdecab;border:1px solid #9a7400[^>]*>Adjudicada</);
  t.regex(html, /t-info[^>]*background:#d6e6fb;border:1px solid #1565c0[^>]*>Publicada</);
  t.regex(html, /t-ok[^>]*background:#d3f0de;border:1px solid #1b7f3b[^>]*>Resuelta</);
  t.regex(html, /t-bad[^>]*background:#ffd6d2;border:1px solid #b3261e[^>]*>Anulada</);
  t.regex(html, /t-maj[^>]*background:#ead9f7;border:1px solid #7b2fb0[^>]*>Cont\. mayor</);
  t.regex(html, /t-min[^>]*background:#dde3ea;border:1px solid #52606f[^>]*>Cont\. menor</);
  // flecha: estado anterior -> nuevo
  t.regex(html, />En evaluación<\/span> <span[^>]*>&rarr;<\/span> <span[^>]*>Adjudicada</);
  t.regex(html, />Nueva publicación</);
  t.regex(html, /sin cambio de estado/);
  // borde izquierdo del color del estado
  t.regex(html, /border-left:5px solid #9a7400/);
  t.regex(html, /border-left:5px solid #b3261e/);
  // resumen de una línea
  t.regex(html, /<strong>1<\/strong> nueva publicación &nbsp;&middot;&nbsp; <strong>2<\/strong> cambios de estado/);
});

test('HTML: adjudicataria con importes, documentos nuevos y retirados, mesas y plazo', (t) => {
  const e = mk(1, {
    status: 'ADJ', winners: ['Obras Ejemplo, S.L.', 'Otra Empresa S.A.'], net: 100000, gross: 121000, docs: ['Acta.pdf', 'Nuevo.pdf'],
  });
  const open = mk(2, { status: 'PUB', deadline: '2026-10-30', deadlineTime: '14:00:00' });
  const expired = mk(3, { status: 'EV', deadline: '2026-09-30', deadlineTime: '14:00:00' });
  const live = mk(4, { status: 'EV', deadline: '2026-11-02', deadlineTime: '09:30:00' });
  const previous = new Map([
    [e, prevOf(e, 'EV', ['Acta.pdf', 'Viejo.pdf'])], [expired, prevOf(expired, 'EV')], [live, prevOf(live, 'EV')],
  ]);
  const openings = new Map([[e, {
    events: [
      {
        date: '2026-09-22', time: '11:30', type: 'Apertura sobre oferta económica', public: true, kind: 'a', sobre: '2',
      },
      {
        date: '2026-09-08', time: '11:45', type: 'Apertura sobre administrativo', public: false, kind: 'b', sobre: '1',
      },
    ],
    previous: null,
  }]]);
  const { html, body } = digestOf([e, open, expired, live], previous, openings);
  t.regex(html, /Adjudicataria:<\/strong> Obras Ejemplo, S\.L\.; Otra Empresa S\.A\. · 100\.000,00\s€ sin IVA/);
  t.regex(html, /121\.000,00\s€ IVA incl\./);
  t.regex(html, /Documentos nuevos \(1\):<\/strong> Nuevo\.pdf/);
  t.regex(html, /Documentos retirados \(1\):<\/strong> Viejo\.pdf/);
  t.regex(html, /Mesas de contratación/);
  t.regex(html, /22\/09\/2026 &middot; 11:30<\/span> Oferta económica &middot; <span[^>]*>acto público/);
  t.regex(html, /08\/09\/2026 &middot; 11:45<\/span> Administrativo &middot; <span[^>]*>acto no público/);
  // plazo: nueva publicación y plazo aún abierto sí; plazo vencido en un anuncio ya conocido, no
  t.regex(html, /Presentación de ofertas hasta:<\/strong> 30\/10\/2026 · 14:00/);
  t.regex(html, /Presentación de ofertas hasta:<\/strong> 02\/11\/2026 · 09:30/);
  t.notRegex(html, /30\/09\/2026/);
  t.is(count(html, /Presentación de ofertas hasta/g), 2);
  // texto plano
  t.regex(body, /Adjudicataria: Obras Ejemplo, S\.L\.; Otra Empresa S\.A\. · 100\.000,00\s€ sin IVA · 121\.000,00\s€ IVA incl\./);
  t.regex(body, /Estado: En evaluación -> Adjudicada/);
  t.regex(body, /Presentación de ofertas hasta: 30\/10\/2026 14:00/);
});

test('HTML: importe en formato es-ES, expediente, cabecera, pie con los enlaces de site.js y sin direcciones', (t) => {
  const { html } = digestOf([mk(1, { status: 'PUB', budget: 31364.16 })]);
  t.regex(html, /31\.364,16\s€/);
  t.regex(html, /Exp\. EXP\/1/);
  t.regex(html, /Novedades de contratación<\/div>/);
  t.regex(html, /Lunes 19 de octubre de 2026 &middot; Plataforma de Contratación del Sector Público/);
  t.regex(html, new RegExp(`src="${SITE_URL}images/correo-logo\\.png" width="240" alt="Ayuntamiento de Aranda de Duero"`));
  for (const href of [SITE_URL, `${SITE_URL}aperturas.ics`, `${SITE_URL}datos/`, `${SITE_URL}feed.xml`, PRIVACY_URL]) {
    t.true(html.includes(`href="${href}"`), href);
  }
  t.regex(html, /Recibes este aviso como destinatario/);
  t.regex(html, /La fuente oficial es siempre el anuncio original/);
  t.regex(html, /&copy; 2026 Ayuntamiento de Aranda de Duero/);
  t.notRegex(html, /unsubscribe|baja/i);
  t.regex(html, /prefers-color-scheme:dark/);
  t.regex(html, /max-width:620px/);
  t.notRegex(html, /<script/i);
  t.notRegex(html, /uno@example|dos@example/);
});

test('HTML bien formado: tablas, filas y celdas balanceadas', (t) => {
  const entries = [mk(1, { status: 'ADJ', winners: ['X'], net: 1, gross: 2 }), mk(2, { status: 'PUB' }), mk(3, { menor: true })];
  const previous = new Map([[entries[0], prevOf(entries[0], 'EV')]]);
  const { html } = digestOf(entries, previous);
  for (const name of ['table', 'tr', 'td', 'div', 'strong', 'a', 'span']) {
    t.is(count(html, new RegExp(`<${name}[\\s>]`, 'g')), count(html, new RegExp(`</${name}>`, 'g')), name);
  }
  t.regex(html, /^<!doctype html>/);
  t.true(html.includes('</html>'));
});

test('seguridad: se escapa todo el texto del feed y solo hay enlaces https', (t) => {
  const evil = '</td><script>alert(1)</script>"onmouseover="alert(2)" <img src=x onerror=alert(3)> &amp;';
  const e = mk(1, {
    status: '"><script>alert(4)</script>', title: evil, winners: [evil], net: 1, gross: 2, docs: [evil], folder: evil,
  });
  e[FOLDER]['cac-place-ext:LocatedContractingParty']['cac:Party']['cac:PartyName']['cbc:Name'] = evil;
  const bad = mk(2, { link: 'javascript:alert(1)', status: 'PUB' });
  const nonHttps = mk(3, { link: 'http://insecure.example/x', status: 'PUB' });
  const spaced = mk(4, { link: 'https://x.example/a b"onmouseover="x', status: 'PUB' });
  const previous = new Map([[e, prevOf(e, '<b>EV</b>')]]);
  const { html, body } = digestOf([e, bad, nonHttps, spaced], previous);
  t.notRegex(html, /<script/i);
  t.notRegex(html, /<img src=x/);
  t.notRegex(html, /"onmouseover=/);
  t.notRegex(html, /<b>EV/);
  t.regex(html, /&lt;\/td&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;onmouseover=&quot;alert\(2\)&quot;/);
  t.regex(html, /&amp;amp;/);
  t.notRegex(html, /javascript:/i);
  t.notRegex(html, /href="http:/);
  t.notRegex(html, /insecure\.example/);
  t.notRegex(html, /x\.example/);
  // los códigos de estado desconocidos salen escapados y con la etiqueta neutra
  t.regex(html, /t-neu[^>]*>&quot;&gt;&lt;script&gt;alert\(4\)/);
  // los anuncios con enlace no válido se muestran sin enlace ni botón
  t.is(count(html, /Ver en la Plataforma/g), 1);
  // el texto plano no lleva enlaces inseguros
  t.notRegex(body, /javascript:|http:\/\//);
  // balance intacto pese al contenido hostil
  t.is(count(html, /<table[\s>]/g), count(html, /<\/table>/g));
  t.is(count(html, /<td[\s>]/g), count(html, /<\/td>/g));
});

test('texto plano: una línea en blanco entre licitaciones y mismo orden que el HTML', (t) => {
  const a = mk(1, { status: 'PUB' });
  const b = mk(2, { status: 'ADJ', winners: ['Empresa'], net: 10, gross: 12 });
  const previous = new Map([[b, prevOf(b, 'EV')]]);
  const { body } = digestOf([b, a], previous);
  const blocks = body.split('\n\n');
  t.is(blocks.filter((x) => x.startsWith('- ')).length, 2);
  t.true(blocks.findIndex((x) => x.startsWith('- Anuncio 1')) < blocks.findIndex((x) => x.startsWith('- Anuncio 2')));
  t.notRegex(body, /\n\n\n/);
  t.regex(body, /^Novedades de contratación: 1 adjudicación y 1 anuncio nuevo\.\n\n- Anuncio 1/);
});

test('buildDigest limita a MAX_ENTRIES_IN_BODY y resume el resto en texto y HTML (120 -> 100 + línea)', (t) => {
  const entries = Array.from({ length: 120 }, (_, i) => mk(i + 1, { status: 'PUB', title: `Anuncio ${i + 1}` }));
  const { subject, body, html } = digestOf(entries);
  t.is(MAX_ENTRIES_IN_BODY, 100);
  t.regex(subject, /120 anuncios nuevos/);
  t.regex(body, /… y 20 más \(están en el repositorio, carpeta dump\/\)/);
  t.is(body.split('\n').filter((line) => line.startsWith('- ')).length, 100);
  t.regex(html, /&hellip; y 20 más \(están en el repositorio, carpeta dump\/\)/);
  t.is(count(html, /Ver en la Plataforma/g), 100);
});

test('muestra: asunto con prefijo, línea inicial en el texto y aviso en el HTML', (t) => {
  const e = mk(1, { status: 'PUB' });
  const { subject, body, html } = buildDigest([e], () => null, () => null, { now: NOW, sample: true });
  t.regex(subject, /^\[MUESTRA\] Novedades de contratación: /);
  t.regex(body, /^MUESTRA: correo de muestra con datos reales/);
  t.regex(html, /Correo de muestra: datos reales de los últimos anuncios, enviado solo a esta dirección\./);
  t.notRegex(buildDigest([e]).html, /Correo de muestra/);
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
  t.is(input.Source, 'no-reply@arandadeduero.dev');
  t.regex(input.Message.Subject.Data, /^Novedades de contratación: 1 anuncio nuevo$/);
  t.is(input.Message.Subject.Charset, 'UTF-8');
  t.is(input.Message.Body.Text.Charset, 'UTF-8');
  t.is(input.Message.Body.Html.Charset, 'UTF-8');
  t.regex(input.Message.Body.Html.Data, /^<!doctype html>/);
  t.notRegex(input.Message.Body.Html.Data, /example\.(com|org)/);
  // el cuerpo no contiene a los destinatarios
  t.notRegex(input.Message.Body.Text.Data, /example\.(com|org)/);
});

test('sendDigest reparte en varios mensajes si hay más de 50 destinatarios', async (t) => {
  const client = fakeClient();
  const total = (MAX_RECIPIENTS_PER_MESSAGE * 2) + 5;
  const recipients = Array.from({ length: total }, (_, i) => `persona${i}@example.com`);
  const messages = await sendDigest({
    config: {
      enabled: true, recipients, from: 'no-reply@arandadeduero.dev', region: 'eu-west-1',
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

// ---- muestra (lib/muestra.js)

test('sampleDigestInputs elige anuncios reales del dump y simula una nueva publicación y un cambio de estado', async (t) => {
  const { entries, previousOf, openingsOf } = await sampleDigestInputs(FIXTURES_DUMP, { count: 4 });
  t.true(entries.length > 1 && entries.length <= 4);
  t.is(previousOf(entries[0]), null);
  t.truthy(previousOf(entries[1]));
  t.not(statusOf(previousOf(entries[1])), statusOf(entries[1]));
  t.is(openingsOf(entries[0]), null); // los fixtures no traen aperturas
  const { subject, html, body } = buildDigest(entries, previousOf, openingsOf, { sample: true });
  t.regex(subject, /^\[MUESTRA\] Novedades de contratación: /);
  t.regex(html, /Nueva publicación/);
  t.regex(body, /Estado: .+ -> .+/);
});

test('sampleDigestInputs lee las aperturas reales y tolera un dump vacío', async (t) => {
  const dir = tmpDir();
  const empty = await sampleDigestInputs(dir);
  t.deepEqual(empty.entries, []);
  const dump = join(dir, 'dump');
  mkdirSync(join(dump, 'licitaciones'), { recursive: true });
  const entry = entryFor('Alcaldía del Ayuntamiento de Aranda de Duero', { id: 'https://x/licitacionesPerfilContratante/55' });
  writeFileSync(join(dump, 'licitaciones', `55-${Date.parse(entry.updated)}.json`), JSON.stringify(entry));
  writeFileSync(join(dump, 'aperturas.json'), JSON.stringify({ 55: { events: [{ date: '2026-10-20', time: '10:00', type: 'Apertura', public: true }] } }));
  const { entries, openingsOf } = await sampleDigestInputs(dump);
  t.is(entries.length, 1);
  t.is(openingsOf(entries[0]).events.length, 1);
  t.is(openingsOf({ id: 'https://x/9' }), null);
});

test('sendDigest con sample marca el asunto, avisa en el texto y devuelve cada MessageId a onSent', async (t) => {
  const client = { sent: [], send: async (c) => { client.sent.push(c.input); return { MessageId: 'abc' }; } };
  const ids = [];
  await sendDigest({
    config: loadMailConfig(goodEnv()),
    entries: [entryFor('Alcaldía del Ayuntamiento de Aranda de Duero')],
    client,
    sample: true,
    onSent: (r) => ids.push(r.MessageId),
  });
  t.deepEqual(ids, ['abc']);
  t.regex(client.sent[0].Message.Subject.Data, /^\[MUESTRA\] /);
  t.regex(client.sent[0].Message.Body.Html.Data, /Correo de muestra/);
});
