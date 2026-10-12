// Convierte los ficheros de dump/ en los registros que muestra la página de transparencia.
// Sin efectos secundarios (no escribe ni imprime nada): lo usan transparencia/build.js y los tests.
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import {
  asArray, contractingPartyName, isFromAyuntamiento, isPresent, text,
} from '../lib/ayuntamiento.js';

// Carpetas de dump/ que se leen. Las licitaciones y los menores se tratan como universos distintos
// (un mismo id puede existir en ambos feeds).
export const SOURCES = ['licitaciones', 'menores', 'other', 'agregacion'];

// Resultado del procedimiento (cbc:ResultCode, lista oficial TenderResultCode de la Plataforma):
//   1 adjudicado provisionalmente, 2 adjudicado definitivamente, 8 adjudicado, 9 formalizado, 11 encargo formalizado
//   3 desierto, 6 desierto provisionalmente, 7 desierto definitivamente
//   4 desistimiento, 5 renuncia, 10 licitador mejor valorado (requerimiento de documentación, aún no adjudicado)
const OUTCOME_BY_CODE = {
  1: 'adjudicado', 2: 'adjudicado', 8: 'adjudicado', 9: 'adjudicado', 11: 'adjudicado',
  3: 'desierto', 6: 'desierto', 7: 'desierto',
  4: 'desistimiento',
  5: 'renuncia',
};

// Resultado de un contrato a partir de los códigos de todos sus lotes:
//   null          sin resultado todavía (en plazo, en evaluación o anulado)
//   'adjudicado' | 'desierto' | 'desistimiento' | 'renuncia'   todos los lotes igual
//   'mixto'       lotes con resultados distintos (p. ej. unos adjudicados y otro desierto)
//   'otro'        códigos sin interpretación clara (p. ej. 10, mejor valorado)
export const outcomeOf = (codes) => {
  if (codes.length === 0) return null;
  const outcomes = new Set(codes.map((code) => OUTCOME_BY_CODE[code] ?? 'otro'));
  return outcomes.size === 1 ? [...outcomes][0] : 'mixto';
};

const num = (x) => {
  const v = text(x);
  return !isPresent(v) || v === '' ? null : Number(v);
};

// Fecha de publicación: primera fecha del anuncio de licitación (DOC_CN); si no hay, la primera de cualquier anuncio.
const noticeDates = (cf, types) => asArray(cf['cac-place-ext:ValidNoticeInfo'])
  .filter((v) => !types || types.includes(text(v['cbc-place-ext:NoticeTypeCode'])))
  .flatMap((v) => asArray(v['cac-place-ext:AdditionalPublicationStatus']))
  .flatMap((s) => asArray(s['cac-place-ext:AdditionalPublicationDocumentReference']))
  .map((r) => r['cbc:IssueDate'])
  .filter(Boolean)
  .sort();

// Un anuncio del feed -> un registro plano. `dir` es la carpeta de origen ('menores' marca los contratos menores).
export const recordFromEntry = (entry, dir) => {
  const cf = entry['cac-place-ext:ContractFolderStatus'];
  const pp = cf['cac:ProcurementProject'] || {};
  const budget = pp['cac:BudgetAmount'] || {};
  const results = asArray(cf['cac:TenderResult']);
  const proc = cf['cac:TenderingProcess'] || {};
  const entryId = entry.id.split('/').pop();

  const resultCodes = results.map((result) => num(result['cbc:ResultCode'])).filter(isPresent);
  const winners = [];
  let awarded = 0;
  let awardedNet = 0;
  let awardDate = null;
  let offers = null;
  for (const result of results) {
    const totals = result['cac:AwardedTenderedProject']?.['cac:LegalMonetaryTotal'] || {};
    const pay = num(totals['cbc:PayableAmount']);
    const net = num(totals['cbc:TaxExclusiveAmount']);
    for (const party of asArray(result['cac:WinningParty'])) {
      const name = text(asArray(party['cac:PartyName'])[0]?.['cbc:Name']);
      const nif = text(asArray(party['cac:PartyIdentification'])[0]?.['cbc:ID']);
      if (name) winners.push({ name: name.trim(), nif: nif || null });
    }
    if (isPresent(pay)) awarded += pay;
    if (isPresent(net)) awardedNet += net;
    awardDate = awardDate || result['cbc:AwardDate'] || null;
    if (isPresent(result['cbc:ReceivedTenderQuantity'])) offers = (offers || 0) + Number(result['cbc:ReceivedTenderQuantity']);
  }

  const duration = pp['cac:PlannedPeriod']?.['cbc:DurationMeasure'];
  return {
    id: `${dir === 'menores' ? 'm' : 'l'}-${entryId}`,
    entry: entryId,
    folder: cf['cbc:ContractFolderID'] ?? null,
    title: (pp['cbc:Name'] || entry.title || '').trim(),
    buyer: contractingPartyName(entry),
    kind: dir === 'menores' ? 'menor' : 'licitacion',
    status: text(cf['cbc-place-ext:ContractFolderStatusCode']) ?? null,
    type: num(pp['cbc:TypeCode']),
    subtype: num(pp['cbc:SubTypeCode']),
    procedure: num(proc['cbc:ProcedureCode']),
    cpv: asArray(pp['cac:RequiredCommodityClassification']).map((c) => text(c['cbc:ItemClassificationCode'])).filter(Boolean),
    budgetNet: num(budget['cbc:TaxExclusiveAmount']),
    budgetTotal: num(budget['cbc:TotalAmount']),
    estimated: num(budget['cbc:EstimatedOverallContractAmount']),
    awarded: results.length ? awarded : null,
    awardedNet: results.length ? awardedNet : null,
    resultCodes,
    outcome: outcomeOf(resultCodes),
    winners,
    offers,
    awardDate,
    published: noticeDates(cf, ['DOC_CN'])[0] ?? noticeDates(cf)[0] ?? null,
    deadline: asArray(proc['cac:TenderSubmissionDeadlinePeriod'])[0]?.['cbc:EndDate'] ?? null,
    updated: entry.updated,
    durationMonths: duration && duration['@_unitCode'] === 'MON' ? Number(text(duration)) : null,
    url: entry.link?.['@_href'] || null,
  };
};

// Orden alfabético y carpetas opcionales: la salida no depende del sistema de ficheros ni de que exista cada carpeta.
const listDir = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

// Lee dump/ y devuelve los registros del Ayuntamiento. De cada anuncio (que puede tener varias versiones, una por
// fichero) se queda con la más reciente.
export const buildRecords = (dumpDir) => {
  const latest = new Map();
  let files = 0;

  for (const dir of SOURCES) {
    for (const file of listDir(join(dumpDir, dir))) {
      if (file.endsWith('.json')) {
        files += 1;
        const entry = JSON.parse(readFileSync(join(dumpDir, dir, file), 'utf8'));
        if (entry['cac-place-ext:ContractFolderStatus'] && isFromAyuntamiento(entry)) {
          const key = `${dir === 'menores' ? 'm' : 'l'}-${entry.id.split('/').pop()}`;
          const prev = latest.get(key);
          if (!prev || prev.entry.updated < entry.updated) {
            latest.set(key, { entry, dir });
          }
        }
      }
    }
  }

  const records = [...latest.values()].map(({ entry, dir }) => recordFromEntry(entry, dir));
  records.sort((a, b) => (b.awardDate || b.updated).localeCompare(a.awardDate || a.updated) || a.id.localeCompare(b.id));

  // "generated" es la fecha del dato más reciente (no la hora del build): sin datos nuevos la página sale
  // idéntica y el commit automático no tiene nada que añadir.
  const generated = records.reduce((max, r) => (r.updated > max ? r.updated : max), '') || new Date().toISOString();

  return { files, generated, records };
};
