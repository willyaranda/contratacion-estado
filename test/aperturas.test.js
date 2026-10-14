import test from 'ava';
import { cpSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  decodeEntities, eventStartMs, madridToUtcMs, parseDocuments, parseEvents, readAperturas, syncAperturas, writeAperturas,
} from '../lib/aperturas.js';
import { buildIcs } from '../lib/ics.js';
import { openingsLines, shortType } from '../lib/aperturas-text.js';
import { buildRecords } from '../transparencia/extract.js';
import { buildDigest } from '../lib/notify.js';
import { FIXTURES_DUMP, entryFor, tmpDir } from './helpers.js';

const DOC = (id, fmt) => `https://contrataciondelestado.es/FileSystem/servlet/GetDocumentByIdServlet?cifrado=X&amp;DocumentIdParam=${id}${fmt}`;
const row = (date, name, id) => `<tr><td>${date}</td><td>${name}</td>
  <td><a href="${DOC(id, 'h')}"></a><a href="${DOC(id, 'x')}"></a><a href="${DOC(id, 'p')}"></a></td></tr>`;
const FICHA = `<table>
  ${row('29/09/2026 14:13:26', 'Anuncio de Licitaci&#243;n', 'cn')}
  ${row('21/09/2026 10:37:23', 'Rectificaci&#243;n de Pliego', 'cd')}
  <tr><td>14/10/2026 13:57:20</td><td>NOTA ACLARATORIA.pdf</td><td><a href="${DOC('nota', 'p')}"></a></td></tr>
  <tr><td>sin enlaces</td></tr>
</table>`;

const event = (type, code, date, time, place, restriction = 'Público') => `<cac:OpenTenderEvent>
  <cbc:IdentificationID>Sobre Único</cbc:IdentificationID>
  <cbc:OccurrenceDate>${date}+02:00</cbc:OccurrenceDate><cbc:OccurrenceTime>${time}:00.000</cbc:OccurrenceTime>
  <cbc:TypeCode name="${type}">${code}</cbc:TypeCode>
  <cac:OccurrenceLocation><cbc:Description>${place}</cbc:Description>
    <cac:Address><cbc:CityName>ARANDA DE DUERO</cbc:CityName><cac:AddressLine><cbc:Line>PZ MAYOR, 1</cbc:Line></cac:AddressLine></cac:Address>
  </cac:OccurrenceLocation>
  <cac:AttendanceConditions><cbc:AttendanceRestrictionCode name="${restriction}">1</cbc:AttendanceRestrictionCode></cac:AttendanceConditions>
</cac:OpenTenderEvent>`;
const xmlOf = (...events) => `<?xml version="1.0"?><Notice xmlns:cac="a" xmlns:cbc="b"><cac:Process>${events.join('')}</cac:Process></Notice>`;

// ---- zona horaria

test('madridToUtcMs aplica el horario de verano e invierno', (t) => {
  t.is(new Date(madridToUtcMs(2026, 10, 15, 11, 30)).toISOString(), '2026-10-15T09:30:00.000Z'); // CEST (+2)
  t.is(new Date(madridToUtcMs(2026, 12, 15, 11, 30)).toISOString(), '2026-12-15T10:30:00.000Z'); // CET (+1)
});

// ---- ficha web

test('decodeEntities resuelve entidades numéricas, hexadecimales y con nombre', (t) => {
  t.is(decodeEntities('Licitaci&#243;n &amp; pliego &#xF3; &nbsp;&desconocida;'), 'Licitación & pliego ó  &desconocida;');
});

test('parseDocuments devuelve nombre, fecha y el XML (2º enlace) de los documentos generados', (t) => {
  const docs = parseDocuments(FICHA);
  t.is(docs.length, 3);
  t.is(docs[0].name, 'Anuncio de Licitación');
  t.is(new Date(docs[0].published).toISOString(), '2026-09-29T12:13:26.000Z');
  t.regex(docs[0].xml, /DocumentIdParam=cnx$/);
  t.false(docs[0].xml.includes('&amp;'));
  t.is(docs[2].xml, null); // un PDF suelto no tiene XML
});

// ---- XML

test('parseEvents extrae fecha, hora, tipo, lugar y carácter del acto, ordenados', (t) => {
  const events = parseEvents(xmlOf(
    event('Apertura sobre oferta económica', 4, '2026-10-21', '11:45', 'Salón de Plenos'),
    event('Apertura sobre administrativo', 2, '2026-10-14', '11:30', 'Salón de Plenos', 'Privado'),
  ));
  t.is(events.length, 2);
  t.deepEqual(events[0], {
    kind: 2, type: 'Apertura sobre administrativo', sobre: 'Sobre Único', date: '2026-10-14', time: '11:30',
    place: 'Salón de Plenos', address: 'PZ MAYOR, 1, ARANDA DE DUERO', public: false,
  });
  t.true(events[1].public);
  t.is(new Date(eventStartMs(events[1])).toISOString(), '2026-10-21T09:45:00.000Z');
});

test('parseEvents ignora eventos sin fecha y XML sin aperturas', (t) => {
  t.deepEqual(parseEvents(xmlOf()), []);
  t.deepEqual(parseEvents(xmlOf('<cac:OpenTenderEvent><cbc:IdentificationID>x</cbc:IdentificationID></cac:OpenTenderEvent>')), []);
});

// ---- sincronización

const dumpWith = (versions) => {
  const dump = tmpDir();
  mkdirSync(join(dump, 'licitaciones'));
  for (const { id, ts, status } of versions) {
    const e = entryFor('Pleno del Ayuntamiento de Aranda de Duero', {
      id: `https://x/${id}`, updated: new Date(ts).toISOString(), title: `Licitación ${id}`,
      link: { '@_href': `https://ficha/${id}` },
    });
    e['cac-place-ext:ContractFolderStatus']['cbc-place-ext:ContractFolderStatusCode'] = { '#text': status };
    writeFileSync(join(dump, 'licitaciones', `${id}-${ts}.json`), JSON.stringify(e));
  }
  return dump;
};

const fakeWeb = (xml) => {
  const calls = [];
  return {
    calls,
    fetchText: async (url) => {
      calls.push(url);
      if (url.startsWith('https://ficha/')) return FICHA;
      if (url.includes('DocumentIdParam=cnx')) return xmlOf();
      if (url.includes('DocumentIdParam=cdx')) return xml;
      throw new Error('HTTP 500');
    },
  };
};

test('syncAperturas guarda las aperturas, y no repite fichas ya procesadas ni consulta estados cerrados', async (t) => {
  const dump = dumpWith([
    { id: '10', ts: 1000, status: 'PUB' }, { id: '10', ts: 2000, status: 'EV' }, // solo cuenta la última versión
    { id: '11', ts: 1000, status: 'RES' },
  ]);
  const web = fakeWeb(xmlOf(event('Apertura sobre oferta económica', 4, '2026-10-21', '11:45', 'Salón de Plenos')));
  const store = {};
  const first = await syncAperturas({ dumpDir: dump, store, fetchText: web.fetchText });
  t.is(first.checked, 1);
  t.deepEqual(Object.keys(store), ['10']);
  t.is(store['10'].version, 2000);
  t.is(store['10'].events.length, 1);
  t.is(store['10'].source.name, 'Rectificación de Pliego'); // el anuncio no tenía aperturas: se pasa al siguiente
  t.false(first.changes.get('10').changed);

  const calls = web.calls.length;
  const second = await syncAperturas({ dumpDir: dump, store, fetchText: web.fetchText });
  t.is(second.checked, 0);
  t.is(web.calls.length, calls);
});

test('syncAperturas detecta que una apertura ha cambiado de fecha', async (t) => {
  const dump = dumpWith([{ id: '10', ts: 3000, status: 'PUB' }]);
  const store = {
    10: {
      version: 1000, events: [{
        kind: 4, type: 'Apertura sobre oferta económica', sobre: 'Sobre Único', date: '2026-10-21', time: '11:45', place: 'Salón de Plenos', public: true,
      }],
    },
  };
  const web = fakeWeb(xmlOf(event('Apertura sobre oferta económica', 4, '2026-10-29', '11:15', 'Salón de Plenos')));
  const { changes } = await syncAperturas({ dumpDir: dump, store, fetchText: web.fetchText });
  t.true(changes.get('10').changed);
  t.is(changes.get('10').previous[0].date, '2026-10-21');
  t.is(store['10'].events[0].date, '2026-10-29');
});

test('syncAperturas no se detiene si una ficha falla y la reintenta después', async (t) => {
  const dump = dumpWith([{ id: '10', ts: 1000, status: 'PUB' }, { id: '12', ts: 1000, status: 'EV' }]);
  const logs = [];
  const web = fakeWeb(xmlOf(event('Apertura sobre oferta económica', 4, '2026-10-21', '11:45', 'Salón')));
  const store = {};
  await syncAperturas({
    dumpDir: dump,
    store,
    fetchText: async (url) => { if (url === 'https://ficha/10') throw new Error('HTTP 500'); return web.fetchText(url); },
    log: (m) => logs.push(m),
  });
  t.deepEqual(Object.keys(store), ['12']);
  t.true(logs.some((m) => /Aperturas 10: no se pudo consultar/.test(m)));
});

test('readAperturas y writeAperturas: fichero ausente = vacío, y claves ordenadas', async (t) => {
  const dump = tmpDir();
  t.deepEqual(await readAperturas(dump), {});
  await writeAperturas(dump, { 20: { a: 1 }, 3: { a: 2 } });
  t.deepEqual(Object.keys(await readAperturas(dump)), ['3', '20']);
});

// ---- correo

test('openingsLines indica fecha, lugar y la fecha anterior si se ha movido', (t) => {
  const base = {
    kind: 4, type: 'Apertura sobre oferta económica', sobre: 'S', date: '2026-10-29', time: '11:15', place: 'Salón de Plenos', public: true,
  };
  t.deepEqual(openingsLines(null), []);
  t.deepEqual(openingsLines({ events: [], previous: null }), []);
  t.deepEqual(
    openingsLines({ events: [base], previous: null }),
    ['  Oferta económica: 29/10/2026 11:15 · Salón de Plenos · acto público'],
  );
  t.regex(openingsLines({ events: [base], previous: [{ ...base, date: '2026-10-21', time: '11:45' }] })[0], /\(antes: 21\/10\/2026 11:45\)$/);
  t.notRegex(openingsLines({ events: [base], previous: [base] })[0], /antes/);
  t.regex(openingsLines({ events: [{ ...base, time: null, place: null, public: null }], previous: null })[0], /: 29\/10\/2026$/);
});

test('buildDigest incluye las aperturas del anuncio', (t) => {
  const e = entryFor('Pleno del Ayuntamiento de Aranda de Duero');
  const info = { events: [{ type: 'Apertura sobre administrativo', date: '2026-10-14', time: '11:30', place: 'Salón de Plenos', public: false }], previous: null };
  t.regex(buildDigest([e], () => null, () => info).body, /PRIV · Administrativo: 14\/10\/2026 11:30 · Salón de Plenos · acto no público/);
});

// ---- calendario

const store = {
  10: {
    ref: 'ABR/SUMIN/2026000001',
    title: 'Suministro de material; con "comas", y una línea de título larguísima para comprobar que el plegado de líneas no corta nada',
    link: 'https://contrataciondelestado.es/wps/poc?uri=deeplink:detalle_licitacion&idEvl=abc',
    version: 1000,
    source: { name: 'Pliego', published: '2026-09-29T12:14:09.000Z' },
    events: [
      {
        kind: 2, type: 'Apertura sobre administrativo', sobre: 'Sobre A', date: '2026-10-14', time: '11:30', place: 'Salón de Plenos', address: 'PZ MAYOR, 1', public: true,
      },
      {
        kind: 4, type: 'Apertura sobre oferta económica', sobre: 'Sobre A', date: '2026-10-21', time: '11:30', place: 'Salón de Plenos', address: null, public: true,
      },
      {
        kind: 4, type: 'Apertura sobre oferta económica', sobre: 'Sobre A', date: '2026-10-21', time: '11:45', place: null, address: null, public: null,
      },
      {
        kind: 4, type: 'Apertura sobre oferta económica', sobre: 'Sobre A', date: '2026-01-05', time: '10:00', place: null, address: null, public: null,
      },
    ],
  },
};
const NOW = Date.parse('2026-10-14T00:00:00Z');

test('buildIcs genera un VEVENT por apertura futura, en UTC y con UID estable', (t) => {
  const ics = buildIcs(store, { now: NOW });
  t.true(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  t.true(ics.endsWith('END:VCALENDAR\r\n'));
  t.is((ics.match(/BEGIN:VEVENT/g) ?? []).length, 3); // la de enero ya pasó
  t.regex(ics, /DTSTART:20261014T093000Z\r\nDTEND:20261014T100000Z/);
  t.regex(ics, /UID:10-2-sobre-a@contratacion-estado/);
  // dos aperturas del mismo tipo y sobre: UID distinto
  t.regex(ics, /UID:10-4-sobre-a@contratacion-estado/);
  t.regex(ics, /UID:10-4-sobre-a-1@contratacion-estado/);
  t.regex(ics, /LOCATION:Salón de Plenos · PZ MAYOR\\, 1/);
  t.regex(ics, /SEQUENCE:\d+/);
  // determinista: no depende de cuándo se genera
  t.is(buildIcs(store, { now: NOW }), ics);
});

test('buildIcs escapa el texto y no pasa de 75 octetos por línea', (t) => {
  const ics = buildIcs(store, { now: NOW });
  for (const line of ics.split('\r\n')) t.true(Buffer.byteLength(line) <= 75, line);
  t.regex(ics.replace(/\r\n /g, ''), /Suministro de material\\; con "comas"\\, y una/);
  // el salto de línea de la descripción es un \n escapado
  t.regex(ics.replace(/\r\n /g, ''), /DESCRIPTION:Suministro[^\r]*\\nExpediente: ABR\/SUMIN\/2026000001\\nSobre: Sobre A\\nActo público\\nhttps:/);
});

test('buildIcs con el fichero vacío da un calendario válido sin eventos', (t) => {
  const ics = buildIcs({}, { now: NOW });
  t.notRegex(ics, /VEVENT/);
  t.true(ics.endsWith('END:VCALENDAR\r\n'));
  // sin fecha de publicación del documento usa la versión del anuncio
  t.regex(buildIcs({ 1: { version: 1760400000000, events: [store[10].events[0]] } }, { now: NOW }), /DTSTAMP:20251014T000000Z/);
});

test('shortType quita "Apertura sobre" y deja la primera letra en mayúscula', (t) => {
  t.is(shortType('Apertura sobre oferta económica'), 'Oferta económica');
  t.is(shortType('Apertura sobre administrativo'), 'Administrativo');
  t.is(shortType('Apertura del sobre técnico'), 'Técnico');
  t.is(shortType('Apertura'), 'Apertura');
  t.is(shortType(undefined), 'Apertura');
});

test('buildIcs: el título usa la etiqueta corta y los actos privados empiezan por PRIV', (t) => {
  const ics = buildIcs({
    10: {
      ref: 'X', title: 'Servicio de limpieza', version: 1000,
      events: [
        { kind: 4, type: 'Apertura sobre oferta económica', sobre: 'A', date: '2026-10-21', time: '11:30', public: true },
        { kind: 2, type: 'Apertura sobre administrativo', sobre: 'B', date: '2026-10-14', time: '11:30', public: false },
        { kind: 3, type: 'Apertura sobre oferta técnica', sobre: 'C', date: '2026-10-14', time: '11:45', public: null },
      ],
    },
  }, { now: NOW });
  t.regex(ics, /SUMMARY:Oferta económica: Servicio de limpieza\r\n/);
  t.regex(ics, /SUMMARY:PRIV · Administrativo: Servicio de limpieza\r\n/);
  t.regex(ics, /SUMMARY:Oferta técnica: Servicio de limpieza\r\n/);
  t.notRegex(ics, /SUMMARY:Apertura/);
});

test('buildRecords añade las aperturas a la ficha de la licitación', (t) => {
  const dump = tmpDir();
  cpSync(join(FIXTURES_DUMP, 'licitaciones'), join(dump, 'licitaciones'), { recursive: true });
  cpSync(join(FIXTURES_DUMP, 'menores'), join(dump, 'menores'), { recursive: true });
  const base = buildRecords(dump).details;
  t.is(base.items['l-1007341'].openings, undefined);

  writeFileSync(join(dump, 'aperturas.json'), JSON.stringify({
    1007341: {
      events: [{
        kind: 4, type: 'Apertura sobre oferta económica', sobre: 'Sobre Único', date: '2026-10-21', time: '11:45', place: 'Salón de Plenos', address: 'PZ MAYOR, 1', public: true,
      }],
    },
    1007343: { events: [] },
    999: { events: [{ type: 'x', date: '2026-01-01' }] }, // anuncio que ya no está en el dump
  }));
  const { items } = buildRecords(dump).details;
  t.deepEqual(items['l-1007341'].openings, [{
    type: 'Apertura sobre oferta económica', sobre: 'Sobre Único', date: '2026-10-21', time: '11:45', place: 'Salón de Plenos', address: 'PZ MAYOR, 1', public: true,
  }]);
  t.is(items['l-1007343'].openings, undefined);
  t.is(items['l-999'], undefined);
});
