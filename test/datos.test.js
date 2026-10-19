import test from 'ava';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  ADJ_FIELDS, FIELDS, LICENSE, PERIODS, buildAdjudicatarios, buildAdjudicatariosCsv, buildContratosCsv,
  buildContratosJson, mandatoOf, periodOf, temporalCoverage, toCsv,
} from '../lib/datos.js';
import { buildRecords } from '../transparencia/extract.js';
import { FIXTURES_DUMP, ROOT, tmpDir } from './helpers.js';

const { records, generated } = buildRecords(FIXTURES_DUMP);

// Parser mínimo de CSV (RFC 4180): comillas dobles, comas y saltos de línea dentro de campos
const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell); rows.push(row); row = []; cell = ''; i += 1;
    } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
};

const rec = (extra) => ({
  id: 'l-1', kind: 'licitacion', updated: '2026-01-05T10:00:00.000+01:00', published: null, awardDate: null, winners: [], ...extra,
});

test('el CSV está bien formado y sus columnas son las del diccionario de datos', (t) => {
  const rows = parseCsv(buildContratosCsv(records));
  t.deepEqual(rows[0], FIELDS.map((f) => f.name));
  t.is(rows.length, records.length + 1);
  t.true(rows.every((row) => row.length === FIELDS.length));
  t.true(rows[0].every((name) => /^[a-z][a-z0-9_]*$/.test(name)));
  t.true(records.length > 0);
});

test('el CSV usa \\r\\n, sin BOM, y termina en salto de línea', (t) => {
  const csv = buildContratosCsv(records);
  t.false(csv.startsWith('﻿'));
  t.true(csv.endsWith('\r\n'));
  t.false(/(?<!\r)\n/.test(csv.replace(/"[^"]*"/g, '')));
});

test('toCsv entrecomilla comas, comillas y saltos de línea dentro de los campos', (t) => {
  const rows = [{ a: 'Obras, mejora "vial"', b: 'línea 1\nlínea 2', c: null, d: 12.5, e: 'x\r\ny' }];
  const text = toCsv(['a', 'b', 'c', 'd', 'e'], rows);
  t.deepEqual(parseCsv(text), [['a', 'b', 'c', 'd', 'e'], ['Obras, mejora "vial"', 'línea 1\nlínea 2', '', '12.5', 'x\r\ny']]);
  t.true(text.includes('"Obras, mejora ""vial"""'));
});

test('el CSV conserva los títulos con comas y los valores vacíos como campo vacío', (t) => {
  const [r] = [rec({ title: 'Suministro, montaje y puesta en marcha', buyer: 'Alcaldía', budgetNet: 100.5, offers: 3 })];
  const [head, row] = parseCsv(buildContratosCsv([r]));
  const get = (name) => row[head.indexOf(name)];
  t.is(get('titulo'), 'Suministro, montaje y puesta en marcha');
  t.is(get('presupuesto_sin_iva'), '100.5');
  t.is(get('num_ofertas'), '3');
  t.is(get('fecha_limite'), '');
  t.is(get('adjudicatarios'), '');
});

test('el JSON es válido: objeto raíz con generado, licencia, fuente y contratos con las claves del diccionario', (t) => {
  const json = JSON.parse(buildContratosJson(records, generated));
  t.is(json.generado, generated);
  t.is(json.licencia.url, LICENSE.url);
  t.is(json.licencia.atribucion, LICENSE.attribution);
  t.truthy(json.fuente.url);
  t.is(json.contratos.length, records.length);
  for (const c of json.contratos) t.deepEqual(Object.keys(c), FIELDS.map((f) => f.name));
  const nulls = json.contratos.flatMap((c) => Object.values(c)).filter((v) => v === '' || v === undefined);
  t.is(nulls.length, 0);
});

test('importes con punto decimal y como números, fechas ISO 8601', (t) => {
  const json = JSON.parse(buildContratosJson(records, generated));
  for (const c of json.contratos) {
    for (const f of FIELDS.filter((x) => x.type === 'número' || x.type === 'entero')) {
      t.true(c[f.name] === null || typeof c[f.name] === 'number', f.name);
    }
    for (const f of FIELDS.filter((x) => x.type === 'fecha')) t.regex(`${c[f.name] ?? '2000-01-01'}`, /^\d{4}-\d{2}-\d{2}$/);
  }
  const csv = buildContratosCsv(records);
  t.notRegex(csv, /"\d+,\d{2}"/);
});

test('los ficheros son deterministas: el mismo input da el mismo contenido byte a byte', (t) => {
  const again = buildRecords(FIXTURES_DUMP);
  t.is(buildContratosCsv(again.records), buildContratosCsv(records));
  t.is(buildContratosJson(again.records, again.generated), buildContratosJson(records, generated));
  t.is(buildAdjudicatariosCsv(again.records), buildAdjudicatariosCsv(records));
});

test('los mandatos tienen cuatro etiquetas con sus fechas de constitución', (t) => {
  t.deepEqual(PERIODS.map((p) => p.label), ['Mandato 11-15', 'Mandato 15-19', 'Mandato 19-23', 'Mandato 23-27']);
  t.deepEqual(PERIODS.map((p) => p.start), ['2011-06-11', '2015-06-14', '2019-06-15', '2023-06-17']);
});

test('periodOf: límites de fecha de los cuatro mandatos (fin = día antes del inicio del siguiente)', (t) => {
  const casos = [
    ['2005-01-01', 0], ['2011-06-10', 0], ['2011-06-11', 0], ['2015-06-13', 0], ['2015-06-14', 1], ['2019-06-14', 1],
    ['2019-06-15', 2], ['2023-06-16', 2], ['2023-06-17', 3], ['2026-10-19', 3],
  ];
  for (const [day, esperado] of casos) t.is(periodOf(day), esperado, day);
});

test('la regla de mandato replica la de la plantilla (periodOf/PERIODS entre marcadores)', (t) => {
  const template = readFileSync(join(ROOT, 'transparencia', 'template.html'), 'utf8');
  const code = template.match(/\/\/ <periodos>\n([\s\S]*?)\/\/ <\/periodos>/)[1];
  const page = new Function(`${code}; return { PERIODS, periodOf };`)();
  t.deepEqual(page.PERIODS, PERIODS);
  for (let year = 2008; year <= 2027; year += 1) {
    for (const day of [`${year}-01-01`, `${year}-06-10`, `${year}-06-11`, `${year}-06-14`, `${year}-06-15`, `${year}-06-16`, `${year}-06-17`, `${year}-12-31`]) {
      t.is(periodOf(day), page.periodOf(day), day);
    }
  }
});

test('mandatoOf: la licitación usa la fecha de publicación y el menor la de adjudicación', (t) => {
  // publicada con el mandato 19-23 y adjudicada ya en el 23-27: cuenta en el 19-23
  const licitacion = rec({ kind: 'licitacion', published: '2023-05-02', awardDate: '2023-08-01' });
  t.is(mandatoOf(licitacion), 'Mandato 19-23');
  // un menor con "publicación" anterior pero adjudicado en el 23-27: cuenta en el 23-27
  const menor = rec({ kind: 'menor', published: '2023-05-02', awardDate: '2023-08-01' });
  t.is(mandatoOf(menor), 'Mandato 23-27');
  // sin fecha de publicación o de adjudicación se usa la de actualización
  t.is(mandatoOf(rec({ kind: 'licitacion', updated: '2016-03-01T09:00:00+01:00' })), 'Mandato 15-19');
  t.is(mandatoOf(rec({ kind: 'menor', published: '2023-05-02', updated: '2020-03-01T09:00:00+01:00' })), 'Mandato 19-23');
  t.is(mandatoOf(rec({ kind: 'licitacion', published: '2011-06-10' })), 'Mandato 11-15');
  t.is(mandatoOf(rec({ kind: 'licitacion', published: '2023-06-17' })), 'Mandato 23-27');
});

test('adjudicatarios: se agrupan por NIF, sin repetir lotes, y el importe se reparte entre adjudicatarios', (t) => {
  const a = { name: 'ARTE SL', nif: 'B1' };
  const b = { name: 'BETA SA', nif: 'B2' };
  const list = buildAdjudicatarios([
    rec({ id: 'l-1', winners: [a, a], awarded: 100, awardedNet: 80 }),
    rec({ id: 'l-2', winners: [a, b], awarded: 50, awardedNet: 40 }),
    rec({ id: 'm-3', kind: 'menor', winners: [{ name: 'Sin NIF', nif: null }], awarded: 10, awardedNet: 8 }),
    rec({ id: 'l-4', winners: [] }),
  ]);
  t.deepEqual(list, [
    { nif: 'B1', nombre: 'ARTE SL', num_contratos: 2, importe_adjudicado_sin_iva: 100, importe_adjudicado_con_iva: 125 },
    { nif: 'B2', nombre: 'BETA SA', num_contratos: 1, importe_adjudicado_sin_iva: 20, importe_adjudicado_con_iva: 25 },
    { nif: null, nombre: 'Sin NIF', num_contratos: 1, importe_adjudicado_sin_iva: 8, importe_adjudicado_con_iva: 10 },
  ]);
  const rows = parseCsv(buildAdjudicatariosCsv(records));
  t.deepEqual(rows[0], ADJ_FIELDS.map((f) => f.name));
  t.true(rows.every((row) => row.length === ADJ_FIELDS.length));
});

test('temporalCoverage: de la primera a la última fecha de publicación o adjudicación', (t) => {
  t.is(temporalCoverage([rec({ published: '2020-03-01', awardDate: '2021-01-02' }), rec({ published: '2019-01-01' })]), '2019-01-01/2021-01-02');
  t.is(temporalCoverage([]), null);
});

test('build.js escribe contratos.csv, contratos.json y adjudicatarios.csv en datos/', (t) => {
  const out = tmpDir('datos-');
  const result = spawnSync(process.execPath, [join(ROOT, 'transparencia', 'build.js'), '--dump', FIXTURES_DUMP, '--out', out], { encoding: 'utf8' });
  t.is(result.status, 0, result.stderr);
  t.is(readFileSync(join(out, 'datos', 'contratos.csv'), 'utf8'), buildContratosCsv(records));
  t.is(readFileSync(join(out, 'datos', 'contratos.json'), 'utf8'), buildContratosJson(records, generated));
  t.is(readFileSync(join(out, 'datos', 'adjudicatarios.csv'), 'utf8'), buildAdjudicatariosCsv(records));
});

test('el código y los datos no mencionan partidos políticos', (t) => {
  const source = readFileSync(join(ROOT, 'lib', 'datos.js'), 'utf8');
  t.notRegex(source, /Sentir|Partido Popular|\bPSOE\b|\bPP\b|Ciudadanos|Podemos|\bVOX\b/i);
  t.notRegex(PERIODS.map((p) => p.label).join(' '), /Sentir|Popular|PSOE/);
});
