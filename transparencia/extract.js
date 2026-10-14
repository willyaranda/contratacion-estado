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

// Contratos financiados con NextGenerationEU. Los anuncios traen un campo estructurado de financiación
// (cac:TenderingTerms/cbc:FundingProgramCode: PRTR, EU, FEDER, NO-EU…) y un texto de programa (cbc:FundingProgram:
// «PRTR», «PRTR - PSTD», «REACT-EU», «NextGenerationEU»…). Se usan primero; el texto libre del anuncio es respaldo.
// REACT-EU se financia con NextGenerationEU, por eso cuenta.
export const NEXTGEN_RE = /PRTR|Next\s*-?\s*Gen(?:eration)?(?:\s*EU)?|REACT[\s-]?EU|Plan\s+de\s+Recuperaci[oó]n,?\s+Transformaci[oó]n\s+y\s+Resiliencia|Mecanismo\s+de\s+Recuperaci[oó]n\s+y\s+Resiliencia/i;

// Programa europeo al que se asocia el contrato, o null si no consta ninguno de NextGenerationEU.
export const nextGenProgram = (entry) => {
  const terms = entry['cac-place-ext:ContractFolderStatus']?.['cac:TenderingTerms'] || {};
  const codes = asArray(terms['cbc:FundingProgramCode']).map((x) => `${text(x) ?? ''}`);
  const program = asArray(terms['cbc:FundingProgram']).map((x) => `${text(x) ?? ''}`).join(' ');
  const structured = `${codes.join(' ')} ${program}`;
  if (!codes.includes('PRTR') && !NEXTGEN_RE.test(program) && !NEXTGEN_RE.test(JSON.stringify(entry))) return null;
  if (/PRTR/i.test(structured) || /PRTR|Recuperaci[oó]n,?\s+Transformaci/i.test(JSON.stringify(entry))) return 'PRTR';
  if (/REACT/i.test(structured)) return 'REACT-EU';
  return 'NextGenerationEU';
};

// ¿Consta en el campo de financiación del anuncio ('financiacion') o solo se menciona en algún texto ('texto')?
// Hay anuncios con el campo mal rellenado (p. ej. NO-EU) pese a llamarse «PRTR - …».
export const nextGenSource = (entry) => {
  const terms = entry['cac-place-ext:ContractFolderStatus']?.['cac:TenderingTerms'] || {};
  const codes = asArray(terms['cbc:FundingProgramCode']).map((x) => `${text(x) ?? ''}`);
  const program = asArray(terms['cbc:FundingProgram']).map((x) => `${text(x) ?? ''}`).join(' ');
  return codes.includes('PRTR') || NEXTGEN_RE.test(program) ? 'financiacion' : 'texto';
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

// ---------- Ficha del contrato ----------
// Datos adicionales de cada anuncio para la ventana de detalle de la página. Se guardan aparte (details.json) y la
// página los lee solo al abrir una ficha. Los códigos se dejan tal cual: la página los traduce a su nombre oficial.

// Primer valor cuya clave termine en `name` (con o sin prefijo de espacio de nombres: cac:, cbc:, cac-place-ext:…)
const g = (obj, name) => {
  if (!obj || typeof obj !== 'object') return undefined;
  const key = Object.keys(obj).find((k) => k === name || k.endsWith(`:${name}`));
  return key === undefined ? undefined : obj[key];
};

const clip = (x, max = 240) => {
  const v = text(x);
  if (!isPresent(v)) return null;
  const s = `${v}`.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const amount = (x) => {
  const v = num(x);
  return v !== null && Number.isFinite(v) ? v : null;
};
// Quita valores vacíos: null, undefined, '', listas vacías y objetos sin claves
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''
  && !(Array.isArray(v) && v.length === 0)
  && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)));
const cap = (list, n) => list.slice(0, n);

// Todos los documentos de la Plataforma comparten este prefijo: de cada uno solo se guarda su identificador
// (la página reconstruye la URL con `docPrefix`, que va en details.json).
export const DOC_PREFIX = 'https://contrataciondelestado.es/wps/wcm/connect/PLACE_es/Site/area/docAccCmpnt?srv=cmpnt&cmpntname=GetDocumentsById&source=library&DocumentIdParam=';

const docOf = (ref, kind) => {
  const att = g(ref, 'Attachment');
  const ext = g(att, 'ExternalReference');
  const url = clip(g(ext, 'URI'), 400);
  const name = clip(g(ref, 'ID'), 140) || clip(g(ext, 'FileName'), 140);
  if (!url) return null;
  return url.startsWith(DOC_PREFIX) ? clean({ kind, name, id: url.slice(DOC_PREFIX.length) }) : clean({ kind, name, url });
};

export const detailFromEntry = (entry, versions = []) => {
  const cf = entry['cac-place-ext:ContractFolderStatus'];
  const party = asArray(g(g(cf, 'LocatedContractingParty'), 'Party'))[0] || {};
  const addr = g(party, 'PostalAddress') || {};
  const contact = g(party, 'Contact') || {};
  const terms = g(cf, 'TenderingTerms') || {};
  const proc = g(cf, 'TenderingProcess') || {};
  const pp = g(cf, 'ProcurementProject') || {};
  const deadline = asArray(g(proc, 'TenderSubmissionDeadlinePeriod'))[0] || {};
  const results = asArray(g(cf, 'TenderResult'));
  const lotsRaw = asArray(g(cf, 'ProcurementProjectLot'));

  const criteriaOf = (container, lot) => asArray(g(g(container, 'AwardingTerms'), 'AwardingCriteria')).map((c) => clean({
    lot, kind: clip(g(c, 'AwardingCriteriaTypeCode')), text: clip(g(c, 'Description'), 220), weight: amount(g(c, 'WeightNumeric')),
  }));
  const perLot = lotsRaw.map((lot) => criteriaOf(g(lot, 'TenderingTerms'), clip(g(lot, 'ID'))));
  const sig = (list) => JSON.stringify(list.map(({ kind, text: t, weight }) => [kind, t, weight]).sort());
  const sameForAllLots = perLot.length > 1 && perLot.every((l) => sig(l) === sig(perLot[0]));
  const criteria = [
    ...criteriaOf(terms, null),
    // los mismos criterios en todos los lotes: una sola vez, sin lote
    ...(sameForAllLots ? perLot[0].map((c) => clean({ ...c, lot: null })) : perLot.flat()),
  ];

  const lots = lotsRaw.map((lot) => {
    const lp = g(lot, 'ProcurementProject') || {};
    const lb = g(lp, 'BudgetAmount') || {};
    return clean({
      id: clip(g(lot, 'ID')), name: clip(g(lp, 'Name'), 160),
      net: amount(g(lb, 'TaxExclusiveAmount')), total: amount(g(lb, 'TotalAmount')),
    });
  });

  const resultsOut = results.map((r) => {
    const win = g(r, 'WinningParty') || {};
    const loc = g(g(win, 'PhysicalLocation'), 'Address') || {};
    const money = g(g(r, 'AwardedTenderedProject'), 'LegalMonetaryTotal') || {};
    const contract = g(r, 'Contract') || {};
    return clean({
      lot: clip(g(g(r, 'AwardedTenderedProject'), 'ProcurementProjectLotID')),
      code: num(g(r, 'ResultCode')),
      motive: clip(g(r, 'Description'), 320),
      offers: amount(g(r, 'ReceivedTenderQuantity')),
      smeOffers: amount(g(r, 'SMEsReceivedTenderQuantity')),
      sme: typeof g(r, 'SMEAwardedIndicator') === 'boolean' ? g(r, 'SMEAwardedIndicator') : null,
      winner: clip(g(asArray(g(win, 'PartyName'))[0], 'Name'), 140),
      nif: clip(g(asArray(g(win, 'PartyIdentification'))[0], 'ID'), 20),
      city: clip(g(loc, 'CityName'), 60),
      net: amount(g(money, 'TaxExclusiveAmount')), total: amount(g(money, 'PayableAmount')),
      lower: amount(g(r, 'LowerTenderAmount')), higher: amount(g(r, 'HigherTenderAmount')),
      awarded: clip(g(r, 'AwardDate')), contract: clip(g(contract, 'ID')), formalized: clip(g(contract, 'IssueDate')),
      start: clip(g(r, 'StartDate')),
    });
  });

  const docs = [
    ...asArray(g(cf, 'LegalDocumentReference')).map((d) => docOf(d, 'pcap')),
    ...asArray(g(cf, 'TechnicalDocumentReference')).map((d) => docOf(d, 'ppt')),
    ...asArray(g(cf, 'AdditionalDocumentReference')).map((d) => docOf(d, 'otro')),
  ].filter(Boolean);

  const notices = asArray(g(cf, 'ValidNoticeInfo')).map((n) => {
    const status = g(n, 'AdditionalPublicationStatus') || {};
    const refs = asArray(g(status, 'AdditionalPublicationDocumentReference'));
    const dates = refs.map((r) => clip(g(r, 'IssueDate'))).filter(Boolean).sort();
    return clean({
      type: clip(g(n, 'NoticeTypeCode')), medium: clip(g(status, 'PublicationMediaName'), 80), date: dates[0] ?? null,
      docs: cap(refs.map((r) => docOf(r, clip(g(r, 'DocumentTypeCode')))).filter(Boolean), 2),
    });
  });

  const guarantees = asArray(g(terms, 'RequiredFinancialGuarantee')).map((x) => clean({
    type: num(g(x, 'GuaranteeTypeCode')), pct: amount(g(x, 'AmountRate')), amount: amount(g(x, 'LiabilityAmount')),
  }));
  const mods = asArray(g(cf, 'ContractModification')).map((m) => clean({
    net: amount(g(g(m, 'ContractModificationLegalMonetaryTotal'), 'TaxExclusiveAmount')),
    finalNet: amount(g(g(m, 'FinalLegalMonetaryTotal'), 'TaxExclusiveAmount')),
  }));
  const exec = asArray(g(terms, 'ContractExecutionRequirement')).map((x) => clean({
    code: num(g(x, 'ExecutionRequirementCode')), name: clip(g(x, 'Name'), 120), desc: clip(g(x, 'Description'), 240),
  }));
  const ext = g(pp, 'ContractExtension') || {};
  const duration = g(g(pp, 'PlannedPeriod'), 'DurationMeasure');
  const period = g(pp, 'PlannedPeriod') || {};
  const endTime = clip(g(deadline, 'EndTime'));

  return clean({
    org: clean({
      address: [clip(g(asArray(g(addr, 'AddressLine'))[0], 'Line'), 120), clip(g(addr, 'PostalZone'), 10), clip(g(addr, 'CityName'), 60)]
        .filter(Boolean).join(', ') || null,
      phone: clip(g(contact, 'Telephone'), 30), email: clip(g(contact, 'ElectronicMail'), 80), web: clip(g(party, 'WebsiteURI'), 120),
    }),
    proc: clean({
      urgency: num(g(proc, 'UrgencyCode')), submission: num(g(proc, 'SubmissionMethodCode')),
      system: num(g(proc, 'ContractingSystemCode')),
      over: typeof g(proc, 'OverThresholdIndicator') === 'boolean' ? g(proc, 'OverThresholdIndicator') : null,
      lotsMax: amount(g(proc, 'MaximumLotPresentationQuantity')),
    }),
    deadline: clean({ date: clip(g(deadline, 'EndDate')), time: endTime ? endTime.slice(0, 5) : null }),
    duration: isPresent(duration) ? clean({ value: num(duration), unit: clip(duration['@_unitCode'] ?? null, 10) }) : null,
    plannedStart: clip(g(period, 'StartDate')), plannedEnd: clip(g(period, 'EndDate')),
    options: clip(g(ext, 'OptionsDescription'), 200),
    guarantees: cap(guarantees, 4),
    criteria: cap(criteria, 16),
    lots: cap(lots, 24),
    results: cap(resultsOut, 24),
    mods: cap(mods, 6),
    exec: cap(exec, 4),
    subcontract: clip(g(g(terms, 'AllowedSubcontractTerms'), 'Description'), 240),
    appeals: amount(g(terms, 'ReceivedAppealQuantity')),
    docs: cap(docs, 8),
    notices: cap(notices, 8),
    history: versions,
  });
};

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
  const terms = cf['cac:TenderingTerms'] || {};
  const fundingProgram = asArray(terms['cbc:FundingProgram']).map((x) => `${text(x) ?? ''}`.trim()).filter(Boolean).join(' · ');
  const nextgenProgramValue = nextGenProgram(entry);
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
    fundingCodes: asArray(terms['cbc:FundingProgramCode']).map((x) => text(x)).filter(Boolean),
    fundingProgram: fundingProgram || null,
    nextgen: nextgenProgramValue !== null,
    nextgenProgram: nextgenProgramValue,
    nextgenBy: nextgenProgramValue === null ? null : nextGenSource(entry),
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
  const versions = new Map(); // anuncio -> [{ at, status }] de todas sus versiones
  let files = 0;

  for (const dir of SOURCES) {
    for (const file of listDir(join(dumpDir, dir))) {
      if (file.endsWith('.json')) {
        files += 1;
        const entry = JSON.parse(readFileSync(join(dumpDir, dir, file), 'utf8'));
        if (entry['cac-place-ext:ContractFolderStatus'] && isFromAyuntamiento(entry)) {
          const key = `${dir === 'menores' ? 'm' : 'l'}-${entry.id.split('/').pop()}`;
          const list = versions.get(key) || [];
          list.push({ at: entry.updated, status: text(entry['cac-place-ext:ContractFolderStatus']['cbc-place-ext:ContractFolderStatusCode']) ?? null });
          versions.set(key, list);
          const prev = latest.get(key);
          if (!prev || prev.entry.updated < entry.updated) {
            latest.set(key, { entry, dir });
          }
        }
      }
    }
  }

  const records = [...latest.values()].map(({ entry, dir }) => recordFromEntry(entry, dir));
  // Los datos del órgano de contratación se repiten en casi todos los contratos: se guardan una vez y cada ficha
  // lleva el índice (`o`).
  const orgs = [];
  const items = {};
  for (const [key, { entry }] of latest) {
    const { org, ...detail } = detailFromEntry(entry, versions.get(key).sort((a, b) => a.at.localeCompare(b.at)));
    if (org) {
      const sig = JSON.stringify(org);
      let index = orgs.findIndex((o) => JSON.stringify(o) === sig);
      if (index < 0) { orgs.push(org); index = orgs.length - 1; }
      detail.o = index;
    }
    items[key] = detail;
  }
  // Aperturas de ofertas (dump/aperturas.json, lo escribe index.js): solo las licitaciones tienen
  const aperturasFile = join(dumpDir, 'aperturas.json');
  const aperturas = existsSync(aperturasFile) ? JSON.parse(readFileSync(aperturasFile, 'utf8')) : {};
  for (const [id, record] of Object.entries(aperturas)) {
    const item = items[`l-${id}`];
    if (item && (record.events ?? []).length > 0) {
      item.openings = record.events.map((e) => clean({
        type: clip(e.type, 60), sobre: clip(e.sobre, 140), date: e.date, time: e.time,
        place: clip(e.place, 80), address: clip(e.address, 100), public: e.public,
      }));
    }
  }
  const details = { docPrefix: DOC_PREFIX, orgs, items };
  records.sort((a, b) => (b.awardDate || b.updated).localeCompare(a.awardDate || a.updated) || a.id.localeCompare(b.id));

  // "generated" es la fecha del dato más reciente (no la hora del build): sin datos nuevos la página sale
  // idéntica y el commit automático no tiene nada que añadir.
  const generated = records.reduce((max, r) => (r.updated > max ? r.updated : max), '') || new Date().toISOString();

  return { files, generated, records, details };
};
