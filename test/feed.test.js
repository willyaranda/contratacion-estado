import test from 'ava';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  MAX_ENTRIES, buildAtom, buildRss, feedEntries, xmlEscape,
} from '../lib/feed.js';
import { SITE_URL } from '../transparencia/site.js';
import { FIXTURES_DUMP, ROOT, tmpDir } from './helpers.js';

const GENERATED = '2026-10-16T12:45:17.823+02:00';
const HOST = new URL(SITE_URL).hostname;

const lic = (over = {}) => ({
  id: 'l-1', kind: 'licitacion', title: 'Obras A', folder: 'ABR/OBR/1', buyer: 'Alcaldía', outcome: null, winners: [],
  published: '2026-10-10', deadline: '2026-10-25', deadlineTime: '14:30', awardDate: null, budgetNet: 12345.5,
  awardedNet: null, url: 'https://example.org/a?x=1&y=2', ...over,
});

const RECORDS = [
  lic(),
  lic({
    id: 'l-2', title: 'Servicio B', published: '2026-09-01', outcome: 'adjudicado', awardDate: '2026-10-15', awardedNet: 1000,
    winners: [{ name: 'ACME SL', nif: 'B1' }, { name: 'ACME SL', nif: 'B1' }],
  }),
  {
    id: 'm-3', kind: 'menor', title: 'Menor C', folder: 'MEN/1', buyer: 'Alcaldía', outcome: 'adjudicado', published: '2026-10-14',
    awardDate: '2026-10-12', winners: [{ name: 'Pepe', nif: 'X' }], budgetNet: 100, awardedNet: 90, url: 'https://example.org/c',
  },
  lic({ id: 'l-old', published: '2026-01-01' }),
  lic({ id: 'l-bad', published: 'no-es-fecha' }),
  { id: 'm-open', kind: 'menor', title: 'Sin adjudicar', outcome: null, awardDate: '2026-10-12', winners: [] },
];

test('una entrada por contrato y tipo, solo últimos 90 días, de más nueva a más antigua', (t) => {
  const entries = feedEntries(RECORDS, GENERATED);
  t.deepEqual(entries.map((e) => [e.date, e.type, e.id.split(':')[2]]), [
    ['2026-10-15', 'adjudicacion', 'l-2-adjudicacion'],
    ['2026-10-12', 'menor', 'm-3-menor'],
    ['2026-10-10', 'licitacion', 'l-1-licitacion'],
    ['2026-09-01', 'licitacion', 'l-2-licitacion'],
  ]);
  t.false(entries.some((e) => /l-old|l-bad|m-open/.test(e.id)));
});

test('el filtro de 90 días es inclusivo en el límite y usa generated, no la fecha actual', (t) => {
  // 2026-10-16 menos 90 días = 2026-07-18
  const at = (published) => feedEntries([lic({ published })], GENERATED).length;
  t.is(at('2026-07-18'), 1);
  t.is(at('2026-07-17'), 0);
  t.deepEqual(feedEntries(RECORDS, 'basura'), []);
});

test('tope de 200 entradas, las más recientes', (t) => {
  const many = Array.from({ length: 300 }, (_, i) => lic({ id: `l-${i}`, published: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}` }));
  const entries = feedEntries(many, GENERATED);
  t.is(entries.length, MAX_ENTRIES);
  t.deepEqual(entries.map((e) => e.date), [...entries.map((e) => e.date)].sort().reverse());
});

test('ids estables, únicos y con esquema tag:', (t) => {
  const ids = feedEntries(RECORDS, GENERATED).map((e) => e.id);
  t.is(new Set(ids).size, ids.length);
  for (const id of ids) t.regex(id, new RegExp(`^tag:${HOST.replace(/\./g, '\\.')},\\d{4}:[lm]-\\w+-(licitacion|adjudicacion|menor)$`));
  t.deepEqual(feedEntries([...RECORDS].reverse(), GENERATED).map((e) => e.id), ids);
});

test('determinista: misma entrada, misma salida byte a byte', (t) => {
  t.is(buildAtom(RECORDS, GENERATED), buildAtom(structuredClone(RECORDS), GENERATED));
  t.is(buildRss(RECORDS, GENERATED), buildRss(structuredClone(RECORDS), GENERATED));
  t.is(buildAtom([...RECORDS].reverse(), GENERATED), buildAtom(RECORDS, GENERATED));
});

test('xmlEscape escapa y elimina caracteres inválidos en XML 1.0', (t) => {
  t.is(xmlEscape(`a & b < c > d "e" 'f'`), 'a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;');
  t.is(xmlEscape('a\u0000b\u0008c\u000Bd\u001Fe￿f\ud800g'), 'abcdefg');
  t.is(xmlEscape('tab\tnl\ncr\r😀ñ'), 'tab\tnl\ncr\r😀ñ');
  t.is(xmlEscape(null), '');
});

test('estructura Atom', (t) => {
  const atom = buildAtom(RECORDS, GENERATED);
  t.true(atom.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="es">'));
  t.true(atom.endsWith('</feed>\n'));
  t.true(atom.includes(`<id>${SITE_URL}feed.xml</id>`));
  t.true(atom.includes('<title>Contratación del Ayuntamiento de Aranda de Duero · Licitaciones y adjudicaciones</title>'));
  t.true(atom.includes(`<link rel="self" type="application/atom+xml" href="${SITE_URL}feed.xml"/>`));
  t.true(atom.includes(`<link rel="alternate" type="text/html" href="${SITE_URL}"/>`));
  t.true(atom.includes('<updated>2026-10-15T00:00:00Z</updated>'));
  t.true(atom.includes('<author><name>Ayuntamiento de Aranda de Duero</name></author>'));
  t.regex(atom, /<generator>/);
  t.is((atom.match(/<entry>/g) ?? []).length, 4);
  t.is((atom.match(/<\/entry>/g) ?? []).length, 4);
  t.true(atom.includes('<title>Adjudicación: Servicio B — ACME SL</title>'));
  t.true(atom.includes('<title>Nueva licitación: Obras A</title>'));
  t.true(atom.includes('<title>Contrato menor adjudicado: Menor C — Pepe</title>'));
  t.true(atom.includes('<link rel="alternate" type="text/html" href="https://example.org/a?x=1&amp;y=2"/>'));
  t.true(atom.includes('<published>2026-10-10T00:00:00Z</published>'));
  t.regex(atom, /<category term="adjudicacion" label="Adjudicación"\/>/);
  t.regex(atom, /<category term="menor"/);
  t.regex(atom, /<category term="licitacion"/);
  t.is((atom.match(/<content type="text">/g) ?? []).length, 4);
  t.true(atom.includes('Órgano de contratación: Alcaldía.'));
  t.true(atom.includes('Presupuesto base de licitación sin IVA: 12.345,50 €.'));
  t.true(atom.includes('Plazo de presentación de ofertas: hasta el 25/10/2026 a las 14:30.'));
  t.true(atom.includes('Adjudicatario: ACME SL.'));
  t.true(atom.includes('Importe de adjudicación sin IVA: 1.000,00 €.'));
  t.true(atom.includes('Expediente: ABR/OBR/1.'));
});

test('estructura RSS', (t) => {
  const rss = buildRss(RECORDS, GENERATED);
  t.true(rss.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">'));
  t.true(rss.endsWith('</channel>\n</rss>\n'));
  t.true(rss.includes(`<link>${SITE_URL}</link>`));
  t.true(rss.includes('<language>es</language>'));
  t.true(rss.includes('<lastBuildDate>Thu, 15 Oct 2026 00:00:00 +0000</lastBuildDate>'));
  t.true(rss.includes(`<atom:link href="${SITE_URL}rss.xml" rel="self" type="application/rss+xml"/>`));
  t.is((rss.match(/<item>/g) ?? []).length, 4);
  t.is((rss.match(/<guid isPermaLink="false">tag:/g) ?? []).length, 4);
  t.true(rss.includes('<pubDate>Sat, 10 Oct 2026 00:00:00 +0000</pubDate>'));
  t.true(rss.includes('<link>https://example.org/a?x=1&amp;y=2</link>'));
  t.regex(rss, /<category>adjudicacion<\/category>/);
});

test('sin entradas: feeds válidos con updated = generated', (t) => {
  t.true(buildAtom([], GENERATED).includes('<updated>2026-10-16T00:00:00Z</updated>'));
  t.true(buildRss([], GENERATED).includes('<lastBuildDate>Fri, 16 Oct 2026 00:00:00 +0000</lastBuildDate>'));
  t.notRegex(buildAtom([], 'basura'), /<updated>/);
});

test('el contenido escapado no rompe el XML', (t) => {
  const atom = buildAtom([lic({ title: 'A <b>&</b> "x"\u0001', buyer: ']]>' })], GENERATED);
  t.true(atom.includes('Nueva licitación: A &lt;b&gt;&amp;&lt;/b&gt; &quot;x&quot;'));
  t.false(atom.includes('\u0001'));
  t.false(atom.includes(']]>'));
});

test('build.js escribe feed.xml y rss.xml, y la plantilla los anuncia', (t) => {
  const out = tmpDir('feed-');
  const r = spawnSync(process.execPath, [join(ROOT, 'transparencia', 'build.js'), '--dump', FIXTURES_DUMP, '--out', out], { encoding: 'utf8' });
  t.is(r.status, 0, r.stderr);
  t.regex(readFileSync(join(out, 'feed.xml'), 'utf8'), /^<\?xml[^>]*\?>\n<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/);
  t.regex(readFileSync(join(out, 'rss.xml'), 'utf8'), /^<\?xml[^>]*\?>\n<rss version="2\.0"/);
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  t.true(html.includes(`<link rel="alternate" type="application/atom+xml" title="Licitaciones y adjudicaciones (Atom)" href="${SITE_URL}feed.xml">`));
  t.true(html.includes(`<link rel="alternate" type="application/rss+xml" title="Licitaciones y adjudicaciones (RSS)" href="${SITE_URL}rss.xml">`));
  // segunda ejecución idéntica
  const out2 = tmpDir('feed-');
  spawnSync(process.execPath, [join(ROOT, 'transparencia', 'build.js'), '--dump', FIXTURES_DUMP, '--out', out2], { encoding: 'utf8' });
  t.is(readFileSync(join(out, 'feed.xml'), 'utf8'), readFileSync(join(out2, 'feed.xml'), 'utf8'));
});
