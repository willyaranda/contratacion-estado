// Aviso por email (Amazon SES) cuando hay anuncios nuevos.
//
// Se configura solo con variables de entorno (en GitHub: NOTIFY_TO es una variable del repositorio y las credenciales
// de AWS son secrets; nunca ficheros versionados):
//   SEND_EMAILS=1               activa el aviso (si no está, no se envía nada)
//   NOTIFY_TO                   destinatarios separados por comas; se envían siempre en CCO
//   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   credenciales de AWS (las lee el SDK directamente del entorno)
//   AWS_REGION                  opcional, por defecto eu-west-1
//   MAIL_FROM                   opcional, remitente verificado en SES
//
// Ninguno de los mensajes de error ni de log de este módulo incluye valores de credenciales ni direcciones de
// correo: en un repositorio público los logs de Actions lo son también.
import { SendEmailCommand } from '@aws-sdk/client-ses';

import { contractingPartyName } from './ayuntamiento.js';
import { describeChange } from './changes.js';
import {
  dmyDate, openingRows, openingsLines, shortType,
} from './aperturas-text.js';
import { recordFromEntry } from '../transparencia/extract.js';
import { PRIVACY_URL, SITE_URL } from '../transparencia/site.js';

export const DEFAULT_FROM = 'no-reply@arandadeduero.dev';
export const DEFAULT_REGION = 'eu-west-1';
// SES admite como máximo 50 destinatarios por mensaje
export const MAX_RECIPIENTS_PER_MESSAGE = 50;
// Tope de anuncios listados en el cuerpo del correo (el resto se resume en una línea)
export const MAX_ENTRIES_IN_BODY = 100;

const EMAIL = /^[^\s@,;<>"()[\]]+@[^\s@,;<>"()[\]]+\.[^\s@,;<>"()[\]]+$/;

// "a@b.com, c@d.com" -> ['a@b.com', 'c@d.com']. Lanza un error si la lista no es correcta.
export const parseRecipients = (value) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('NOTIFY_TO está vacía o no definida: indica los destinatarios separados por comas.');
  }

  const items = value.split(',').map((item) => item.trim());
  const position = (predicate) => items.flatMap((item, i) => (predicate(item) ? [i + 1] : []));

  const empty = position((item) => item === '');
  if (empty.length > 0) {
    throw new Error(`NOTIFY_TO tiene elementos vacíos en las posiciones ${empty.join(', ')} (¿coma de más?).`);
  }

  const invalid = position((item) => !EMAIL.test(item));
  if (invalid.length > 0) {
    throw new Error(`NOTIFY_TO tiene direcciones no válidas en las posiciones ${invalid.join(', ')}; deben ir separadas por comas.`);
  }

  // sin repetidos (sin distinguir mayúsculas), conservando el orden y la primera aparición de cada dirección
  const seen = new Set();
  return items.filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// Lee la configuración del entorno. Si el aviso está activado y algo falta o es incorrecto, lanza un error:
// el job debe fallar, no seguir sin enviar.
export const loadMailConfig = (env) => {
  if (env.SEND_EMAILS !== '1') {
    return { enabled: false };
  }

  const recipients = parseRecipients(env.NOTIFY_TO);

  const missing = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Faltan credenciales de AWS en el entorno: ${missing.join(', ')}.`);
  }

  const from = env.MAIL_FROM || DEFAULT_FROM;
  if (!EMAIL.test(from)) {
    throw new Error('MAIL_FROM no es una dirección de correo válida.');
  }

  return {
    enabled: true,
    recipients,
    from,
    region: env.AWS_REGION || DEFAULT_REGION,
  };
};

const chunk = (list, size) => {
  const parts = [];
  for (let i = 0; i < list.length; i += size) parts.push(list.slice(i, i + size));
  return parts;
};

const MAX_DOCS_LISTED = 5;
const MAX_WINNERS_LISTED = 3;
const MAX_SUMMARY_LENGTH = 90; // del resumen del asunto (el asunto completo queda por debajo de 120)
const LOGO_URL = `${SITE_URL}images/correo-logo.png`;

// Estados de la Plataforma (lista cerrada) -> nombre y tono de la etiqueta (los mismos colores que la página).
export const STATUS = {
  PUB: 'Publicada', EV: 'En evaluación', ADJ: 'Adjudicada', RES: 'Resuelta', ANUL: 'Anulada', PRE: 'Anuncio previo',
};
const STATUS_TONE = {
  PUB: 'info', EV: 'mid', ADJ: 'warn', RES: 'ok', ANUL: 'bad', PRE: 'neu',
};
// [fondo, borde] de cada tono
const TONES = {
  ok: ['#d3f0de', '#1b7f3b'],
  warn: ['#fdecab', '#9a7400'],
  mid: ['#ffd3a3', '#b35400'],
  bad: ['#ffd6d2', '#b3261e'],
  info: ['#d6e6fb', '#1565c0'],
  maj: ['#ead9f7', '#7b2fb0'],
  min: ['#dde3ea', '#52606f'],
  neu: ['#e8eaed', '#6b7280'],
};

const statusName = (code) => (code === null || code === undefined ? '—' : (Object.hasOwn(STATUS, code) ? STATUS[code] : `${code}`.slice(0, 30)));
const statusTone = (code) => (Object.hasOwn(STATUS_TONE, `${code}`) ? STATUS_TONE[code] : 'neu');

const esc = (value) => `${value ?? ''}`
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Solo enlaces https:// sin espacios ni caracteres de control; cualquier otra cosa (javascript:, data:…) no es enlace.
const safeUrl = (url) => (typeof url === 'string' && /^https:\/\/\S+$/i.test(url) && [...url].every((c) => c.charCodeAt(0) > 32) ? url : null);

const eur = (n) => `${new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} €`;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const joinList = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} y ${items.at(-1)}` : (items[0] ?? ''));

const capped = (names) => {
  const shown = names.slice(0, MAX_DOCS_LISTED).join('; ');
  return names.length > MAX_DOCS_LISTED ? `${shown}; … y ${names.length - MAX_DOCS_LISTED} más` : shown;
};

const recordOf = (entry) => {
  try {
    return recordFromEntry(entry, /Menores/i.test(`${entry.id}`) ? 'menores' : 'licitaciones');
  } catch {
    return null; // anuncio sin ContractFolderStatus: se muestra con lo poco que haya
  }
};

// Ficha de un anuncio para el correo: todo lo que se muestra, calculado una vez. Los datos del anuncio se obtienen con
// recordFromEntry (transparencia/extract.js), el mismo código que alimenta la página, y los cambios con describeChange.
const factsOf = (entry, previous, opening, today) => {
  const record = recordOf(entry);
  const change = describeChange(entry, previous);
  const { from, to } = change.status;
  const deadlineOpen = Boolean(record?.deadline) && record.deadline >= today;
  return {
    entry,
    title: record?.title || entry.title || '(sin título)',
    buyer: contractingPartyName(entry) || 'Órgano no indicado',
    folder: record?.folder ?? null,
    menor: record?.kind === 'menor' || /Menores/i.test(`${entry.id}`),
    url: safeUrl(entry.link?.['@_href']),
    amount: record ? (record.budgetTotal ?? record.budgetNet) : null,
    winners: record?.winners.map((w) => w.name) ?? [],
    awarded: record?.awarded > 0 ? record.awarded : null,
    awardedNet: record?.awardedNet > 0 ? record.awardedNet : null,
    isNew: change.isNew,
    from,
    to,
    statusChanged: !change.isNew && from !== to,
    added: change.added,
    removed: change.removed,
    openings: openingRows(opening),
    openingLines: openingsLines(opening),
    deadline: record?.deadline && (change.isNew || deadlineOpen)
      ? `${dmyDate(record.deadline)}${record.deadlineTime ? ` · ${record.deadlineTime}` : ''}` : null,
    summary: entry.summary?.['#text'] ?? null,
  };
};

// Nuevas publicaciones, luego cambios de estado, luego el resto (solo documentos u otras novedades). Estable.
const rank = (f) => (f.isNew ? 0 : (f.statusChanged ? 1 : 2));
const sortFacts = (facts) => facts.map((f, i) => [f, i]).sort(([a, i], [b, j]) => (rank(a) - rank(b)) || (i - j)).map(([f]) => f);

// "1 adjudicación, 1 anuncio nuevo y 6 con documentos nuevos": categorías excluyentes, sin ceros.
export const subjectSummary = (facts) => {
  const adj = facts.filter((f) => f.statusChanged && f.to === 'ADJ').length;
  const fresh = facts.filter((f) => f.isNew).length;
  const changes = facts.filter((f) => f.statusChanged && f.to !== 'ADJ').length;
  const docs = facts.filter((f) => !f.isNew && !f.statusChanged && (f.added.length > 0 || f.removed.length > 0)).length;
  const other = facts.length - adj - fresh - changes - docs;
  const main = [
    adj ? plural(adj, 'adjudicación', 'adjudicaciones') : null,
    fresh ? plural(fresh, 'anuncio nuevo', 'anuncios nuevos') : null,
    changes ? plural(changes, 'cambio de estado', 'cambios de estado') : null,
    docs ? `${docs} con documentos nuevos` : null,
  ].filter(Boolean);
  const extra = other > 0 && main.length > 0 ? [`${other} con otras novedades`] : [];
  const generic = plural(facts.length, 'anuncio', 'anuncios');
  // el asunto debe ser razonable: si no cabe con todo, se quita lo menos importante y, en último caso, se resume
  const candidates = [[...main, ...extra], main].filter((c) => c.length > 0).map(joinList);
  return candidates.find((c) => c.length <= MAX_SUMMARY_LENGTH) ?? (main.length > 0 ? `${generic} con novedades` : generic);
};

// ---------- Texto plano ----------

const docLine = (label, names) => (names.length === 0 ? null : `  ${label} (${names.length}): ${capped(names)}`);

const winnersText = (f) => {
  if (f.winners.length === 0) return null;
  const shown = f.winners.slice(0, MAX_WINNERS_LISTED).join('; ');
  const names = f.winners.length > MAX_WINNERS_LISTED ? `${shown}; … y ${f.winners.length - MAX_WINNERS_LISTED} más` : shown;
  const amounts = [
    f.awardedNet === null ? null : `${eur(f.awardedNet)} sin IVA`,
    f.awarded === null ? null : `${eur(f.awarded)} IVA incl.`,
  ].filter(Boolean);
  return `  Adjudicataria: ${names}${amounts.length ? ` · ${amounts.join(' · ')}` : ''}`;
};

const textBlock = (f) => {
  const state = f.isNew
    ? `  Novedad: anuncio nuevo${f.to ? ` (estado ${statusName(f.to)})` : ''}`
    : (f.from === f.to ? `  Estado: ${statusName(f.to)} (sin cambio)` : `  Estado: ${statusName(f.from)} -> ${statusName(f.to)}`);
  return [
    `- ${f.title}`,
    `  ${f.buyer}`,
    state,
    !f.isNew && f.added.length === 0 && f.removed.length === 0 ? '  Documentos: sin cambios' : null,
    docLine('Documentos añadidos', f.added),
    docLine('Documentos retirados', f.removed),
    winnersText(f),
    f.deadline ? `  Presentación de ofertas hasta: ${f.deadline.replace(' · ', ' ')}` : null,
    ...f.openingLines,
    f.summary ? `  ${f.summary}` : null,
    f.url ? `  ${f.url}` : null,
  ].filter(Boolean).join('\n');
};

// ---------- HTML ----------

const tag = (text, tone, extra = '') => {
  const [bg, border] = TONES[tone];
  return `<span class="tag t-${tone}${extra}" style="display:inline-block;background:${bg};border:1px solid ${border};color:#3c3c3c;border-radius:6px;padding:2px 8px;font-size:12px;line-height:18px;white-space:nowrap">${esc(text)}</span>`;
};
const statusTag = (code) => tag(statusName(code), statusTone(code));

const row = (inner, pad = '10px 0 0') => `<tr><td style="padding:${pad};font-size:13px;line-height:19px;color:#3c3c3c" class="ink">${inner}</td></tr>`;
const label = (text) => `<strong class="brand" style="color:#0073ad">${esc(text)}</strong>`;

const stateHtml = (f) => {
  if (f.isNew) return `${tag('Nueva publicación', 'info')} ${statusTag(f.to)}`;
  if (f.statusChanged) {
    return `${statusTag(f.from)} <span class="mut" style="color:#646464;font-size:14px">&rarr;</span> ${statusTag(f.to)}`;
  }
  return `${statusTag(f.to)} <span class="mut" style="color:#646464;font-size:12px">&middot; sin cambio de estado</span>`;
};

const cardHtml = (f) => {
  const stripe = f.isNew ? TONES.info[1] : TONES[statusTone(f.to)][1];
  const title = f.url
    ? `<a href="${esc(f.url)}" class="ttl" style="color:#17202a;text-decoration:none">${esc(f.title)}</a>` : esc(f.title);
  const meta = [esc(f.buyer), f.folder ? `Exp. ${esc(f.folder)}` : null,
    f.amount === null ? null : `<strong class="ink" style="color:#3c3c3c">${eur(f.amount)}</strong>`].filter(Boolean).join(' &middot; ');
  const winners = f.winners.length === 0 ? '' : row(`${label('Adjudicataria:')} ${esc(winnersText(f).replace('  Adjudicataria: ', ''))}`);
  const deadline = f.deadline ? row(`${label('Presentación de ofertas hasta:')} ${esc(f.deadline)}`) : '';
  const docs = [
    f.added.length ? row(`${label(`Documentos nuevos (${f.added.length}):`)} ${esc(capped(f.added))}`) : '',
    f.removed.length ? row(`${label(`Documentos retirados (${f.removed.length}):`)} ${esc(capped(f.removed))}`) : '',
  ].join('');
  const meetings = f.openings.length === 0 ? '' : `<tr><td style="padding:10px 0 0"><div class="mut" style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#646464;padding-bottom:4px">Mesas de contratación</div>${
    f.openings.map(({ event, before }) => {
      const pub = event.public === null || event.public === undefined ? '' : ` &middot; <span class="${event.public ? 'okc' : 'mut'}" style="color:${event.public ? '#1b7f3b' : '#646464'}">acto ${event.public ? '' : 'no '}público</span>`;
      const moved = before ? ` <span class="mut" style="color:#646464">(antes: ${esc(before)})</span>` : '';
      return `<div class="ink" style="font-size:13px;line-height:22px;color:#3c3c3c"><span style="display:inline-block;min-width:112px;font-weight:600">${esc(dmyDate(event.date))}${event.time ? ` &middot; ${esc(event.time)}` : ''}</span> ${esc(shortType(event.type))}${pub}${moved}</div>`;
    }).join('')}</td></tr>`;
  const button = f.url
    ? `<tr><td style="padding:14px 0 0"><a href="${esc(f.url)}" class="btn" style="display:inline-block;background:#0073ad;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:8px 14px;border-radius:8px">Ver en la Plataforma &rarr;</a></td></tr>` : '';
  return `
<tr><td style="padding:0 0 14px">
 <table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="card" style="background:#ffffff;border:1px solid #d9e4ec;border-left:5px solid ${stripe};border-radius:10px">
  <tr><td style="padding:16px 18px">
   <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
    <tr><td style="padding:0 0 8px">${tag(f.menor ? 'Cont. menor' : 'Cont. mayor', f.menor ? 'min' : 'maj')} ${stateHtml(f)}</td></tr>
    <tr><td class="ttl" style="font-size:16px;line-height:22px;font-weight:700;color:#17202a">${title}</td></tr>
    <tr><td class="mut" style="padding:4px 0 0;font-size:13px;line-height:19px;color:#646464">${meta}</td></tr>
    ${winners}${deadline}${docs}${meetings}${button}
   </table>
  </td></tr>
 </table>
</td></tr>`;
};

const CSS = `
 body{margin:0;padding:0;background:#f4f8fb;-webkit-text-size-adjust:100%}
 a{color:#0073ad}
 @media (max-width:620px){ .wrap{width:100%!important} .pad{padding-left:14px!important;padding-right:14px!important} }
 @media (prefers-color-scheme:dark){
  body,.bg{background:#0f161c!important}
  .card{background:#182029!important;border-color:#2a3641!important}
  .ttl,.ttl a,.ink{color:#e8eef2!important}
  .mut{color:#a3b0ba!important}
  .brand{color:#4cb4e8!important}
  .okc{color:#5fcf80!important}
  .tag{color:#e8eef2!important}
  .t-info{background:#16365f!important;border-color:#6aa8ff!important}.t-mid{background:#6b3a0c!important;border-color:#ff9d3d!important}
  .t-warn{background:#5a4708!important;border-color:#e3b04b!important}.t-ok{background:#1f4d2e!important;border-color:#5fcf80!important}
  .t-bad{background:#5e1f1a!important;border-color:#ff8a80!important}.t-maj{background:#43265e!important;border-color:#c79bf0!important}
  .t-min{background:#2c3743!important;border-color:#8fa1b3!important}.t-neu{background:#2c3138!important;border-color:#8b93a0!important}
  .sum{background:#16303f!important;color:#e8eef2!important}
  .foot,.foot a{color:#a3b0ba!important}
  .btn{background:#4cb4e8!important;color:#0b1218!important}
 }`;

const FONT = "'Outfit','Segoe UI',Helvetica,Arial,sans-serif";

const SPANISH_DATE = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
});
const todayIso = (now) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(now);
const longDate = (now) => {
  const text = SPANISH_DATE.format(now).replace(',', '');
  return `${text[0].toUpperCase()}${text.slice(1)}`;
};

const summaryParts = (facts) => {
  const fresh = facts.filter((f) => f.isNew).length;
  const changes = facts.filter((f) => f.statusChanged).length;
  const docs = facts.filter((f) => f.added.length > 0).length;
  return [
    fresh ? `<strong>${fresh}</strong> ${fresh === 1 ? 'nueva publicación' : 'nuevas publicaciones'}` : null,
    changes ? `<strong>${changes}</strong> ${changes === 1 ? 'cambio' : 'cambios'} de estado` : null,
    docs ? `<strong>${docs}</strong> con documentos nuevos` : null,
  ].filter(Boolean);
};

const htmlDocument = ({
  subject, facts, hidden, now, sample,
}) => {
  const shown = facts.slice(0, MAX_ENTRIES_IN_BODY);
  const parts = summaryParts(facts);
  const summary = parts.length > 0 ? parts.join(' &nbsp;&middot;&nbsp; ') : `<strong>${facts.length}</strong> ${facts.length === 1 ? 'anuncio' : 'anuncios'}`;
  const more = hidden > 0
    ? `<tr><td class="mut" style="padding:0 0 14px;font-size:13px;color:#646464">&hellip; y ${hidden} más (están en el repositorio, carpeta dump/).</td></tr>` : '';
  const notice = sample
    ? '<tr><td class="pad" style="padding:12px 24px 0"><div class="mut" style="font-size:12px;line-height:18px;color:#646464;border:1px dashed #b8c7d3;border-radius:8px;padding:6px 10px">Correo de muestra: datos reales de los últimos anuncios, enviado solo a esta dirección.</div></td></tr>' : '';
  const link = (href, text) => `<a href="${esc(href)}" style="color:#0073ad">${esc(text)}</a>`;
  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${esc(subject)}</title>
<style>${CSS}
</style></head>
<body class="bg" style="margin:0;padding:0;background:#f4f8fb;font-family:${FONT}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(`${subjectSummary(facts)} del Ayuntamiento de Aranda de Duero.`)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="bg" style="background:#f4f8fb"><tr><td align="center" style="padding:20px 10px">
 <table role="presentation" width="640" cellspacing="0" cellpadding="0" class="wrap" style="width:640px;max-width:100%">
  <tr><td class="pad" style="background:#30b5e5;border-radius:12px 12px 0 0;padding:18px 24px"><img src="${esc(LOGO_URL)}" width="240" alt="Ayuntamiento de Aranda de Duero" style="display:block;border:0;height:auto;max-width:100%;color:#ffffff;font-size:18px;font-weight:700"></td></tr>${notice}
  <tr><td class="pad" style="padding:22px 24px 6px">
   <div class="ttl" style="font-size:22px;line-height:28px;font-weight:700;color:#17202a">Novedades de contratación</div>
   <div class="mut" style="font-size:13px;color:#646464;padding-top:2px">${esc(longDate(now))} &middot; Plataforma de Contratación del Sector Público</div>
  </td></tr>
  <tr><td class="pad" style="padding:8px 24px 16px"><div class="sum" style="background:#e9f4f9;color:#3c3c3c;border-radius:8px;padding:10px 14px;font-size:14px">${summary}</div></td></tr>
  <tr><td class="pad" style="padding:0 24px">
   <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${shown.map(cardHtml).join('')}${more}</table>
  </td></tr>
  <tr><td class="pad foot" style="padding:8px 24px 28px;font-size:12px;line-height:19px;color:#646464;text-align:center">
   ${link(SITE_URL, 'Página de transparencia')} &nbsp;&middot;&nbsp; ${link(`${SITE_URL}aperturas.ics`, 'Calendario')} &nbsp;&middot;&nbsp; ${link(`${SITE_URL}datos/`, 'Datos abiertos')} &nbsp;&middot;&nbsp; ${link(`${SITE_URL}feed.xml`, 'Feed')}<br>
   Recibes este aviso como destinatario de las novedades de contratación del Ayuntamiento de Aranda de Duero.<br>
   La fuente oficial es siempre el anuncio original en la Plataforma. &middot; ${link(PRIVACY_URL, 'Política de privacidad')}<br>
   &copy; ${now.getFullYear()} Ayuntamiento de Aranda de Duero
  </td></tr>
 </table>
</td></tr></table>
</body></html>
`;
};

// Asunto, cuerpo en texto plano y HTML del resumen de anuncios. `previousOf(entry)` devuelve la versión anterior del
// anuncio (o null); sin ella, todos se presentan como nuevos. `openingsOf(entry)` devuelve { events, previous } o null.
// Opciones: `now` (fecha de referencia) y `sample` (marca el correo como muestra).
export const buildDigest = (entries, previousOf = () => null, openingsOf = () => null, { now = new Date(), sample = false } = {}) => {
  const today = todayIso(now);
  const facts = sortFacts(entries.map((entry) => factsOf(entry, previousOf(entry) ?? null, openingsOf(entry) ?? null, today)));
  const subject = `${sample ? '[MUESTRA] ' : ''}Novedades de contratación: ${subjectSummary(facts)}`;

  const shown = facts.slice(0, MAX_ENTRIES_IN_BODY);
  const hidden = facts.length - shown.length;
  const lines = [
    ...(sample ? ['MUESTRA: correo de muestra con datos reales de los últimos anuncios, enviado solo a esta dirección.', ''] : []),
    `${subject}.`,
    '',
    shown.map(textBlock).join('\n\n'),
  ];
  if (hidden > 0) {
    lines.push('', `… y ${hidden} más (están en el repositorio, carpeta dump/).`);
  }
  return {
    subject, body: lines.join('\n'), html: htmlDocument({ subject, facts, hidden, now, sample }),
  };
};

// Envía el resumen. Los destinatarios van SIEMPRE en CCO (BccAddresses): nadie ve a los demás.
// `client` es un cliente de SES (o un doble en los tests). Devuelve el número de mensajes enviados.
export const sendDigest = async ({
  config, entries, client, previousOf, openingsOf, sample = false,
}) => {
  if (!config.enabled || entries.length === 0) {
    return 0;
  }

  const { subject, body, html } = buildDigest(entries, previousOf, openingsOf, { sample });
  const messages = chunk(config.recipients, MAX_RECIPIENTS_PER_MESSAGE);
  for (const bcc of messages) {
    await client.send(new SendEmailCommand({
      Destination: { BccAddresses: bcc },
      Message: {
        Subject: { Charset: 'UTF-8', Data: subject },
        Body: { Text: { Charset: 'UTF-8', Data: body }, Html: { Charset: 'UTF-8', Data: html } },
      },
      Source: config.from,
    }));
  }
  return messages.length;
};
