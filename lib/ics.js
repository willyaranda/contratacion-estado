// Calendario iCalendar (.ics) con las aperturas de ofertas de los últimos 60 días y las futuras. El histórico
// completo queda en dump/aperturas.json. El resto del contenido solo depende de ese fichero, así que el .ics solo
// cambia cuando cambian las aperturas o una sale de la ventana (el commit nocturno no genera ruido).
import { eventStartMs } from './aperturas.js';
import { shortType } from './aperturas-text.js';

// Aperturas pasadas que se siguen incluyendo
const PAST_DAYS = 60;

// Duración orientativa: la Plataforma da la hora de inicio, no la de fin.
const DURATION_MS = 30 * 60 * 1000;

const utc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const escapeText = (s) => `${s}`.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Líneas de más de 75 octetos se parten (RFC 5545 §3.1), sin cortar un carácter multibyte.
const fold = (line) => {
  const out = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const bytes = Buffer.byteLength(ch);
    if (size + bytes > (out.length === 0 ? 75 : 74)) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += bytes;
  }
  out.push(current);
  return out.map((part, i) => (i === 0 ? part : ` ${part}`)).join('\r\n');
};

const slug = (s) => `${s ?? ''}`.normalize('NFD').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40);

export const buildIcs = (store, { now = Date.now(), tenders = [] } = {}) => {
  const since = now - PAST_DAYS * 24 * 3600 * 1000;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//contratacion-estado//Contratación//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Contratación Ayuntamiento Aranda de Duero',
    'X-WR-TIMEZONE:Europe/Madrid',
  ];

  for (const [id, record] of Object.entries(store)) {
    const stamp = Date.parse(record.source?.published ?? '') || record.version;
    const ordinals = new Map();
    for (const event of record.events ?? []) {
      const key = `${event.kind ?? 'x'}-${slug(event.sobre)}`;
      const ordinal = ordinals.get(key) ?? 0;
      ordinals.set(key, ordinal + 1);
      const start = eventStartMs(event);
      if (start < since) continue;
      const where = [event.place, event.address].filter(Boolean).join(' · ');
      const description = [
        record.title,
        record.ref ? `Expediente: ${record.ref}` : null,
        event.sobre ? `Sobre: ${event.sobre}` : null,
        event.public === null ? null : `Acto ${event.public ? 'público' : 'no público'}`,
        record.link,
      ].filter(Boolean).join('\n');
      lines.push(
        'BEGIN:VEVENT',
        // mismo UID al rectificarse la fecha: el cliente de calendario actualiza el evento en vez de duplicarlo
        `UID:${id}-${key}${ordinal > 0 ? `-${ordinal}` : ''}@contratacion-estado`,
        `DTSTAMP:${utc(stamp)}`,
        `LAST-MODIFIED:${utc(stamp)}`,
        // número creciente con cada versión publicada (segundos desde 1970 caben en 32 bits hasta 2038)
        `SEQUENCE:${Math.floor(stamp / 1000)}`,
        `DTSTART:${utc(start)}`,
        `DTEND:${utc(start + DURATION_MS)}`,
        `SUMMARY:${escapeText(`${event.public === false ? 'PRIV · ' : ''}${shortType(event.type)}: ${record.title ?? record.ref ?? id}`)}`,
        ...(where ? [`LOCATION:${escapeText(where)}`] : []),
        `DESCRIPTION:${escapeText(description)}`,
        ...(record.link ? [`URL:${record.link}`] : []),
        'END:VEVENT',
      );
    }
  }

  // Licitaciones: día de publicación (PUB) y último día del plazo de ofertas (ULT. DÍA), como eventos de día completo.
  const day = (iso) => iso.replace(/-/g, '');
  const nextDay = (iso) => day(new Date(Date.parse(`${iso}T00:00:00Z`) + 24 * 3600 * 1000).toISOString().slice(0, 10));
  const sinceDay = new Date(since).toISOString().slice(0, 10);
  for (const tender of tenders) {
    const stamp = Date.parse(tender.updated ?? '') || since;
    const name = tender.title || tender.folder || tender.id;
    const description = [
      tender.title,
      tender.folder ? `Expediente: ${tender.folder}` : null,
      tender.published ? `Publicada: ${tender.published}` : null,
      tender.deadline ? `Fin del plazo de ofertas: ${tender.deadline}${tender.deadlineTime ? ` ${tender.deadlineTime}` : ''}` : null,
      tender.url,
    ].filter(Boolean).join('\n');
    const marks = [
      ['pub', tender.published, `PUB: ${name}`],
      // el plazo suele acabar a las 23:59; si no, la hora va en el título
      ['ult', tender.deadline, `ULT. DÍA${tender.deadlineTime && tender.deadlineTime !== '23:59' ? ` (${tender.deadlineTime})` : ''}: ${name}`],
    ];
    for (const [kind, date, summary] of marks) {
      if (!date || date < sinceDay) continue;
      lines.push(
        'BEGIN:VEVENT',
        `UID:${tender.id}-${kind}@contratacion-estado`,
        `DTSTAMP:${utc(stamp)}`,
        `LAST-MODIFIED:${utc(stamp)}`,
        `SEQUENCE:${Math.floor(stamp / 1000)}`,
        `DTSTART;VALUE=DATE:${day(date)}`,
        `DTEND;VALUE=DATE:${nextDay(date)}`,
        `SUMMARY:${escapeText(summary)}`,
        `DESCRIPTION:${escapeText(description)}`,
        ...(tender.url ? [`URL:${tender.url}`] : []),
        'END:VEVENT',
      );
    }
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
};
