// Calendario iCalendar (.ics) de contratación. Lleva dos tipos de eventos:
//   - Aperturas de ofertas (de dump/aperturas.json) de los últimos 60 días y las futuras; el histórico completo
//     queda en ese fichero.
//   - Licitaciones y contratos menores como eventos de día completo: PUB (publicación), ULT. DÍA (fin del plazo de
//     ofertas), ADJ / ADJ. MENOR (adjudicación) y AVISO FIN (fin previsto del contrato), también de los últimos 60 días
//     en adelante.
// El contenido solo depende de esos datos, así que el .ics solo cambia cuando cambian ellos o algo sale de la
// ventana (el commit nocturno no genera ruido).
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

// Fin previsto del contrato: el de la ficha si lo trae; si no, inicio previsto (o adjudicación) + duración en meses.
const contractEndDay = (tender) => {
  if (tender.plannedEnd) return { date: tender.plannedEnd, estimated: false };
  const from = tender.plannedStart || tender.awardDate;
  if (!from || !tender.durationMonths) return null;
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + tender.durationMonths);
  return { date: d.toISOString().slice(0, 10), estimated: true };
};

const HEADER = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//contratacion-estado//Contratación//ES',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  'X-WR-CALNAME:Contratación Ayuntamiento Aranda de Duero',
  'X-WR-TIMEZONE:Europe/Madrid',
];

const toIcs = (lines) => `${lines.map(fold).join('\r\n')}\r\n`;

// Cada apertura del store con su clave y ordinal (para el UID estable). Es la única fuente de eventos de apertura:
// la usan el calendario completo y las mesas de la página.
export function* storeEvents(store) {
  for (const [id, record] of Object.entries(store)) {
    const ordinals = new Map();
    for (const event of record.events ?? []) {
      const key = `${event.kind ?? 'x'}-${slug(event.sobre)}`;
      const ordinal = ordinals.get(key) ?? 0;
      ordinals.set(key, ordinal + 1);
      yield { id, record, event, key, ordinal };
    }
  }
}

// Campos de una mesa de contratación (apertura de ofertas): los mismos para el calendario .ics y para la página.
export const mesaFields = ({
  id, record, event, key, ordinal,
}) => {
  const stamp = Date.parse(record.source?.published ?? '') || record.version;
  const start = eventStartMs(event);
  return {
    // mismo UID al rectificarse la fecha: el cliente de calendario actualiza el evento en vez de duplicarlo
    uid: `${id}-${key}${ordinal > 0 ? `-${ordinal}` : ''}@contratacion-estado`,
    stamp,
    startMs: start,
    endMs: start + DURATION_MS,
    type: shortType(event.type),
    title: record.title ?? record.ref ?? id,
    public: event.public ?? null,
    summary: `${event.public === false ? 'PRIV · ' : ''}${shortType(event.type)}: ${record.title ?? record.ref ?? id}`,
    place: event.place ?? null,
    address: event.address ?? null,
    location: [event.place, event.address].filter(Boolean).join(' · '),
    description: [
      record.title,
      record.ref ? `Expediente: ${record.ref}` : null,
      event.sobre ? `Sobre: ${event.sobre}` : null,
      event.public === null ? null : `Acto ${event.public ? 'público' : 'no público'}`,
      record.link,
    ].filter(Boolean).join('\n'),
    link: record.link ?? null,
  };
};

// Líneas VEVENT de una mesa (sin plegar).
export const mesaVevent = (m) => [
  'BEGIN:VEVENT',
  `UID:${m.uid}`,
  `DTSTAMP:${utc(m.stamp)}`,
  `LAST-MODIFIED:${utc(m.stamp)}`,
  // número creciente con cada versión publicada (segundos desde 1970 caben en 32 bits hasta 2038)
  `SEQUENCE:${Math.floor(m.stamp / 1000)}`,
  `DTSTART:${utc(m.startMs)}`,
  `DTEND:${utc(m.endMs)}`,
  `SUMMARY:${escapeText(m.summary)}`,
  ...(m.location ? [`LOCATION:${escapeText(m.location)}`] : []),
  `DESCRIPTION:${escapeText(m.description)}`,
  ...(m.link ? [`URL:${m.link}`] : []),
  'END:VEVENT',
];

// .ics de UNA sola mesa (para añadirla a un calendario por separado): mismas líneas, escape y plegado que el calendario.
export const mesaIcs = (m) => toIcs([...HEADER, ...mesaVevent(m), 'END:VCALENDAR']);

// Mesas con inicio desde `sinceMs` (ya con el .ics de cada una), ordenadas por fecha. Es lo que embebe la página.
export const upcomingMesas = (store, sinceMs) => [...storeEvents(store)]
  .map(mesaFields)
  .filter((m) => m.startMs >= sinceMs)
  .sort((x, y) => x.startMs - y.startMs || x.uid.localeCompare(y.uid))
  .map((m) => ({
    uid: m.uid,
    summary: m.summary,
    type: m.type,
    title: m.title,
    public: m.public,
    start: m.startMs,
    end: m.endMs,
    place: m.place,
    address: m.address,
    location: m.location,
    description: m.description,
    link: m.link,
    ics: mesaIcs(m),
  }));

export const buildIcs = (store, { now = Date.now(), tenders = [] } = {}) => {
  const since = now - PAST_DAYS * 24 * 3600 * 1000;
  const lines = [...HEADER];

  for (const item of storeEvents(store)) {
    const m = mesaFields(item);
    if (m.startMs < since) continue;
    lines.push(...mesaVevent(m));
  }

  // Licitaciones y contratos menores como eventos de día completo: PUB (publicación), ULT. DÍA (fin del plazo de
  // ofertas), ADJ / ADJ. MENOR (adjudicación) y AVISO FIN (fin previsto del contrato). Los que son plazos llevan una
  // alarma a las 9:00 del día anterior.
  const day = (iso) => iso.replace(/-/g, '');
  const nextDay = (iso) => day(new Date(Date.parse(`${iso}T00:00:00Z`) + 24 * 3600 * 1000).toISOString().slice(0, 10));
  const sinceDay = new Date(since).toISOString().slice(0, 10);
  for (const tender of tenders) {
    const stamp = Date.parse(tender.updated ?? '') || since;
    const name = tender.title || tender.folder || tender.id;
    const awarded = tender.outcome === 'adjudicado' && tender.awardDate;
    const contractEnd = awarded ? contractEndDay(tender) : null;
    const description = [
      tender.title,
      tender.folder ? `Expediente: ${tender.folder}` : null,
      tender.published ? `Publicada: ${tender.published}` : null,
      tender.deadline ? `Fin del plazo de ofertas: ${tender.deadline}${tender.deadlineTime ? ` ${tender.deadlineTime}` : ''}` : null,
      awarded ? `Adjudicada el ${tender.awardDate}${tender.winners?.length ? ` a ${tender.winners.map((w) => w.name).join(', ')}` : ''}` : null,
      contractEnd ? `Fin previsto del contrato: ${contractEnd.date}${contractEnd.estimated ? ' (estimado: adjudicación + duración)' : ''}` : null,
      tender.url,
    ].filter(Boolean).join('\n');
    const isMenor = tender.kind === 'menor';
    const marks = [
      ['pub', isMenor ? null : tender.published, `PUB: ${name}`, false],
      // el plazo suele acabar a las 23:59; si no, la hora va en el título
      ['ult', isMenor ? null : tender.deadline, `ULT. DÍA${tender.deadlineTime && tender.deadlineTime !== '23:59' ? ` (${tender.deadlineTime})` : ''}: ${name}`, true],
      ['adj', awarded ? tender.awardDate : null, `${isMenor ? 'ADJ. MENOR' : 'ADJ'}: ${name}`, false],
      ['fin', contractEnd?.date, `AVISO FIN: ${name}`, true],
    ];
    for (const [kind, date, summary, alarm] of marks) {
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
        ...(alarm ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(summary)}`, 'TRIGGER:-PT15H', 'END:VALARM'] : []),
        'END:VEVENT',
      );
    }
  }

  lines.push('END:VCALENDAR');
  return toIcs(lines);
};
