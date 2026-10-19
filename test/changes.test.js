import test from 'ava';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

import {
  describeChange, documentsOf, previousVersion, statusOf,
} from '../lib/changes.js';
import { buildDigest } from '../lib/notify.js';
import { entryFor, tmpDir } from './helpers.js';

const FOLDER = 'cac-place-ext:ContractFolderStatus';
const doc = (id, name) => ({
  'cbc:ID': name,
  'cac:Attachment': { 'cac:ExternalReference': { 'cbc:URI': `https://x/doc?DocumentIdParam=${id}` } },
});
const version = ({ id = '999', ts, status, docs = [] }) => {
  const e = entryFor('Pleno del Ayuntamiento de Aranda de Duero', {
    id: `https://x/${id}`, updated: new Date(ts).toISOString(),
  });
  e[FOLDER]['cbc-place-ext:ContractFolderStatusCode'] = { '#text': status };
  e[FOLDER]['cac:LegalDocumentReference'] = docs.map(([i, n]) => doc(i, n));
  return e;
};

test('statusOf y documentsOf leen el estado y los documentos', (t) => {
  const e = version({ ts: 1000, status: 'PUB', docs: [['a', 'Pliego.pdf'], ['b', 'Anexo.pdf']] });
  t.is(statusOf(e), 'PUB');
  t.deepEqual([...documentsOf(e).values()], ['Pliego.pdf', 'Anexo.pdf']);
});

test('describeChange detecta cambio de estado y documentos añadidos o retirados', (t) => {
  const before = version({ ts: 1000, status: 'PUB', docs: [['a', 'Pliego.pdf'], ['b', 'Anexo.pdf']] });
  const after = version({ ts: 2000, status: 'EV', docs: [['a', 'Pliego.pdf'], ['c', 'Acta.pdf']] });
  t.deepEqual(describeChange(after, before), {
    isNew: false, status: { from: 'PUB', to: 'EV' }, added: ['Acta.pdf'], removed: ['Anexo.pdf'],
  });
  t.true(describeChange(after, null).isNew);
});

test('previousVersion elige la versión anterior más próxima del mismo anuncio', async (t) => {
  const dir = tmpDir();
  mkdirSync(join(dir, 'licitaciones'));
  const v = (id, ts, status) => {
    const e = version({ id, ts, status });
    writeFileSync(join(dir, 'licitaciones', `${id}-${ts}.json`), JSON.stringify(e));
    return e;
  };
  v('999', 1000, 'PUB');
  v('999', 2000, 'EV');
  v('99', 1500, 'ADJ'); // otro anuncio cuyo id acaba igual
  const current = v('999', 3000, 'ADJ');
  t.is(statusOf(await previousVersion(dir, 'licitaciones', current)), 'EV');
  t.is(await previousVersion(dir, 'menores', current), null);
});

test('buildDigest indica el estado anterior y los cambios de documentos', (t) => {
  const before = version({ ts: 1000, status: 'PUB', docs: [['a', 'Pliego.pdf']] });
  const after = version({ ts: 2000, status: 'EV', docs: [['a', 'Pliego.pdf'], ['c', 'Acta.pdf']] });
  const { body } = buildDigest([after], () => before);
  t.regex(body, /Estado: Publicada -> En evaluación/);
  t.regex(body, /Documentos añadidos \(1\): Acta\.pdf/);
  t.notRegex(body, /retirados/);
  t.regex(buildDigest([after]).body, /Novedad: anuncio nuevo \(estado En evaluación\)/);
});
