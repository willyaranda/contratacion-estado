// Aperturas de ofertas (sobres administrativo, técnico y económico) de las licitaciones en curso.
//
// El feed Atom no trae la fecha de apertura. Sí la trae la ficha web de cada licitación: los documentos "Anuncio de
// Licitación" y "Pliego" (y sus "Rectificación de ...") los genera la Plataforma en HTML, XML y PDF, y el XML incluye
// un bloque `OpenTenderEvent` por apertura (fecha, hora, lugar y si el acto es público).
//
// Se guarda en dump/aperturas.json, indexado por id del anuncio, y solo se consulta la web de los anuncios cuya
// última versión del feed todavía no se ha procesado (en cualquier estado: también interesa el histórico).
import { XMLParser } from 'fast-xml-parser';
import { readFile, readdir, writeFile } from 'fs/promises';
import { join } from 'path';

import { asArray, isPresent, text } from './ayuntamiento.js';
import { statusOf } from './changes.js';

export const APERTURAS_FILE = 'aperturas.json';
// Documentos de la ficha donde la Plataforma publica las aperturas (de más reciente a más antiguo se prueban pocos)
const NOTICE_NAME = /licitaci[oó]n|pliego/i;
const MAX_DOCS_TRIED = 4;

// ---------- Zona horaria: la Plataforma da hora local de España ----------

const MADRID = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Madrid', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

const offsetMs = (utcMs) => {
  const p = Object.fromEntries(MADRID.formatToParts(utcMs).map((part) => [part.type, part.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(utcMs / 1000) * 1000;
};

// Instante (ms UTC) de una fecha y hora locales de Madrid.
export const madridToUtcMs = (year, month, day, hour = 0, minute = 0, second = 0) => {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  return guess - offsetMs(guess - offsetMs(guess));
};

// ---------- Ficha web ----------

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};
export const decodeEntities = (s) => s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (m, dec, hex, name) => {
  if (dec) return String.fromCodePoint(Number(dec));
  if (hex) return String.fromCodePoint(parseInt(hex, 16));
  return NAMED[name.toLowerCase()] ?? m;
});

const plain = (html) => decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Filas de la tabla de documentos de la ficha: nombre, fecha de publicación (ms) y enlace al XML del documento.
// Cada documento generado por la Plataforma trae tres enlaces, en este orden: HTML, XML y PDF.
export const parseDocuments = (html) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].flatMap(([, row]) => {
  const hrefs = [...row.matchAll(/href="([^"]*GetDocumentByIdServlet[^"]*)"/g)].map((m) => decodeEntities(m[1]));
  if (hrefs.length === 0) return [];
  const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => plain(c[1])).filter(Boolean);
  const stamp = cells.map((c) => /^(\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d):(\d\d)/.exec(c)).find(Boolean);
  const name = cells.find((c) => !/^\d\d\/\d\d\/\d{4}/.test(c));
  if (!stamp || !name) return [];
  const [, d, mo, y, h, mi, s] = stamp.map(Number);
  return [{
    name,
    published: madridToUtcMs(y, mo, d, h, mi, s),
    xml: hrefs.length === 3 ? hrefs[1] : null,
  }];
});

// ---------- XML del documento ----------

const parser = new XMLParser({ ignoreAttributes: false });

const findAll = (node, key, found = []) => {
  if (Array.isArray(node)) {
    node.forEach((item) => findAll(item, key, found));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) found.push(...asArray(v));
      else findAll(v, key, found);
    }
  }
  return found;
};

const clean = (value) => {
  const v = text(value);
  const compact = isPresent(v) ? `${v}`.replace(/\s+/g, ' ').trim() : '';
  return compact === '' ? null : compact;
};

const toEvent = (e) => {
  const date = /^(\d{4}-\d\d-\d\d)/.exec(clean(e['cbc:OccurrenceDate']) ?? '')?.[1];
  if (!date) return null;
  const typeCode = e['cbc:TypeCode'];
  const location = asArray(e['cac:OccurrenceLocation'])[0] ?? {};
  const address = asArray(location['cac:Address'])[0] ?? {};
  const line = clean(asArray(address['cac:AddressLine'])[0]?.['cbc:Line']);
  const city = clean(address['cbc:CityName']);
  const restriction = asArray(e['cac:AttendanceConditions'])[0]?.['cbc:AttendanceRestrictionCode'];
  const mode = restriction?.['@_name'];
  return {
    kind: typeCode?.['#text'] ?? null,
    type: typeCode?.['@_name'] ?? 'Apertura',
    sobre: clean(e['cbc:IdentificationID']),
    date,
    time: (clean(e['cbc:OccurrenceTime']) ?? '').slice(0, 5) || null,
    place: clean(location['cbc:Description']),
    address: [line, city].filter(Boolean).join(', ') || null,
    public: mode ? /p[uú]blic/i.test(mode) : null,
  };
};

// Aperturas del XML de un anuncio o pliego, ordenadas por fecha y hora.
export const parseEvents = (xml) => findAll(parser.parse(xml), 'cac:OpenTenderEvent')
  .map(toEvent)
  .filter(Boolean)
  .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));

// Instante de inicio de una apertura (ms UTC).
export const eventStartMs = (event) => {
  const [y, mo, d] = event.date.split('-').map(Number);
  const [h, mi] = (event.time ?? '00:00').split(':').map(Number);
  return madridToUtcMs(y, mo, d, h, mi);
};

// ---------- Fichero dump/aperturas.json ----------

export const readAperturas = async (dumpDir) => {
  try {
    return JSON.parse(await readFile(join(dumpDir, APERTURAS_FILE), 'utf8'));
  } catch {
    return {};
  }
};

// Claves ordenadas: el fichero solo cambia si cambia su contenido.
export const writeAperturas = async (dumpDir, store) => {
  const sorted = Object.fromEntries(Object.keys(store).sort((a, b) => Number(a) - Number(b)).map((k) => [k, store[k]]));
  await writeFile(join(dumpDir, APERTURAS_FILE), `${JSON.stringify(sorted, null, 2)}\n`);
};

// ---------- Sincronización ----------

// Última versión guardada de cada anuncio de una carpeta: id -> { ts, file }
export const latestVersions = async (dir) => {
  const latest = new Map();
  for (const file of await readdir(dir)) {
    const m = /^(\d+)-(\d+)\.json$/.exec(file);
    if (m && (!latest.has(m[1]) || Number(m[2]) > latest.get(m[1]).ts)) latest.set(m[1], { ts: Number(m[2]), file });
  }
  return latest;
};

const sameEvents = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

// Busca las aperturas de los anuncios cuya última versión no está procesada y actualiza `store`.
// Un fallo en una ficha no detiene a las demás: se reintenta en la siguiente ejecución.
// `accept(id)` limita el trabajo a una parte de los anuncios (para repartir un barrido entre varios procesos).
// `onUpdate` se invoca (en serie) tras cada ficha procesada: sirve para guardar el progreso en el primer barrido,
// que recorre todo el histórico y tarda.
// Devuelve `changes`: id -> { previous, current } de los anuncios cuyas aperturas se han consultado.
export const syncAperturas = async ({
  dumpDir, store, fetchText, sfx = 'licitaciones', concurrency = 3, accept = () => true, onUpdate = async () => {}, log = () => {},
}) => {
  const dir = join(dumpDir, sfx);
  const pending = [];
  for (const [id, { ts, file }] of await latestVersions(dir)) {
    if (accept(id) && store[id]?.version !== ts) {
      pending.push({ id, ts, entry: JSON.parse(await readFile(join(dir, file), 'utf8')) });
    }
  }

  const changes = new Map();
  let saving = Promise.resolve();
  const lookup = async ({ id, ts, entry }) => {
    const link = entry.link?.['@_href'];
    let events = [];
    let source = null;
    if (link) {
      const docs = parseDocuments(await fetchText(link))
        .filter((d) => d.xml && NOTICE_NAME.test(d.name))
        .sort((a, b) => b.published - a.published)
        .slice(0, MAX_DOCS_TRIED);
      for (const doc of docs) {
        const found = parseEvents(await fetchText(doc.xml));
        if (found.length > 0) {
          events = found;
          source = { name: doc.name, published: new Date(doc.published).toISOString() };
          break;
        }
      }
    }
    const previous = store[id]?.events ?? null;
    store[id] = {
      ref: text(entry['cac-place-ext:ContractFolderStatus']?.['cbc:ContractFolderID']) ?? null,
      title: entry.title ?? null,
      link: link ?? null,
      status: statusOf(entry),
      version: ts,
      source,
      events,
    };
    changes.set(id, { previous, current: events, changed: previous !== null && !sameEvents(previous, events) });
    log(`Aperturas ${id}: ${events.length} evento(s) (${pending.length - changes.size} pendientes)`);
    saving = saving.then(onUpdate);
    await saving;
  };

  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (next < pending.length) {
      const item = pending[next];
      next += 1;
      try {
        await lookup(item);
      } catch (error) {
        log(`Aperturas ${item.id}: no se pudo consultar (${error.message}); se reintentará.`);
      }
    }
  }));

  return { changes, checked: pending.length };
};
