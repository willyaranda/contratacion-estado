import test from 'ava';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { parseDocuments, parseEvents, syncAperturas } from '../lib/aperturas.js';
import { buildIcs } from '../lib/ics.js';
import { runJob } from '../lib/job.js';
import { FIXTURES_DUMP, tmpDir } from './helpers.js';

const FIXTURES = join(FIXTURES_DUMP, '..', 'aperturas');
// Extracto real de la ficha de la licitación 20416971 y su XML "Pliego" (Plataforma de Contratación, 2026-10)
const FICHA = readFileSync(join(FIXTURES, 'ficha-20416971.html'), 'utf8');
const PLIEGO_XML = readFileSync(join(FIXTURES, 'pliego-20416971.xml'), 'utf8');
const FICHA_URL = 'https://ficha.test/20416971';

// ---- formato real de la Plataforma

test('parseDocuments lee la tabla de documentos de una ficha real', (t) => {
  const docs = parseDocuments(FICHA);
  t.deepEqual(docs.map((d) => d.name), ['Anuncio de Licitación', 'Pliego', 'Aclaracion listado personal a subroga.pdf']);
  t.is(new Date(docs[1].published).toISOString(), '2026-09-11T07:54:32.000Z');
  t.regex(docs[0].xml, /^https:\/\/contrataciondelestado\.es\/FileSystem\/servlet\/GetDocumentByIdServlet\?cifrado=/);
  t.not(docs[0].xml, docs[1].xml);
  t.is(docs[2].xml, null); // un PDF suelto no tiene XML
});

test('parseEvents lee las tres aperturas de un XML real (incluido un acto sin carácter declarado)', (t) => {
  const events = parseEvents(PLIEGO_XML);
  t.deepEqual(events.map((e) => [e.type, e.date, e.time, e.public]), [
    ['Apertura sobre administrativo', '2026-10-14', '11:30', false],
    ['Apertura sobre oferta técnica', '2026-10-14', '11:45', null],
    ['Apertura sobre oferta económica', '2026-10-21', '11:30', true],
  ]);
  t.is(events[0].place, 'Salón de Plenos');
  t.is(events[0].address, 'PZ MAYOR, 1, ARANDA DE DUERO');
});

// ---- extremo a extremo con el formato real

const ENV = {
  SEND_EMAILS: '1',
  NOTIFY_TO: 'uno@example.com, dos@example.org',
  AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKE0000',
  AWS_SECRET_ACCESS_KEY: 'fake/secret+KEY0123456789abcdefghijklmnopqrstuv',
};

const doc = (id, name) => `<cac:LegalDocumentReference><cbc:ID>${name}</cbc:ID><cac:Attachment><cac:ExternalReference>
  <cbc:URI>https://x/doc?DocumentIdParam=${id}</cbc:URI></cac:ExternalReference></cac:Attachment></cac:LegalDocumentReference>`;

// Anuncio nuevo de una licitación (id 999): pasa de PUB a EV y gana un documento
const feedWithEntry = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>https://contrataciondelestado.es/sindicacion/licitacionesPerfilContratante/999</id>
  <updated>2026-10-14T10:00:00.000+02:00</updated>
  <title>Servicio de ayuda a domicilio</title>
  <summary type="text">Id licitación: T/1; Estado: EV</summary>
  <link href="${FICHA_URL}"/>
  <cac-place-ext:ContractFolderStatus>
    <cbc:ContractFolderID>T/1</cbc:ContractFolderID>
    <cbc-place-ext:ContractFolderStatusCode>EV</cbc-place-ext:ContractFolderStatusCode>
    <cac-place-ext:LocatedContractingParty><cac:Party><cac:PartyName><cbc:Name>Pleno del Ayuntamiento de Aranda de Duero</cbc:Name></cac:PartyName></cac:Party></cac-place-ext:LocatedContractingParty>
    ${doc('a', 'Pliego.pdf')}${doc('b', 'Acta.pdf')}
  </cac-place-ext:ContractFolderStatus></entry></feed>`;

const previousVersion = {
  id: 'https://contrataciondelestado.es/sindicacion/licitacionesPerfilContratante/999',
  updated: '2026-09-11T10:00:00.000+02:00',
  title: 'Servicio de ayuda a domicilio',
  'cac-place-ext:ContractFolderStatus': {
    'cbc:ContractFolderID': 'T/1',
    'cbc-place-ext:ContractFolderStatusCode': 'PUB',
    'cac-place-ext:LocatedContractingParty': { 'cac:Party': { 'cac:PartyName': { 'cbc:Name': 'Pleno del Ayuntamiento de Aranda de Duero' } } },
    'cac:LegalDocumentReference': {
      'cbc:ID': 'Pliego.pdf',
      'cac:Attachment': { 'cac:ExternalReference': { 'cbc:URI': 'https://x/doc?DocumentIdParam=a' } },
    },
  },
};

const feeds = [
  { sfx: 'licitaciones', url: 'https://feed.test/licitaciones' },
  { sfx: 'menores', url: 'https://feed.test/menores' },
];

// Red simulada: feeds, ficha real y XML real.
const fakeWeb = ({ licitaciones = feedWithEntry, fichaFails = false } = {}) => async (url) => {
  if (url === 'https://feed.test/licitaciones') return licitaciones;
  if (url === 'https://feed.test/menores') return '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';
  if (url === FICHA_URL) {
    if (fichaFails) throw new Error('HTTP 500');
    return FICHA;
  }
  if (url.includes('GetDocumentByIdServlet')) return PLIEGO_XML;
  throw new Error(`URL inesperada: ${url}`);
};

const jobDump = () => {
  const dump = tmpDir();
  mkdirSync(join(dump, 'licitaciones'));
  writeFileSync(join(dump, 'licitaciones', `999-${Date.parse(previousVersion.updated)}.json`), JSON.stringify(previousVersion));
  return dump;
};

const sesDouble = () => {
  const sent = [];
  return { sent, createClient: () => ({ send: async (command) => { sent.push(command.input); } }) };
};

test('runJob: descarga el anuncio, consulta sus aperturas reales y las incluye en el correo', async (t) => {
  const dump = jobDump();
  const ses = sesDouble();
  const logs = [];
  const result = await runJob({
    env: ENV, dumpDir: dump, feeds, fetchText: fakeWeb(), createClient: ses.createClient, log: (m) => logs.push(m),
  });
  t.deepEqual(result, { created: 1, aperturasChecked: 1, sent: 1 });

  // ficheros: versión nueva, punto de control y aperturas
  t.is(readdirSync(join(dump, 'licitaciones')).length, 2);
  t.true('licitaciones' in JSON.parse(readFileSync(join(dump, '.state.json'), 'utf8')));
  const store = JSON.parse(readFileSync(join(dump, 'aperturas.json'), 'utf8'));
  t.is(store['999'].events.length, 3);
  t.is(store['999'].source.name, 'Pliego');
  t.is(store['999'].status, 'EV');

  // correo: solo CCO, con el cambio de estado, los documentos y las aperturas
  t.is(ses.sent.length, 1);
  const [message] = ses.sent;
  t.deepEqual(message.Destination, { BccAddresses: ['uno@example.com', 'dos@example.org'] });
  const { Data: body } = message.Message.Body.Text;
  t.regex(body, /Estado: PUB -> EV/);
  t.regex(body, /Documentos añadidos \(1\): Acta\.pdf/);
  t.regex(body, /PRIV · Administrativo: 14\/10\/2026 11:30 · Salón de Plenos · acto no público/);
  t.regex(body, /^ {2}Oferta técnica: 14\/10\/2026 11:45 · Salón de Plenos$/m);
  t.regex(body, /Oferta económica: 21\/10\/2026 11:30 · Salón de Plenos · acto público/);
  t.notRegex(body, /example\.(com|org)/);
  t.true(logs.includes('Aperturas: 1 licitación(es) consultada(s).'));

  // y el calendario sale del mismo fichero
  const ics = buildIcs(store, { now: Date.parse('2026-10-14T00:00:00Z') });
  t.is((ics.match(/BEGIN:VEVENT/g) ?? []).length, 3);
  t.regex(ics, /SUMMARY:PRIV · Administrativo: Servicio de ayuda a domicilio/);
  t.regex(ics, /DTSTART:20261021T093000Z/);
});

test('runJob: si la ficha falla, el aviso sale igualmente y la ficha se reintenta en la siguiente ejecución', async (t) => {
  const dump = jobDump();
  const ses = sesDouble();
  const logs = [];
  const result = await runJob({
    env: ENV, dumpDir: dump, feeds, fetchText: fakeWeb({ fichaFails: true }), createClient: ses.createClient, log: (m) => logs.push(m),
  });
  t.is(result.sent, 1);
  const { Data: body } = ses.sent[0].Message.Body.Text;
  t.regex(body, /Estado: PUB -> EV/);
  t.notRegex(body, /Oferta económica/);
  t.true(logs.some((m) => /no se pudo consultar \(HTTP 500\)/.test(m)));
  t.false('999' in JSON.parse(readFileSync(join(dump, 'aperturas.json'), 'utf8')));

  // siguiente ejecución, ya con la web respondiendo: sin anuncios nuevos, pero las aperturas se recuperan
  const second = await runJob({
    env: ENV, dumpDir: dump, feeds, fetchText: fakeWeb(), createClient: ses.createClient, log: () => {},
  });
  t.deepEqual(second, { created: 0, aperturasChecked: 1, sent: 0 });
  t.is(JSON.parse(readFileSync(join(dump, 'aperturas.json'), 'utf8'))['999'].events.length, 3);
  t.is(ses.sent.length, 1); // sin novedades no se manda otro correo
});

test('runJob: con el aviso desactivado descarga y consulta aperturas sin crear cliente de correo', async (t) => {
  const dump = jobDump();
  const result = await runJob({
    env: {},
    dumpDir: dump,
    feeds,
    fetchText: fakeWeb(),
    createClient: () => { throw new Error('no debe crearse el cliente'); },
    log: () => {},
  });
  t.deepEqual(result, { created: 1, aperturasChecked: 1, sent: 0 });
  t.true(existsSync(join(dump, 'aperturas.json')));
});

test('runJob: un fallo al consultar las aperturas no impide el aviso', async (t) => {
  // sin carpeta de licitaciones en el dump, la sincronización no puede listar versiones
  const dump = tmpDir();
  const ses = sesDouble();
  const warnings = [];
  const noNew = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';
  const result = await runJob({
    env: ENV, dumpDir: dump, feeds, fetchText: fakeWeb({ licitaciones: noNew }), createClient: ses.createClient, log: () => {}, warn: (...a) => warnings.push(a.join(' ')),
  });
  t.deepEqual(result, { created: 0, aperturasChecked: 0, sent: 0 });
  t.regex(warnings[0], /No se pudieron actualizar las aperturas/);
});

test('runJob falla antes de descargar si la configuración del correo es incorrecta', async (t) => {
  let requests = 0;
  const error = await t.throwsAsync(runJob({
    env: { ...ENV, NOTIFY_TO: 'a@x.com,,b@y.org' },
    dumpDir: tmpDir(),
    feeds,
    fetchText: async () => { requests += 1; return ''; },
    createClient: () => { throw new Error('no debe crearse'); },
  }));
  t.regex(error.message, /vacíos/);
  t.is(requests, 0);
});

// ---- sincronización con el formato real

test('syncAperturas con la ficha real elige el documento más reciente con aperturas', async (t) => {
  const dump = tmpDir();
  mkdirSync(join(dump, 'licitaciones'));
  const entry = {
    ...previousVersion,
    id: 'https://x/20416971',
    link: { '@_href': FICHA_URL },
  };
  writeFileSync(join(dump, 'licitaciones', '20416971-1000.json'), JSON.stringify(entry));
  const store = {};
  await syncAperturas({ dumpDir: dump, store, fetchText: fakeWeb() });
  t.is(store['20416971'].source.name, 'Pliego'); // el más reciente de los dos documentos generados
  t.is(store['20416971'].source.published, '2026-09-11T07:54:32.000Z');
  t.is(store['20416971'].events.length, 3);
});
