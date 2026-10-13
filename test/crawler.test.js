import test from 'ava';
import { XMLParser } from 'fast-xml-parser';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from 'fs';
import { join } from 'path';

import { isFromAyuntamiento } from '../lib/ayuntamiento.js';
import { crawl, newestTimestamp } from '../lib/crawler.js';
import { tmpDir } from './helpers.js';

const parser = new XMLParser({ ignoreAttributes: false });
const parseXml = (xml) => parser.parse(xml);

const AYTO = 'Alcaldía del Ayuntamiento de Aranda de Duero';
const HOSPITAL = 'Gerencia de Atención Especializada de Aranda de Duero';

// Anuncio Atom como lo publica PLACE (solo los campos que usa el script)
const atomEntry = ({
  id, updated, party, title = `Anuncio ${id}`,
}) => `
  <entry>
    <id>https://contrataciondelestado.es/sindicacion/licitacionesPerfilContratante/${id}</id>
    <updated>${updated}</updated>
    <title>${title}</title>
    <summary type="text">Id licitación: ${id}/26; Órgano de Contratación: ${party}</summary>
    <link href="https://contrataciondelestado.es/detalle/${id}"/>
    <cac-place-ext:ContractFolderStatus>
      <cbc:ContractFolderID>${id}/26</cbc:ContractFolderID>
      <cac-place-ext:LocatedContractingParty>
        <cac:Party><cac:PartyName><cbc:Name>${party}</cbc:Name></cac:PartyName></cac:Party>
      </cac-place-ext:LocatedContractingParty>
    </cac-place-ext:ContractFolderStatus>
  </entry>`;

const atomFeed = ({ entries = [], next } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Feed de prueba</title>
  <link rel="self" href="https://example.test/self.atom"/>
  ${next ? `<link rel="next" href="${next}"/>` : ''}
  ${entries.map(atomEntry).join('\n')}
</feed>`;

// "Servidor" en memoria: url -> xml. Registra qué páginas se piden.
const server = (pages) => {
  const requested = [];
  const fetchText = async (url) => {
    requested.push(url);
    if (!(url in pages)) throw new Error(`404 ${url}`);
    return pages[url];
  };
  return { fetchText, requested };
};

const run = async (options) => {
  const dumpDir = tmpDir();
  const logs = [];
  const stats = await crawl({
    dumpDir, parseXml, isWanted: isFromAyuntamiento, log: (m) => logs.push(m), ...options,
  });
  return { dumpDir, stats, logs };
};

const filesIn = (dumpDir, sfx) => (existsSync(join(dumpDir, sfx)) ? readdirSync(join(dumpDir, sfx)).sort() : []);

test('guarda solo los anuncios del Ayuntamiento, con el nombre <id>-<ts>.json', async (t) => {
  const { fetchText } = server({
    'https://example.test/p1': atomFeed({
      entries: [
        { id: 1, updated: '2026-03-01T10:00:00.000+01:00', party: AYTO },
        { id: 2, updated: '2026-03-01T11:00:00.000+01:00', party: HOSPITAL },
      ],
    }),
  });
  const { dumpDir, stats } = await run({ url: 'https://example.test/p1', sfx: 'licitaciones', fetchText });

  t.deepEqual(stats, {
    pages: 1, existing: 0, written: 1, newestSeen: Date.parse('2026-03-01T11:00:00.000+01:00'),
  });
  t.deepEqual(filesIn(dumpDir, 'licitaciones'), [`1-${Date.parse('2026-03-01T10:00:00.000+01:00')}.json`]);

  const saved = JSON.parse(readFileSync(join(dumpDir, 'licitaciones', filesIn(dumpDir, 'licitaciones')[0]), 'utf8'));
  t.is(saved.id, 'https://contrataciondelestado.es/sindicacion/licitacionesPerfilContratante/1');
  t.is(saved['cac-place-ext:ContractFolderStatus']['cbc:ContractFolderID'], '1/26');
  t.is(saved.summary['@_type'], 'text');
});

test('sigue los enlaces next y se detiene al encontrar un fichero ya descargado', async (t) => {
  const dumpDir = tmpDir();
  // el anuncio 3 ya estaba descargado en una ejecución anterior
  mkdirSync(join(dumpDir, 'menores'));
  writeFileSync(join(dumpDir, 'menores', `3-${Date.parse('2026-01-03T09:00:00.000+01:00')}.json`), '{}');

  const { fetchText, requested } = server({
    'https://example.test/p1': atomFeed({ next: 'https://example.test/p2', entries: [{ id: 1, updated: '2026-01-05T10:00:00.000+01:00', party: AYTO }] }),
    'https://example.test/p2': atomFeed({
      next: 'https://example.test/p3',
      entries: [
        { id: 2, updated: '2026-01-04T10:00:00.000+01:00', party: AYTO },
        { id: 3, updated: '2026-01-03T09:00:00.000+01:00', party: AYTO },
      ],
    }),
    'https://example.test/p3': atomFeed({ entries: [{ id: 4, updated: '2026-01-02T10:00:00.000+01:00', party: AYTO }] }),
  });
  const logs = [];
  const stats = await crawl({
    url: 'https://example.test/p1', sfx: 'menores', dumpDir, fetchText, parseXml, isWanted: isFromAyuntamiento, log: (m) => logs.push(m),
  });

  t.deepEqual(requested, ['https://example.test/p1', 'https://example.test/p2']); // p3 no se pide
  t.deepEqual(stats, {
    pages: 2, existing: 1, written: 2, newestSeen: Date.parse('2026-01-05T10:00:00.000+01:00'),
  });
  t.is(filesIn(dumpDir, 'menores').length, 3); // 1, 2 y el 3 que ya existía
  t.true(logs.some((m) => /ya descargados/.test(m)));
});

test('recorre todo el feed cuando no hay nada descargado y termina sin enlace next', async (t) => {
  const { fetchText, requested } = server({
    'https://example.test/p1': atomFeed({ next: 'https://example.test/p2', entries: [{ id: 1, updated: '2026-02-01T10:00:00.000+01:00', party: AYTO }] }),
    'https://example.test/p2': atomFeed({ entries: [{ id: 2, updated: '2026-01-01T10:00:00.000+01:00', party: AYTO }] }),
  });
  const { stats } = await run({ url: 'https://example.test/p1', sfx: 'licitaciones', fetchText });
  t.deepEqual(requested, ['https://example.test/p1', 'https://example.test/p2']);
  t.deepEqual(stats, {
    pages: 2, existing: 0, written: 2, newestSeen: Date.parse('2026-02-01T10:00:00.000+01:00'),
  });
});

test('maneja un feed con un único anuncio y un feed sin anuncios', async (t) => {
  const { fetchText } = server({
    'https://example.test/uno': atomFeed({ entries: [{ id: 7, updated: '2026-04-01T08:00:00.000+02:00', party: AYTO }] }),
    'https://example.test/cero': atomFeed({ entries: [] }),
  });
  const uno = await run({ url: 'https://example.test/uno', sfx: 'licitaciones', fetchText });
  t.is(uno.stats.written, 1);
  const cero = await run({ url: 'https://example.test/cero', sfx: 'licitaciones', fetchText });
  t.deepEqual(cero.stats, {
    pages: 1, existing: 0, written: 0, newestSeen: null,
  });
  t.deepEqual(filesIn(cero.dumpDir, 'licitaciones'), []);
});

test('no vuelve a escribir un anuncio ya guardado ni lo notifica', async (t) => {
  const { fetchText } = server({
    'https://example.test/p1': atomFeed({ entries: [{ id: 1, updated: '2026-05-01T10:00:00.000+02:00', party: AYTO }] }),
  });
  const dumpDir = tmpDir();
  const notified = [];
  const base = {
    url: 'https://example.test/p1',
    sfx: 'licitaciones',
    dumpDir,
    fetchText,
    parseXml,
    isWanted: isFromAyuntamiento,
    onNew: async (entry) => { notified.push(entry.id); },
  };
  const first = await crawl(base);
  const second = await crawl(base);
  t.is(first.written, 1);
  t.like(second, { pages: 1, existing: 1, written: 0 });
  t.is(notified.length, 1);
});

test('una nueva versión del mismo anuncio es un fichero distinto', async (t) => {
  const dumpDir = tmpDir();
  const feedAt = (updated) => server({
    'https://example.test/p1': atomFeed({ entries: [{ id: 5, updated, party: AYTO }] }),
  }).fetchText;
  const base = {
    url: 'https://example.test/p1', sfx: 'licitaciones', dumpDir, parseXml, isWanted: isFromAyuntamiento,
  };
  await crawl({ ...base, fetchText: feedAt('2026-06-01T10:00:00.000+02:00') });
  await crawl({ ...base, fetchText: feedAt('2026-06-02T10:00:00.000+02:00') });
  t.is(filesIn(dumpDir, 'licitaciones').length, 2);
});

test('se detiene cuando toda la página es anterior a la última descarga, aunque no haya ficheros conocidos', async (t) => {
  const { fetchText, requested } = server({
    'https://example.test/p1': atomFeed({ next: 'https://example.test/p2', entries: [{ id: 1, updated: '2026-10-12T10:00:00.000+02:00', party: HOSPITAL }] }),
    'https://example.test/p2': atomFeed({ next: 'https://example.test/p3', entries: [{ id: 2, updated: '2026-10-11T10:00:00.000+02:00', party: HOSPITAL }] }),
    // todo lo de esta página es anterior a la marca: no hace falta mirar más
    'https://example.test/p3': atomFeed({ next: 'https://example.test/p4', entries: [{ id: 3, updated: '2026-10-05T10:00:00.000+02:00', party: AYTO }] }),
    'https://example.test/p4': atomFeed({ entries: [{ id: 4, updated: '2026-10-01T10:00:00.000+02:00', party: AYTO }] }),
  });
  const logs = [];
  const stats = await crawl({
    url: 'https://example.test/p1', sfx: 'menores', dumpDir: tmpDir(), fetchText, parseXml, isWanted: isFromAyuntamiento,
    stopBefore: Date.parse('2026-10-08T00:00:00.000+02:00'), log: (m) => logs.push(m),
  });
  t.deepEqual(requested, ['https://example.test/p1', 'https://example.test/p2', 'https://example.test/p3']);
  t.is(stats.pages, 3);
  // la página que ya es anterior a la marca sí se procesa (puede traer anuncios nuevos)
  t.is(stats.written, 1);
  t.true(logs.some((m) => /anterior a la última descarga/.test(m)));
});

test('stopBefore no corta mientras la página tenga algo posterior a la marca', async (t) => {
  const { fetchText, requested } = server({
    'https://example.test/p1': atomFeed({ next: 'https://example.test/p2', entries: [
      { id: 1, updated: '2026-10-12T10:00:00.000+02:00', party: AYTO },
      { id: 2, updated: '2026-10-01T10:00:00.000+02:00', party: AYTO },
    ] }),
    'https://example.test/p2': atomFeed({ entries: [{ id: 3, updated: '2026-09-01T10:00:00.000+02:00', party: AYTO }] }),
  });
  const stats = await crawl({
    url: 'https://example.test/p1', sfx: 'menores', dumpDir: tmpDir(), fetchText, parseXml, isWanted: isFromAyuntamiento,
    stopBefore: Date.parse('2026-10-08T00:00:00.000+02:00'),
  });
  t.is(requested.length, 2);
  t.is(stats.written, 3);
});

test('newestTimestamp devuelve la versión más reciente guardada, o null', async (t) => {
  t.is(await newestTimestamp(join(tmpDir(), 'no-existe')), null);
  const empty = tmpDir();
  t.is(await newestTimestamp(empty), null);
  const dir = tmpDir();
  for (const name of ['100-1500.json', '7-2500.json', '9-2000.json', 'README.md', '.DS_Store']) writeFileSync(join(dir, name), '{}');
  t.is(await newestTimestamp(dir), 2500);
});

test('propaga los errores de descarga y los anuncios mal formados', async (t) => {
  const failing = server({});
  await t.throwsAsync(run({ url: 'https://example.test/nada', sfx: 'licitaciones', fetchText: failing.fetchText }), { message: /404/ });

  const broken = server({
    'https://example.test/roto': atomFeed({ entries: [{ id: 9, updated: 'ayer', party: AYTO }] }),
  });
  await t.throwsAsync(run({ url: 'https://example.test/roto', sfx: 'licitaciones', fetchText: broken.fetchText }), { message: /sin id o fecha/ });
});
