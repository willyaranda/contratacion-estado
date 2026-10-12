import test from 'ava';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  DOC_PREFIX, SOURCES, buildRecords, detailFromEntry, nextGenProgram, nextGenSource, outcomeOf, recordFromEntry,
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
  t.is(files, 15);
  // 1007341 tiene 3 versiones en los fixtures (PUB, ANUL, RES): queda una
  t.deepEqual(records.map((r) => r.id), [
    'l-18074070', 'l-12305268', 'l-12581278', 'l-12062354', 'l-11626687', 'l-11055187', 'm-11997705',
    'l-10344985', 'l-10196911', 'm-10094109', 'l-8386676', 'l-1007341', 'l-1007343',
  ]);
  t.is(records.find((r) => r.id === 'l-1007341').status, 'RES');
  t.is(generated, '2026-01-30T14:29:10.555+01:00');
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

test('NextGenerationEU: PRTR consta en el campo de financiación (que puede traer varios códigos)', (t) => {
  const r = record('licitaciones', '11055187-1702891820880');
  t.deepEqual(r.fundingCodes, ['EU', 'PRTR']);
  t.true(r.nextgen);
  t.is(r.nextgenProgram, 'PRTR');
  t.is(r.nextgenBy, 'financiacion');
});

test('NextGenerationEU: REACT-EU cuenta, aunque el código sea EU + FEDER', (t) => {
  const r = record('licitaciones', '12305268-1686900863185');
  t.deepEqual(r.fundingCodes, ['EU', 'FEDER']);
  t.is(r.fundingProgram, 'REACT-EU');
  t.is(r.nextgenProgram, 'REACT-EU');
  t.is(r.nextgenBy, 'financiacion');
});

test('NextGenerationEU: contratos que lo mencionan pero declaran NO-EU se señalan como "texto"', (t) => {
  const prtr = record('licitaciones', '18074070-1769779750555');
  t.deepEqual(prtr.fundingCodes, ['NO-EU']);
  t.true(prtr.nextgen);
  t.is(prtr.nextgenProgram, 'PRTR');
  t.is(prtr.nextgenBy, 'texto');
  const menor = record('menores', '11997705-1675620018843');
  t.true(menor.nextgen);
  t.is(menor.nextgenBy, 'texto');
});

test('otros fondos europeos (FEDER) no se cuentan como NextGenerationEU', (t) => {
  const r = record('licitaciones', '12581278-1683900221244');
  t.deepEqual(r.fundingCodes, ['EU', 'FEDER']);
  t.false(r.nextgen);
  t.is(r.nextgenProgram, null);
  t.is(r.nextgenBy, null);
});

test('un contrato sin financiación europea no es NextGenerationEU', (t) => {
  const r = record('licitaciones', '1007341-1481547245528');
  t.false(r.nextgen);
  t.deepEqual(r.fundingCodes, []);
});

test('nextGenProgram reconoce el campo, el texto del programa y la mención en el anuncio', (t) => {
  const withTerms = (terms, extra = {}) => ({
    ...entryFor('Alcaldía del Ayuntamiento de Aranda de Duero', extra),
    'cac-place-ext:ContractFolderStatus': {
      'cac-place-ext:LocatedContractingParty': { 'cac:Party': { 'cac:PartyName': { 'cbc:Name': 'Alcaldía del Ayuntamiento de Aranda de Duero' } } },
      'cac:TenderingTerms': terms,
    },
  });
  t.is(nextGenProgram(withTerms({ 'cbc:FundingProgramCode': [{ '#text': 'EU' }, { '#text': 'PRTR' }] })), 'PRTR');
  t.is(nextGenProgram(withTerms({ 'cbc:FundingProgramCode': 'EU', 'cbc:FundingProgram': 'REACT-EU' })), 'REACT-EU');
  t.is(nextGenProgram(withTerms({ 'cbc:FundingProgramCode': 'EU', 'cbc:FundingProgram': 'NextGenerationEU' })), 'NextGenerationEU');
  t.is(nextGenProgram(withTerms({ 'cbc:FundingProgramCode': 'NO-EU' }, { title: 'Obras PRTR - rehabilitación' })), 'PRTR');
  t.is(nextGenProgram(withTerms({ 'cbc:FundingProgramCode': 'NO-EU' })), null);
  t.is(nextGenProgram(withTerms({})), null);
  t.is(nextGenProgram({}), null);
  t.is(nextGenSource(withTerms({ 'cbc:FundingProgramCode': 'PRTR' })), 'financiacion');
  t.is(nextGenSource(withTerms({ 'cbc:FundingProgramCode': 'NO-EU' }, { title: 'PRTR' })), 'texto');
});

// ---- ficha del contrato

const folder = (inner) => ({
  ...entryFor('Alcaldía del Ayuntamiento de Aranda de Duero'),
  'cac-place-ext:ContractFolderStatus': {
    'cac-place-ext:LocatedContractingParty': { 'cac:Party': { 'cac:PartyName': { 'cbc:Name': 'Alcaldía del Ayuntamiento de Aranda de Duero' } } },
    ...inner,
  },
});

test('detalle de un contrato con lotes: lotes, criterios y resultado por lote', (t) => {
  const d = detailFromEntry(loadFixture('licitaciones', '10344985-1663321827016'));
  t.is(d.lots.length, 5);
  t.is(d.lots[0].id, '1');
  t.is(d.lots[0].name, 'lote 1: actividades de navidad');
  t.is(d.lots[0].net, 5400);
  t.deepEqual(d.criteria.filter((c) => c.lot === '1').map((c) => [c.kind, c.weight]).sort(), [['OBJ', 60], ['SUBJ', 3], ['SUBJ', 30], ['SUBJ', 7]]);
  t.is(d.results.length, 5);
  t.is(d.results[0].winner, 'Mack producciones S.C');
  t.is(d.results[0].nif, 'J09583741');
  t.is(d.results[0].lot, '1');
  t.is(d.results[0].offers, 3);
  t.true(d.results[0].sme);
  t.is(d.results[0].formalized, '2022-09-08');
  t.regex(d.results[0].motive, /^Motivación para adjudicar a Mack/);
  t.deepEqual(d.guarantees.map((g) => [g.type, g.pct]), [[3, 5], [2, 5]]);
  t.is(d.proc.urgency, 1);
  t.is(d.proc.submission, 1);
  t.is(d.deadline.date, '2022-06-27');
  t.deepEqual(d.duration, { value: 24, unit: 'MON' });
});

test('los criterios iguales en todos los lotes se guardan una sola vez, sin lote', (t) => {
  const criteria = { 'cac:AwardingTerms': { 'cac:AwardingCriteria': [
    { 'cbc:AwardingCriteriaTypeCode': { '#text': 'OBJ' }, 'cbc:Description': 'Precio', 'cbc:WeightNumeric': 60 },
    { 'cbc:AwardingCriteriaTypeCode': { '#text': 'SUBJ' }, 'cbc:Description': 'Memoria técnica', 'cbc:WeightNumeric': 40 },
  ] } };
  const lot = (id) => ({ 'cbc:ID': { '#text': id }, 'cac:TenderingTerms': criteria });
  const d = detailFromEntry(folder({ 'cac:ProcurementProjectLot': [lot(1), lot(2), lot(3)] }));
  t.is(d.criteria.length, 2);
  t.true(d.criteria.every((c) => c.lot === undefined));
  t.deepEqual(d.criteria.map((c) => c.weight), [60, 40]);
});

test('los documentos de la Plataforma guardan solo el identificador; los demás, la URL', (t) => {
  const ref = (id, uri) => ({
    'cbc:ID': id, 'cac:Attachment': { 'cac:ExternalReference': { 'cbc:URI': uri } },
  });
  const d = detailFromEntry(folder({
    'cac:LegalDocumentReference': ref('pliego.pdf', `${DOC_PREFIX}abc-123`),
    'cac:AdditionalDocumentReference': [ref('anexo.docx', 'https://example.test/anexo.docx'), { 'cbc:ID': 'sin-url.pdf' }],
  }));
  t.deepEqual(d.docs, [
    { kind: 'pcap', name: 'pliego.pdf', id: 'abc-123' },
    { kind: 'otro', name: 'anexo.docx', url: 'https://example.test/anexo.docx' },
  ]);
});

test('detalle: modificaciones, condiciones de ejecución y tolerancia a anuncios casi vacíos', (t) => {
  const d = detailFromEntry(folder({
    'cac-place-ext:ContractModification': {
      'cbc:ID': 1,
      'cac-place-ext:ContractModificationLegalMonetaryTotal': { 'cbc:TaxExclusiveAmount': { '#text': 41518.6 } },
      'cac-place-ext:FinalLegalMonetaryTotal': { 'cbc:TaxExclusiveAmount': { '#text': 252179.27 } },
    },
    'cac:TenderingTerms': { 'cac:ContractExecutionRequirement': { 'cbc:ExecutionRequirementCode': { '#text': 1 }, 'cbc:Name': 'Ambiental', 'cbc:Description': 'Según anexo XI.' } },
  }));
  t.deepEqual(d.mods, [{ net: 41518.6, finalNet: 252179.27 }]);
  t.deepEqual(d.exec, [{ code: 1, name: 'Ambiental', desc: 'Según anexo XI.' }]);

  const empty = detailFromEntry(folder({}));
  t.deepEqual(empty, {});
});

test('la ficha incluye el histórico de versiones del anuncio, ordenado por fecha', (t) => {
  const { details } = buildRecords(FIXTURES_DUMP);
  const h = details.items['l-1007341'].history;
  t.deepEqual(h.map((v) => v.status), ['PUB', 'ANUL', 'RES']);
  t.deepEqual(h.map((v) => v.at), [...h.map((v) => v.at)].sort());
});

test('buildRecords devuelve fichas de todos los contratos y los órganos compartidos', (t) => {
  const { records, details } = buildRecords(FIXTURES_DUMP);
  t.is(details.docPrefix, DOC_PREFIX);
  t.deepEqual(Object.keys(details.items).sort(), records.map((r) => r.id).sort());
  t.true(details.orgs.length >= 1 && details.orgs.length <= 3);
  for (const item of Object.values(details.items)) {
    if (item.o !== undefined) t.truthy(details.orgs[item.o]);
  }
});

test('SOURCES incluye las carpetas que genera la descarga', (t) => {
  t.true(SOURCES.includes('licitaciones'));
  t.true(SOURCES.includes('menores'));
});
