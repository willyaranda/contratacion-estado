import test from 'ava';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { fontCss, renderPage, toArtifact } from '../transparencia/build.js';
import { FIXTURES_DUMP, ROOT, tmpDir } from './helpers.js';

const TEMPLATE = readFileSync(join(ROOT, 'transparencia', 'template.html'), 'utf8');

// Extrae el JSON de datos incrustado en la página
const embeddedData = (html) => JSON.parse(html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/)[1]);

const buildInto = (out) => spawnSync(
  process.execPath,
  [join(ROOT, 'transparencia', 'build.js'), '--dump', FIXTURES_DUMP, '--out', out],
  { encoding: 'utf8' },
);

test('la plantilla tiene los marcadores que rellena el build', (t) => {
  t.true(TEMPLATE.includes('/*FONTFACE*/'));
  t.true(TEMPLATE.includes('/*DATA*/'));
});

test('fontCss incrusta la fuente Outfit sin referencias externas', (t) => {
  const css = fontCss();
  t.is((css.match(/@font-face/g) || []).length, 2);
  t.regex(css, /data:font\/woff2;base64,[A-Za-z0-9+/]+/);
  t.notRegex(css, /https?:\/\//);
});

test('renderPage incrusta los datos y la fuente, y escapa "<" para no cerrar el script', (t) => {
  const data = { generated: '2026-01-01T00:00:00Z', records: [{ id: 'l-1', title: 'a </script><b>x</b>' }] };
  const html = renderPage(TEMPLATE, data, '/* fuente */');
  t.true(html.includes('/* fuente */'));
  t.false(html.includes('/*DATA*/'));
  t.false(html.includes('/*FONTFACE*/'));
  t.false(html.includes('</script><b>'));
  t.deepEqual(embeddedData(html), data);
});

test('renderPage no interpreta patrones especiales de reemplazo en los datos', (t) => {
  const data = { generated: 'x', records: [{ id: 'l-1', title: "precio $& $1 $' $`" }] };
  t.deepEqual(embeddedData(renderPage(TEMPLATE, data, '')), data);
});

test('toArtifact deja solo title, style y contenido (sin html/head/body)', (t) => {
  const artifact = toArtifact(renderPage(TEMPLATE, { generated: 'x', records: [] }, ''));
  t.regex(artifact, /^<title>[^<]+<\/title>\n<style>/);
  t.notRegex(artifact, /<!doctype|<html|<head>|<body>|<\/body>/i);
  t.true(artifact.includes('id="data"'));
});

test('la página no carga recursos externos (fuente autoalojada)', (t) => {
  const html = renderPage(TEMPLATE, { generated: 'x', records: [] }, fontCss());
  t.notRegex(html, /<script[^>]+src=/);
  t.notRegex(html, /<link[^>]+stylesheet/);
  t.notRegex(html, /fonts\.googleapis|fonts\.gstatic/);
});

test('el build desde la línea de comandos genera data.json, index.html y artifact.html', (t) => {
  const out = tmpDir('build-');
  const result = buildInto(out);
  t.is(result.status, 0, result.stderr);
  for (const file of ['data.json', 'index.html', 'artifact.html']) {
    t.true(existsSync(join(out, file)), file);
  }

  const data = JSON.parse(readFileSync(join(out, 'data.json'), 'utf8'));
  t.is(data.records.length, 8);
  t.deepEqual(embeddedData(readFileSync(join(out, 'index.html'), 'utf8')), data);
  t.deepEqual(embeddedData(readFileSync(join(out, 'artifact.html'), 'utf8')), data);
});

test('el build es determinista: dos ejecuciones dan exactamente el mismo HTML', (t) => {
  const run = () => {
    const out = tmpDir('build-');
    const result = buildInto(out);
    t.is(result.status, 0, result.stderr);
    return readFileSync(join(out, 'index.html'), 'utf8');
  };
  t.is(run(), run());
});
