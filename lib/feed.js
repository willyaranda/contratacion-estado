// Feeds de licitaciones nuevas y adjudicaciones: feed.xml (Atom 1.0) y rss.xml (RSS 2.0) con el mismo contenido.
// Alternativa abierta al aviso por correo. Todo son funciones puras derivadas de los registros de buildRecords y de
// `generated` (la fecha de los datos): nada de reloj, así que el mismo input da el mismo fichero byte a byte.
//
// Una entrada por (contrato, tipo de evento):
//   - licitacion:   "Nueva licitación" (licitaciones, fecha = published)
//   - adjudicacion: "Adjudicación" (licitaciones adjudicadas, fecha = awardDate)
//   - menor:        "Contrato menor adjudicado" (contratos menores adjudicados, fecha = awardDate)
// Solo las de los últimos WINDOW_DAYS días respecto a `generated`, como máximo MAX_ENTRIES, de más nueva a más antigua.
//
// Id de entrada (estable entre rebuilds): `tag:<host de SITE_URL>,<año del evento>:<id del registro>-<tipo>`, p. ej.
// `tag:willyaranda.github.io,2026:l-20416552-adjudicacion`. Solo depende del contrato, del tipo y de la fecha del evento
// (RFC 4151). Si cambia SITE_URL (transferencia del repositorio) cambian todos los ids: los lectores verán entradas
// nuevas una vez. El id del feed Atom es su propia URL.
import { SITE_URL } from '../transparencia/site.js';

export const WINDOW_DAYS = 90;
export const MAX_ENTRIES = 200;
export const FEED_FILE = 'feed.xml';
export const RSS_FILE = 'rss.xml';
export const FEED_TITLE = 'Contratación del Ayuntamiento de Aranda de Duero · Licitaciones y adjudicaciones';
export const FEED_SUBTITLE = 'Nuevas licitaciones, adjudicaciones y contratos menores adjudicados del Ayuntamiento de Aranda de Duero, según la Plataforma de Contratación del Sector Público.';
const AUTHOR = 'Ayuntamiento de Aranda de Duero';
const GENERATOR = 'contratacion-estado (lib/feed.js)';

const DAY_MS = 24 * 3600 * 1000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Caracteres no válidos en XML 1.0 (controles salvo \t \n \r, sustitutos sueltos, U+FFFE/U+FFFF): se eliminan.
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export const xmlEscape = (s) => `${s ?? ''}`
  .replace(INVALID_XML, '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

// Día ISO (YYYY-MM-DD) válido, o null.
const isoDay = (value) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(`${value ?? ''}`);
  if (!m) return null;
  const ms = Date.parse(`${m[0]}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== m[0] ? null : m[0];
};

const rfc3339 = (day) => `${day}T00:00:00Z`;

const rfc822 = (day) => {
  const d = new Date(Date.parse(rfc3339(day)));
  const pad = (n) => `${n}`.padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} 00:00:00 +0000`;
};

const money = (n) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}${int.replace(/\B(?=(\d{3})+$)/g, '.')},${dec} €`;
};

const TYPES = {
  licitacion: { label: 'Nueva licitación', term: 'licitacion' },
  adjudicacion: { label: 'Adjudicación', term: 'adjudicacion' },
  menor: { label: 'Contrato menor adjudicado', term: 'menor' },
};

const uniqueWinners = (record) => {
  const seen = new Set();
  const names = [];
  for (const w of record.winners ?? []) {
    const name = `${w?.name ?? ''}`.trim();
    const key = w?.nif || name;
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
};

const eventsOf = (record) => {
  const out = [];
  const adjudicado = record.outcome === 'adjudicado';
  if (record.kind === 'licitacion') {
    out.push({ type: 'licitacion', date: isoDay(record.published) });
    if (adjudicado) out.push({ type: 'adjudicacion', date: isoDay(record.awardDate) });
  } else if (record.kind === 'menor' && adjudicado) {
    out.push({ type: 'menor', date: isoDay(record.awardDate) });
  }
  return out.filter((e) => e.date);
};

const summaryOf = (record, type) => {
  const lines = [];
  if (record.buyer) lines.push(`Órgano de contratación: ${record.buyer}.`);
  const budget = money(record.budgetNet);
  if (budget) lines.push(`Presupuesto base de licitación sin IVA: ${budget}.`);
  if (type === 'licitacion') {
    const day = isoDay(record.deadline);
    if (day) {
      const [y, m, d] = day.split('-');
      lines.push(`Plazo de presentación de ofertas: hasta el ${d}/${m}/${y}${record.deadlineTime ? ` a las ${record.deadlineTime}` : ''}.`);
    }
  } else {
    const winners = uniqueWinners(record);
    if (winners.length) lines.push(`Adjudicatario: ${winners.join('; ')}.`);
    const amount = money(record.awardedNet);
    if (amount) lines.push(`Importe de adjudicación sin IVA: ${amount}.`);
  }
  if (record.folder) lines.push(`Expediente: ${record.folder}.`);
  return lines.join('\n');
};

// Entradas del feed, ya filtradas, ordenadas y recortadas. `generated` es la fecha de los datos (ISO).
export const feedEntries = (records, generated, { siteUrl = SITE_URL } = {}) => {
  const genDay = isoDay(generated);
  if (!genDay) return [];
  const cutoff = new Date(Date.parse(rfc3339(genDay)) - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  const host = new URL(siteUrl).hostname;
  const entries = [];
  for (const record of records ?? []) {
    if (!record?.id) continue;
    for (const { type, date } of eventsOf(record)) {
      if (date < cutoff) continue;
      const { label, term } = TYPES[type];
      const winners = uniqueWinners(record);
      const title = type === 'licitacion'
        ? `${label}: ${record.title}`
        : `${label}: ${record.title}${winners.length ? ` — ${winners.join('; ')}` : ''}`;
      entries.push({
        id: `tag:${host},${date.slice(0, 4)}:${record.id}-${type}`,
        type,
        term,
        title,
        url: record.url || null,
        date,
        summary: summaryOf(record, type),
      });
    }
  }
  const byKey = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  entries.sort((a, b) => (a.date === b.date ? byKey(a, b) : a.date < b.date ? 1 : -1));
  return entries.slice(0, MAX_ENTRIES);
};

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>\n';

export const buildAtom = (records, generated, { siteUrl = SITE_URL } = {}) => {
  const entries = feedEntries(records, generated, { siteUrl });
  const updated = entries[0]?.date ?? isoDay(generated);
  const self = `${siteUrl}${FEED_FILE}`;
  const out = [
    XML_DECL.trimEnd(),
    '<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="es">',
    `  <id>${xmlEscape(self)}</id>`,
    `  <title>${xmlEscape(FEED_TITLE)}</title>`,
    `  <subtitle>${xmlEscape(FEED_SUBTITLE)}</subtitle>`,
    `  <link rel="self" type="application/atom+xml" href="${xmlEscape(self)}"/>`,
    `  <link rel="alternate" type="text/html" href="${xmlEscape(siteUrl)}"/>`,
    ...(updated ? [`  <updated>${rfc3339(updated)}</updated>`] : []),
    `  <author><name>${xmlEscape(AUTHOR)}</name></author>`,
    `  <generator>${xmlEscape(GENERATOR)}</generator>`,
  ];
  for (const e of entries) {
    out.push(
      '  <entry>',
      `    <id>${xmlEscape(e.id)}</id>`,
      `    <title>${xmlEscape(e.title)}</title>`,
      ...(e.url ? [`    <link rel="alternate" type="text/html" href="${xmlEscape(e.url)}"/>`] : []),
      `    <published>${rfc3339(e.date)}</published>`,
      `    <updated>${rfc3339(e.date)}</updated>`,
      `    <category term="${e.term}" label="${xmlEscape(TYPES[e.type].label)}"/>`,
      `    <summary type="text">${xmlEscape(e.summary)}</summary>`,
      `    <content type="text">${xmlEscape(e.summary)}</content>`,
      '  </entry>',
    );
  }
  out.push('</feed>');
  return `${out.join('\n')}\n`;
};

export const buildRss = (records, generated, { siteUrl = SITE_URL } = {}) => {
  const entries = feedEntries(records, generated, { siteUrl });
  const updated = entries[0]?.date ?? isoDay(generated);
  const self = `${siteUrl}${RSS_FILE}`;
  const out = [
    XML_DECL.trimEnd(),
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${xmlEscape(FEED_TITLE)}</title>`,
    `    <link>${xmlEscape(siteUrl)}</link>`,
    `    <description>${xmlEscape(FEED_SUBTITLE)}</description>`,
    '    <language>es</language>',
    ...(updated ? [`    <lastBuildDate>${rfc822(updated)}</lastBuildDate>`] : []),
    `    <generator>${xmlEscape(GENERATOR)}</generator>`,
    `    <atom:link href="${xmlEscape(self)}" rel="self" type="application/rss+xml"/>`,
  ];
  for (const e of entries) {
    out.push(
      '    <item>',
      `      <title>${xmlEscape(e.title)}</title>`,
      ...(e.url ? [`      <link>${xmlEscape(e.url)}</link>`] : []),
      `      <guid isPermaLink="false">${xmlEscape(e.id)}</guid>`,
      `      <pubDate>${rfc822(e.date)}</pubDate>`,
      `      <category>${e.term}</category>`,
      `      <description>${xmlEscape(e.summary)}</description>`,
      '    </item>',
    );
  }
  out.push('  </channel>', '</rss>');
  return `${out.join('\n')}\n`;
};
