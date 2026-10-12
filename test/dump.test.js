// Invariantes sobre el dump real (dump/). Se ejecutan contra lo que haya en el repositorio, así que detectan
// ficheros corruptos, mal nombrados o que no son del Ayuntamiento, y cambios inesperados en el formato del feed.
import test from 'ava';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import { entryFileName, isFromAyuntamiento, isPresent } from '../lib/ayuntamiento.js';
import { buildRecords } from '../transparencia/extract.js';
import { REAL_DUMP } from './helpers.js';

const DIRS = ['licitaciones', 'menores', 'other', 'agregacion'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['PUB', 'EV', 'ADJ', 'RES', 'ANUL', 'PRE'];

const loaded = DIRS.flatMap((dir) => {
  const folder = join(REAL_DUMP, dir);
  return existsSync(folder)
    ? readdirSync(folder).filter((f) => f.endsWith('.json')).sort().map((file) => ({ dir, file, path: join(folder, file) }))
    : [];
}).map((item) => {
  try {
    return { ...item, entry: JSON.parse(readFileSync(item.path, 'utf8')) };
  } catch (error) {
    return { ...item, error };
  }
});
const { files, records, generated } = buildRecords(REAL_DUMP);
const where = (items) => items.slice(0, 5).map((r) => r.file ?? r.id).join(', ');

test('el dump tiene ficheros de licitaciones y de menores', (t) => {
  t.true(loaded.some((f) => f.dir === 'licitaciones'));
  t.true(loaded.some((f) => f.dir === 'menores'));
  t.is(files, loaded.length);
});

test('todos los ficheros son JSON legible', (t) => {
  const broken = loaded.filter((f) => f.error);
  t.is(broken.length, 0, `Ilegibles: ${where(broken)}`);
});

test('cada fichero se llama <id>-<timestamp>.json según su contenido', (t) => {
  const wrong = loaded.filter((f) => f.entry && entryFileName(f.entry) !== f.file);
  t.is(wrong.length, 0, `Mal nombrados: ${where(wrong)}`);
});

test('todos los ficheros son del Ayuntamiento de Aranda de Duero y traen ContractFolderStatus', (t) => {
  const foreign = loaded.filter((f) => f.entry && !isFromAyuntamiento(f.entry));
  t.is(foreign.length, 0, `De otros organismos: ${where(foreign)}`);
  const empty = loaded.filter((f) => f.entry && !f.entry['cac-place-ext:ContractFolderStatus']);
  t.is(empty.length, 0, `Sin ContractFolderStatus: ${where(empty)}`);
});

test('no hay dos ficheros con el mismo nombre en carpetas distintas con contenido diferente', (t) => {
  const seen = new Map();
  const clashes = [];
  for (const f of loaded) {
    const prev = seen.get(f.file);
    if (prev && JSON.stringify(prev.entry) !== JSON.stringify(f.entry)) clashes.push(f);
    seen.set(f.file, f);
  }
  t.is(clashes.length, 0, `Conflictos: ${where(clashes)}`);
});

test('buildRecords genera un registro por anuncio, sin ids repetidos y ordenados por fecha', (t) => {
  t.true(records.length > 0);
  t.true(records.length <= files);
  t.is(new Set(records.map((r) => r.id)).size, records.length);
  const key = (r) => r.awardDate || r.updated;
  const unsorted = records.filter((r, i) => i > 0 && key(records[i - 1]).localeCompare(key(r)) < 0);
  t.is(unsorted.length, 0);
});

test('"generated" es la fecha del dato más reciente', (t) => {
  t.false(Number.isNaN(Date.parse(generated)));
  t.true(records.every((r) => r.updated <= generated));
});

test('todos los registros son del Ayuntamiento y tienen los campos básicos', (t) => {
  for (const r of records) {
    t.regex(r.buyer, /Ayuntamiento de Aranda de Duero/i, r.id);
    t.true(['licitacion', 'menor'].includes(r.kind), r.id);
    t.truthy(r.title, `${r.id} sin título`);
    t.truthy(r.folder, `${r.id} sin expediente`);
    t.truthy(r.url, `${r.id} sin enlace`);
    t.false(Number.isNaN(Date.parse(r.updated)), r.id);
  }
});

test('los estados y los tipos numéricos son los esperados', (t) => {
  const unknown = records.filter((r) => !STATUSES.includes(r.status));
  t.is(unknown.length, 0, `Estados desconocidos: ${unknown.map((r) => `${r.id}:${r.status}`).slice(0, 5).join(', ')}`);
  const nan = records.filter((r) => [r.type, r.subtype, r.procedure].some((v) => isPresent(v) && !Number.isFinite(v)));
  t.is(nan.length, 0, `Códigos no numéricos: ${where(nan)}`);
});

test('importes: nunca negativos ni NaN', (t) => {
  const bad = records.filter((r) => ['awarded', 'awardedNet', 'budgetNet', 'budgetTotal', 'estimated']
    .some((field) => isPresent(r[field]) && !(Number.isFinite(r[field]) && r[field] >= 0)));
  t.is(bad.length, 0, `Importes inválidos: ${where(bad)}`);
});

test('fechas: formato YYYY-MM-DD', (t) => {
  const bad = records.filter((r) => [r.awardDate, r.published, r.deadline].some((d) => isPresent(d) && !ISO_DATE.test(d)));
  t.is(bad.length, 0, `Fechas mal formadas: ${where(bad)}`);
});

test('adjudicados con importe tienen adjudicatario con nombre', (t) => {
  const withoutWinner = records.filter((r) => r.awarded > 0 && r.winners.length === 0);
  t.is(withoutWinner.length, 0, `Adjudicados sin ganador: ${where(withoutWinner)}`);
  const unnamed = records.filter((r) => r.winners.some((w) => !w.name));
  t.is(unnamed.length, 0);
});

test('el resultado es coherente con los códigos, los ganadores y los importes', (t) => {
  const known = ['adjudicado', 'desierto', 'desistimiento', 'renuncia', 'mixto', 'otro', null];
  const unknown = records.filter((r) => !known.includes(r.outcome));
  t.is(unknown.length, 0, `Resultado desconocido: ${where(unknown)}`);

  // sin resultado <=> sin códigos
  const mismatch = records.filter((r) => (r.outcome === null) !== (r.resultCodes.length === 0));
  t.is(mismatch.length, 0, `Resultado y códigos incoherentes: ${where(mismatch)}`);

  // lo que termina sin adjudicar no tiene ganador ni importe adjudicado
  const voidWithWinner = records.filter((r) => ['desierto', 'desistimiento', 'renuncia'].includes(r.outcome)
    && (r.winners.length > 0 || r.awarded > 0));
  t.is(voidWithWinner.length, 0, `Sin adjudicar pero con ganador o importe: ${where(voidWithWinner)}`);

  // lo adjudicado (o parcialmente) tiene ganador
  const awardedWithoutWinner = records.filter((r) => ['adjudicado', 'mixto'].includes(r.outcome) && r.winners.length === 0);
  t.is(awardedWithoutWinner.length, 0, `Adjudicado sin ganador: ${where(awardedWithoutWinner)}`);
});

test('NextGenerationEU: la detección es coherente con los campos de financiación', (t) => {
  // todo contrato con código PRTR está marcado
  const missed = records.filter((r) => r.fundingCodes.includes('PRTR') && !r.nextgen);
  t.is(missed.length, 0, `Con código PRTR sin marcar: ${where(missed)}`);
  // lo marcado tiene programa y origen
  const incomplete = records.filter((r) => r.nextgen && (!r.nextgenProgram || !['financiacion', 'texto'].includes(r.nextgenBy)));
  t.is(incomplete.length, 0, `Marcados sin programa u origen: ${where(incomplete)}`);
  // lo no marcado no lo tiene
  const stray = records.filter((r) => !r.nextgen && (r.nextgenProgram || r.nextgenBy));
  t.is(stray.length, 0);
  // un contrato por el campo de financiación nunca es "texto"
  const wrong = records.filter((r) => r.fundingCodes.includes('PRTR') && r.nextgenBy !== 'financiacion');
  t.is(wrong.length, 0, `PRTR con origen incorrecto: ${where(wrong)}`);
});

test('los contratos menores son procedimiento 6 y las licitaciones no', (t) => {
  const wrongMenor = records.filter((r) => r.kind === 'menor' && r.procedure !== 6);
  t.is(wrongMenor.length, 0, `Menores con otro procedimiento: ${where(wrongMenor)}`);
  const wrongLic = records.filter((r) => r.kind === 'licitacion' && r.procedure === 6);
  t.is(wrongLic.length, 0, `Licitaciones como menor: ${where(wrongLic)}`);
});

test('la adjudicación no es posterior a la última actualización del anuncio', (t) => {
  const bad = records.filter((r) => r.awardDate && Date.parse(r.awardDate) > Date.parse(r.updated) + (24 * 3600 * 1000));
  t.is(bad.length, 0, `Adjudicación posterior a la actualización: ${where(bad)}`);
});
