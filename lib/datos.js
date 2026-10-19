// Datos abiertos: contratos.csv, contratos.json y adjudicatarios.csv, derivados de los mismos registros que la página
// (buildRecords). Todo son funciones puras: el contenido solo depende de los registros y de `generated` (la fecha de
// los datos), nunca del reloj, así que el mismo input da el mismo fichero byte a byte.
//
// El diccionario de datos (FIELDS) está aquí, en un único sitio: de él salen las columnas del CSV, las claves del JSON
// y la tabla de la página /datos.
import { CALENDARS } from './ics.js';
import { FEED_FILE, RSS_FILE } from './feed.js';
import {
  AYTO_URL, REPO_URL, SITE_URL,
} from '../transparencia/site.js';

// Los datos se publican aparte del código (que es MIT): reutilización de la información del sector público
// (Ley 37/2007) con atribución, bajo CC BY 4.0.
export const LICENSE = {
  name: 'Creative Commons Reconocimiento 4.0 Internacional (CC BY 4.0)',
  short: 'CC BY 4.0',
  url: 'https://creativecommons.org/licenses/by/4.0/deed.es',
  attribution: 'Ayuntamiento de Aranda de Duero, a partir de la Plataforma de Contratación del Sector Público',
};
export const SOURCE = {
  name: 'Plataforma de Contratación del Sector Público',
  url: 'https://contrataciondelestado.es',
};

// Corporaciones municipales: cada mandato dura desde su constitución hasta el día anterior a la del siguiente; lo
// anterior al primero cuenta en el primero. Misma regla que PERIODS/periodOf de transparencia/template.html (un test
// comprueba que no se desvían).
export const PERIODS = [
  { label: 'Mandato 11-15', start: '2011-06-11' },
  { label: 'Mandato 15-19', start: '2015-06-14' },
  { label: 'Mandato 19-23', start: '2019-06-15' },
  { label: 'Mandato 23-27', start: '2023-06-17' },
];
export const periodOf = (day) => Math.max(0, PERIODS.findLastIndex((p) => day >= p.start));

// Mandato que sacó el contrato: las licitaciones por la fecha de publicación del anuncio (si falta, la de
// adjudicación o actualización) y los contratos menores por la de adjudicación (si falta, la de actualización).
export const mandatoOf = (r) => {
  const date = r.awardDate || `${r.updated ?? ''}`.slice(0, 10);
  const issued = r.kind === 'licitacion' ? (r.published || date) : date;
  return PERIODS[periodOf(issued)].label;
};

const TYPE = {
  1: 'Suministros', 2: 'Servicios', 3: 'Obras', 7: 'Administrativo especial', 8: 'Privado', 21: 'Gestión de servicios públicos',
  22: 'Concesión de servicios', 31: 'Concesión de obras públicas', 32: 'Concesión de obras', 40: 'Colaboración público-privada',
  50: 'Patrimonial', 999: 'Otros',
};
const PROC = {
  1: 'Abierto', 2: 'Restringido', 3: 'Negociado sin publicidad', 4: 'Negociado con publicidad', 5: 'Diálogo competitivo',
  6: 'Contrato menor', 7: 'Derivado de acuerdo marco', 8: 'Concurso de proyectos', 9: 'Abierto simplificado',
  10: 'Asociación para la innovación', 11: 'Derivado de asociación para la innovación', 12: 'Sistema dinámico de adquisición',
  13: 'Licitación con negociación', 100: 'Normas internas', 999: 'Otros',
};
const STATUS = {
  PUB: 'Publicada', EV: 'En evaluación', ADJ: 'Adjudicada', RES: 'Resuelta', ANUL: 'Anulada', PRE: 'Anuncio previo',
};

const SEP = ' | ';
const label = (map, code) => (code === null || code === undefined ? null : (map[code] ?? `${code}`));
const orNull = (v) => (v === undefined || v === '' ? null : v);
const number = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Adjudicatarios distintos de un contrato (un contrato con lotes repite al mismo adjudicatario): clave = NIF o, si no
// hay, el nombre en mayúsculas.
const winnerKey = (w) => w.nif || `${w.name}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
export const uniqueWinners = (r) => [...new Map((r.winners ?? []).map((w) => [winnerKey(w), w])).values()];

const joined = (list) => (list.length ? list.join(SEP) : null);

// Diccionario de datos del contrato. `name` es el nombre estable (snake_case) de la columna/clave.
export const FIELDS = [
  { name: 'id', type: 'texto', description: 'Identificador del anuncio en este conjunto de datos: «l-» (licitación) o «m-» (contrato menor) y el número de anuncio de la Plataforma.', get: (r) => r.id },
  { name: 'clase', type: 'texto', description: '«licitacion» (contrato mayor, con licitación) o «menor» (contrato menor).', get: (r) => r.kind },
  { name: 'expediente', type: 'texto', description: 'Número de expediente del Ayuntamiento.', get: (r) => orNull(r.folder) },
  { name: 'titulo', type: 'texto', description: 'Objeto del contrato.', get: (r) => orNull(r.title) },
  { name: 'organo', type: 'texto', description: 'Órgano de contratación (Alcaldía, Junta de Gobierno o Pleno).', get: (r) => orNull(r.buyer) },
  { name: 'estado', type: 'texto', description: 'Estado del expediente en la Plataforma (Publicada, En evaluación, Adjudicada, Resuelta, Anulada o Anuncio previo).', get: (r) => label(STATUS, r.status) },
  { name: 'resultado', type: 'texto', description: 'Resultado del procedimiento: adjudicado, desierto, desistimiento, renuncia, mixto (lotes con resultados distintos) u otro. Vacío si aún no hay resultado.', get: (r) => orNull(r.outcome) },
  { name: 'tipo', type: 'texto', description: 'Tipo de contrato (Suministros, Servicios, Obras…).', get: (r) => label(TYPE, r.type) },
  { name: 'procedimiento', type: 'texto', description: 'Procedimiento de contratación (Abierto, Abierto simplificado, Contrato menor…).', get: (r) => label(PROC, r.procedure) },
  { name: 'mandato', type: 'texto', description: 'Mandato de la corporación que sacó el contrato (p. ej. «Mandato 23-27»): las licitaciones por la fecha de publicación del anuncio y los contratos menores por la de adjudicación. Cada mandato va desde su constitución hasta el día anterior a la del siguiente.', get: mandatoOf },
  { name: 'publicacion', type: 'fecha', description: 'Fecha de publicación del anuncio (AAAA-MM-DD).', get: (r) => orNull(r.published) },
  { name: 'fecha_limite', type: 'fecha', description: 'Último día de presentación de ofertas (AAAA-MM-DD).', get: (r) => orNull(r.deadline) },
  { name: 'hora_limite', type: 'hora', description: 'Hora límite de presentación de ofertas (HH:MM, hora de España).', get: (r) => orNull(r.deadlineTime) },
  { name: 'fecha_adjudicacion', type: 'fecha', description: 'Fecha de adjudicación (AAAA-MM-DD).', get: (r) => orNull(r.awardDate) },
  { name: 'presupuesto_sin_iva', type: 'número', description: 'Presupuesto base de licitación sin IVA, en euros.', get: (r) => number(r.budgetNet) },
  { name: 'presupuesto_con_iva', type: 'número', description: 'Presupuesto base de licitación con IVA, en euros.', get: (r) => number(r.budgetTotal) },
  { name: 'valor_estimado', type: 'número', description: 'Valor estimado del contrato (incluye prórrogas y modificaciones previstas), en euros.', get: (r) => number(r.estimated) },
  { name: 'importe_adjudicado_sin_iva', type: 'número', description: 'Importe adjudicado sin IVA (suma de los lotes), en euros.', get: (r) => number(r.awardedNet) },
  { name: 'importe_adjudicado_con_iva', type: 'número', description: 'Importe adjudicado con IVA (suma de los lotes), en euros.', get: (r) => number(r.awarded) },
  { name: 'num_ofertas', type: 'entero', description: 'Número de ofertas recibidas (suma de los lotes).', get: (r) => number(r.offers) },
  { name: 'adjudicatarios', type: 'texto', description: `Nombres de los adjudicatarios, sin repetir y separados por «${SEP}».`, get: (r) => joined(uniqueWinners(r).map((w) => w.name)) },
  { name: 'adjudicatarios_nif', type: 'texto', description: `NIF de los adjudicatarios, en el mismo orden y separados por «${SEP}».`, get: (r) => joined(uniqueWinners(r).map((w) => w.nif).filter(Boolean)) },
  { name: 'programa_financiacion', type: 'texto', description: 'Programa de financiación que consta en el anuncio, si lo hay.', get: (r) => orNull(r.fundingProgram) },
  { name: 'nextgeneration', type: 'texto', description: 'Programa europeo NextGenerationEU asociado (PRTR, REACT-EU o NextGenerationEU); vacío si no consta.', get: (r) => orNull(r.nextgenProgram) },
  { name: 'duracion_meses', type: 'entero', description: 'Duración prevista del contrato, en meses.', get: (r) => number(r.durationMonths) },
  { name: 'url_anuncio', type: 'texto', description: 'Enlace al anuncio original en la Plataforma de Contratación del Sector Público (fuente oficial).', get: (r) => orNull(r.url) },
];

// Diccionario de adjudicatarios.csv
export const ADJ_FIELDS = [
  { name: 'nif', type: 'texto', description: 'NIF del adjudicatario (vacío si el anuncio no lo indica).' },
  { name: 'nombre', type: 'texto', description: 'Nombre del adjudicatario (el más frecuente en los anuncios).' },
  { name: 'num_contratos', type: 'entero', description: 'Número de contratos distintos adjudicados.' },
  { name: 'importe_adjudicado_sin_iva', type: 'número', description: 'Suma de los importes adjudicados sin IVA, en euros. Si un contrato tiene varios adjudicatarios, su importe se reparte a partes iguales.', },
  { name: 'importe_adjudicado_con_iva', type: 'número', description: 'Suma de los importes adjudicados con IVA, en euros (mismo reparto).', },
];

export const contractRow = (r) => Object.fromEntries(FIELDS.map((f) => [f.name, f.get(r)]));

export const buildRows = (records) => records.map(contractRow);

// ---------- CSV (RFC 4180: comas, comillas dobles, saltos \r\n, sin BOM) ----------
const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = `${v}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (columns, rows) => `${[columns, ...rows.map((row) => columns.map((c) => row[c]))]
  .map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;

export const buildContratosCsv = (records) => toCsv(FIELDS.map((f) => f.name), buildRows(records));

// ---------- JSON ----------
export const buildContratosJson = (records, generated) => `${JSON.stringify({
  generado: generated,
  licencia: { nombre: LICENSE.name, url: LICENSE.url, atribucion: LICENSE.attribution },
  fuente: SOURCE,
  contratos: buildRows(records),
}, null, 1)}\n`;

// ---------- adjudicatarios ----------
const cents = (n) => Math.round(n * 100) / 100;

export const buildAdjudicatarios = (records) => {
  const byKey = new Map();
  for (const r of records) {
    const winners = uniqueWinners(r);
    for (const w of winners) {
      const key = winnerKey(w);
      const entry = byKey.get(key) ?? { nif: w.nif || null, names: new Map(), n: 0, net: 0, gross: 0 };
      entry.names.set(w.name, (entry.names.get(w.name) || 0) + 1);
      entry.n += 1;
      entry.net += (number(r.awardedNet) ?? 0) / winners.length;
      entry.gross += (number(r.awarded) ?? 0) / winners.length;
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].map((e) => ({
    nif: e.nif,
    // el más frecuente; a igualdad, el primero por orden alfabético
    nombre: [...e.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'))[0][0],
    num_contratos: e.n,
    importe_adjudicado_sin_iva: cents(e.net),
    importe_adjudicado_con_iva: cents(e.gross),
  })).sort((a, b) => b.importe_adjudicado_con_iva - a.importe_adjudicado_con_iva
    || a.nombre.localeCompare(b.nombre, 'es') || `${a.nif}`.localeCompare(`${b.nif}`));
};

export const buildAdjudicatariosCsv = (records) => toCsv(ADJ_FIELDS.map((f) => f.name), buildAdjudicatarios(records));

// Cobertura temporal de los datos: de la primera a la última fecha de publicación o adjudicación (AAAA-MM-DD/AAAA-MM-DD).
export const temporalCoverage = (records) => {
  const days = records.flatMap((r) => [r.published, r.awardDate]).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(`${d}`)).sort();
  return days.length ? `${days[0]}/${days[days.length - 1]}` : null;
};

// ---------- catálogo de ficheros ----------
// `path`: ruta respecto a la raíz del sitio. Los conjuntos de datos van en datos/; calendarios y feeds, en la raíz.
export const DATA_DIR = 'datos';
export const DATA_FILES = {
  csv: 'contratos.csv', json: 'contratos.json', adjudicatarios: 'adjudicatarios.csv',
};

const CAL_DESCRIPTION = {
  'aperturas.ics': 'Calendario de Contratación completo: mesas, plazos, adjudicaciones y vencimientos.',
  'mesas.ics': 'Solo las aperturas de ofertas (mesas de contratación).',
  'plazos.ics': 'Publicación y último día de presentación de ofertas de cada licitación.',
  'adjudicaciones.ics': 'Adjudicaciones de licitaciones y de contratos menores.',
  'vencimientos.ics': 'Fin previsto de cada contrato, con aviso el día antes.',
};

export const FILES = [
  { path: `${DATA_DIR}/${DATA_FILES.csv}`, description: 'Todos los contratos (licitaciones y contratos menores), una fila por contrato.', format: 'CSV (UTF-8, comas)', mime: 'text/csv', download: true },
  { path: `${DATA_DIR}/${DATA_FILES.json}`, description: 'Los mismos contratos con fecha de los datos, licencia y fuente.', format: 'JSON (UTF-8)', mime: 'application/json', download: true },
  { path: `${DATA_DIR}/${DATA_FILES.adjudicatarios}`, description: 'Resumen por adjudicatario: número de contratos e importe total.', format: 'CSV (UTF-8, comas)', mime: 'text/csv', download: true },
  ...CALENDARS.map((c) => ({ path: c.file, description: CAL_DESCRIPTION[c.file] ?? c.name, format: 'iCalendar (.ics)', mime: 'text/calendar', download: true })),
  { path: FEED_FILE, description: 'Licitaciones nuevas y adjudicaciones de los últimos 90 días.', format: 'Atom 1.0 (XML)', mime: 'application/atom+xml', download: false },
  { path: RSS_FILE, description: 'Lo mismo que el feed Atom, en RSS.', format: 'RSS 2.0 (XML)', mime: 'application/rss+xml', download: false },
];
export const baseName = (path) => path.split('/').pop();

// ---------- página /datos ----------
export const PAGE_FILE = 'index.html';
export const PAGE_URL = `${SITE_URL}${DATA_DIR}/`;

const esc = (s) => `${s ?? ''}`.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nfEs = (n, digits) => n.toLocaleString('es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits });

// Tamaño legible (1 KB = 1024 bytes); el número exacto va en data-bytes.
export const humanSize = (bytes) => {
  if (bytes < 1024) return `${nfEs(bytes, 0)} B`;
  if (bytes < 1024 * 1024) return `${nfEs(bytes / 1024, 1)} KB`;
  return `${nfEs(bytes / (1024 * 1024), 1)} MB`;
};

const dayEs = (iso) => `${iso}`.slice(0, 10).split('-').reverse().join('/');

// URL absoluta de un fichero del catálogo; la relativa desde datos/ para los enlaces de la página.
export const absoluteUrl = (file) => `${SITE_URL}${file.path}`;
const relativeUrl = (file) => (file.path.startsWith(`${DATA_DIR}/`) ? baseName(file.path) : `../${file.path}`);

const dictRows = (fields) => fields.map((f) => `      <tr><th scope="row"><code>${esc(f.name)}</code></th><td>${esc(f.type)}</td><td>${esc(f.description)}</td></tr>`).join('\n');

// `sizes`: ruta -> bytes del fichero ya escrito.
const fileRows = (sizes, generated) => FILES.map((f) => {
  const bytes = sizes[f.path];
  const attrs = f.download ? ' download' : '';
  return `      <tr><th scope="row"><a href="${esc(relativeUrl(f))}"${attrs}>${esc(baseName(f.path))}</a></th><td>${esc(f.description)}</td><td>${esc(f.format)}</td>`
    + `<td class="num" data-bytes="${bytes}">${humanSize(bytes)}</td><td class="num"><time datetime="${esc(generated)}">${dayEs(generated)}</time></td></tr>`;
}).join('\n');

export const buildJsonLd = ({ sizes, generated, coverage }) => ({
  '@context': 'https://schema.org',
  '@type': 'Dataset',
  name: 'Contratación del Ayuntamiento de Aranda de Duero',
  description: 'Licitaciones y contratos menores del Ayuntamiento de Aranda de Duero publicados en la Plataforma de Contratación del Sector Público, con calendarios y feeds de novedades.',
  url: PAGE_URL,
  inLanguage: 'es',
  license: LICENSE.url,
  isAccessibleForFree: true,
  creator: { '@type': 'Organization', name: 'Ayuntamiento de Aranda de Duero', url: AYTO_URL },
  publisher: { '@type': 'Organization', name: 'Ayuntamiento de Aranda de Duero', url: AYTO_URL },
  isBasedOn: SOURCE.url,
  spatialCoverage: 'Aranda de Duero (Burgos, España)',
  ...(coverage ? { temporalCoverage: coverage } : {}),
  dateModified: generated,
  distribution: FILES.map((f) => ({
    '@type': 'DataDownload',
    name: baseName(f.path),
    contentUrl: absoluteUrl(f),
    encodingFormat: f.mime,
    contentSize: `${sizes[f.path]} B`,
  })),
});

// Plantilla (transparencia/datos.html) + catálogo + tamaños -> página estática. Las URLs absolutas salen de
// transparencia/site.js.
export const renderDatosPage = (template, {
  sizes, generated, coverage, nContratos, nAdjudicatarios, fonts = '', assets = {},
}) => {
  const jsonLd = JSON.stringify(buildJsonLd({ sizes, generated, coverage })).replace(/</g, '\\u003c');
  const [from, to] = (coverage ?? '').split('/');
  const replacements = {
    '/*JSONLD*/': jsonLd,
    '/*FONTFACE*/': fonts,
    __FILES_ROWS__: fileRows(sizes, generated),
    __DICT_CONTRATOS__: dictRows(FIELDS),
    __DICT_ADJ__: dictRows(ADJ_FIELDS),
    __N_CONTRATOS__: nfEs(nContratos, 0),
    __N_ADJ__: nfEs(nAdjudicatarios, 0),
    __COVERAGE__: from ? `entre el ${dayEs(from)} y el ${dayEs(to)}` : 'sin fechas todavía',
    __GENERATED__: esc(generated),
    __GENERATED_DATE__: dayEs(generated),
    __LICENSE_URL__: LICENSE.url,
    __LICENSE_NAME__: esc(LICENSE.name),
    __ATTRIBUTION__: esc(LICENSE.attribution),
    __SOURCE_URL__: SOURCE.url,
    ...assets,
    __SITE_URL__: SITE_URL,
    __REPO_URL__: REPO_URL,
    __AYTO_URL__: AYTO_URL,
    __BUILD_YEAR__: `${generated}`.match(/^\d{4}/)?.[0] ?? '',
  };
  let html = template;
  for (const [marker, value] of Object.entries(replacements)) html = html.replaceAll(marker, () => value);
  return html;
};
