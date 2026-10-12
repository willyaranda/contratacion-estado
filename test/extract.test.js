import test from 'ava';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  SOURCES, buildRecords, outcomeOf, recordFromEntry,
} from '../transparencia/extract.js';
import {
  FIXTURES_DUMP, entryFor, loadFixture, tmpDir,
} from './helpers.js';

const record = (dir, name) => recordFromEntry(loadFixture(dir, name), dir);

test('licitación resuelta con un adjudicatario: importes, ganador y fechas', (t) => {
  const r = record('licitaciones', '1007341-1481547245528');
  t.is(r.id, 'l-1007341');
  t.is(r.entry, '1007341');
  t.is(r.folder, '151/16');
  t.is(r.kind, 'licitacion');
  t.is(r.status, 'RES');
  t.is(r.buyer, 'Junta de Gobierno del Ayuntamiento de Aranda de Duero');
  t.is(r.type, 21);
  t.is(r.procedure, 1);
  t.is(r.budgetNet, 13000);
  t.is(r.budgetTotal, 15730);
  t.is(r.estimated, 468000);
  t.is(r.awarded, 12450);
  t.is(r.awardedNet, 12450);
  t.deepEqual(r.winners, [{ name: 'Fundación para el Estudio y la Promocón de la Acción Social (FEPAS)', nif: 'G83273284' }]);
  t.is(r.offers, 4);
  t.is(r.awardDate, '2016-10-21');
  t.is(r.published, '2016-07-04');
  t.is(r.deadline, '2016-07-29');
  t.is(r.updated, '2016-12-12T13:54:05.528+01:00');
  t.deepEqual(r.cpv, [85322000]);
  t.regex(r.url, /^https:\/\/contrataciondelestado\.es\//);
});

test('licitación con varios lotes: suma importes y ofertas, un ganador por lote', (t) => {
  const r = record('licitaciones', '10196911-1662017070602');
  t.is(r.awarded, 40750);
  t.is(r.offers, 8);
  t.is(r.winners.length, 2);
  t.is(r.winners[0].nif, 'A87045423');
  t.is(r.durationMonths, 24);
  t.is(r.buyer, 'Alcaldía del Ayuntamiento de Aranda de Duero');
});

test('contrato menor: se marca por la carpeta de origen', (t) => {
  const r = record('menores', '10094109-1652862625721');
  t.is(r.id, 'm-10094109');
  t.is(r.kind, 'menor');
  t.is(r.procedure, 6);
  t.is(r.awarded, 541.64);
  t.is(r.winners[0].name, 'Impression Tiendas Gráficas, S.L.');
  t.is(r.durationMonths, 3);
});

test('licitación en plazo: sin resultado, con fecha límite y de publicación', (t) => {
  const r = record('licitaciones', '1007341-1462267141275');
  t.is(r.status, 'PUB');
  t.is(r.awarded, null);
  t.is(r.awardedNet, null);
  t.deepEqual(r.winners, []);
  t.is(r.awardDate, null);
  t.is(r.published, '2016-05-03');
  t.is(r.deadline, '2016-06-03');
});

test('resultado con importe 0 (desierto) no cuenta como adjudicado', (t) => {
  const r = record('licitaciones', '1007343-1468580170621');
  t.is(r.status, 'RES');
  t.is(r.awarded, 0);
  t.deepEqual(r.winners, []);
  t.is(r.offers, 0);
});

test('anulada: conserva el estado y no inventa fechas de publicación', (t) => {
  const r = record('licitaciones', '1007341-1467371633406');
  t.is(r.status, 'ANUL');
  t.is(r.published, null);
});

test('recordFromEntry tolera un anuncio casi vacío', (t) => {
  const r = recordFromEntry(entryFor('Alcaldía del Ayuntamiento de Aranda de Duero'), 'licitaciones');
  t.is(r.title, 'Anuncio de prueba');
  t.is(r.type, null);
  t.is(r.awarded, null);
  t.deepEqual(r.winners, []);
  t.deepEqual(r.cpv, []);
  t.is(r.published, null);
  t.is(r.deadline, null);
  t.is(r.durationMonths, null);
  t.is(r.url, 'https://example.test/anuncio');
});

test('buildRecords usa la última versión de cada anuncio y ordena por fecha descendente', (t) => {
  const { files, records, generated } = buildRecords(FIXTURES_DUMP);
  t.is(files, 10);
  // 1007341 tiene 3 versiones en los fixtures (PUB, ANUL, RES): queda una
  t.deepEqual(records.map((r) => r.id), [
    'l-12062354', 'l-11626687', 'l-10344985', 'l-10196911', 'm-10094109', 'l-8386676', 'l-1007341', 'l-1007343',
  ]);
  t.is(records.find((r) => r.id === 'l-1007341').status, 'RES');
  t.is(generated, '2023-03-14T13:17:47.953+01:00');
});

test('buildRecords tolera carpetas inexistentes', (t) => {
  const { files, records, generated } = buildRecords(tmpDir());
  t.is(files, 0);
  t.deepEqual(records, []);
  t.false(Number.isNaN(Date.parse(generated)));
});

test('buildRecords descarta otros organismos, anuncios sin datos y ficheros que no son json', (t) => {
  const dump = tmpDir();
  mkdirSync(join(dump, 'licitaciones'));
  const put = (name, content) => writeFileSync(join(dump, 'licitaciones', name), typeof content === 'string' ? content : JSON.stringify(content));
  put('1-1000.json', entryFor('Gerencia de Atención Especializada de Aranda de Duero'));
  put('2-1000.json', { id: 'https://x/2', updated: '2026-01-01T00:00:00Z' }); // sin ContractFolderStatus
  put('.DS_Store', 'basura');
  put('3-1000.json', entryFor('Pleno del Ayuntamiento de Aranda de Duero', { id: 'https://x/3' }));

  const { files, records } = buildRecords(dump);
  t.is(files, 3);
  t.deepEqual(records.map((r) => r.id), ['l-3']);
});

test('el mismo id en licitaciones y en menores son registros distintos', (t) => {
  const dump = tmpDir();
  for (const dir of ['licitaciones', 'menores']) {
    mkdirSync(join(dump, dir));
    writeFileSync(join(dump, dir, '50-1000.json'), JSON.stringify(entryFor('Alcaldía del Ayuntamiento de Aranda de Duero', { id: 'https://x/50' })));
  }
  const { records } = buildRecords(dump);
  t.deepEqual(records.map((r) => r.id).sort(), ['l-50', 'm-50']);
});

test('outcomeOf clasifica por los códigos de resultado de todos los lotes', (t) => {
  t.is(outcomeOf([]), null);
  for (const code of [1, 2, 8, 9, 11]) t.is(outcomeOf([code]), 'adjudicado', `código ${code}`);
  for (const code of [3, 6, 7]) t.is(outcomeOf([code]), 'desierto', `código ${code}`);
  t.is(outcomeOf([4]), 'desistimiento');
  t.is(outcomeOf([5]), 'renuncia');
  t.is(outcomeOf([10]), 'otro');
  t.is(outcomeOf([99]), 'otro');
  // varios lotes con el mismo resultado conservan el resultado; con resultados distintos es mixto
  t.is(outcomeOf([9, 9, 9]), 'adjudicado');
  t.is(outcomeOf([3, 7]), 'desierto'); // provisional + definitivo: ambos desiertos
  t.is(outcomeOf([8, 3]), 'mixto');
  t.is(outcomeOf([4, 5]), 'mixto');
});

test('resultado de contratos reales: adjudicado, desierto, desistimiento, renuncia y mixto', (t) => {
  const cases = [
    ['licitaciones', '1007341-1481547245528', 'adjudicado', [8]],
    ['menores', '10094109-1652862625721', 'adjudicado', [8]],
    ['licitaciones', '1007343-1468580170621', 'desierto', [3]],
    ['licitaciones', '12062354-1678796267953', 'desistimiento', [4]],
    ['licitaciones', '8386676-1632991834377', 'renuncia', [5]],
    ['licitaciones', '10344985-1663321827016', 'mixto', [9, 9, 9, 9, 3]],
    ['licitaciones', '1007341-1462267141275', null, []], // en plazo: aún sin resultado
    ['licitaciones', '1007341-1467371633406', null, []], // anulada
  ];
  for (const [dir, name, outcome, codes] of cases) {
    const r = record(dir, name);
    t.is(r.outcome, outcome, `${dir}/${name}`);
    t.deepEqual(r.resultCodes, codes, `${dir}/${name}`);
  }
});

test('un contrato parcialmente adjudicado suma solo los lotes adjudicados', (t) => {
  const r = record('licitaciones', '10344985-1663321827016');
  t.is(r.outcome, 'mixto');
  t.is(r.awarded, 30886);
  t.is(r.winners.length, 4); // el lote desierto no aporta adjudicatario
});

test('desierto, desistimiento y renuncia no tienen ganadores ni importe', (t) => {
  for (const name of ['1007343-1468580170621', '12062354-1678796267953', '8386676-1632991834377']) {
    const r = record('licitaciones', name);
    t.is(r.awarded, 0, name);
    t.deepEqual(r.winners, [], name);
  }
});

test('SOURCES incluye las carpetas que genera la descarga', (t) => {
  t.true(SOURCES.includes('licitaciones'));
  t.true(SOURCES.includes('menores'));
});
