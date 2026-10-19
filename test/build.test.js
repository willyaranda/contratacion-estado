import test from 'ava';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import {
  assetUris, fontCss, renderPage, toArtifact,
} from '../transparencia/build.js';
import { FIXTURES_DUMP, ROOT, tmpDir } from './helpers.js';

const TEMPLATE = readFileSync(join(ROOT, 'transparencia', 'template.html'), 'utf8');

// Extrae el JSON de datos incrustado en la página
const embeddedData = (html) => JSON.parse(html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/)[1]);
const embeddedDetails = (html) => JSON.parse(html.match(/<script type="application\/json" id="details">([\s\S]*?)<\/script>/)[1]);

const buildInto = (out) => spawnSync(
  process.execPath,
  [join(ROOT, 'transparencia', 'build.js'), '--dump', FIXTURES_DUMP, '--out', out],
  { encoding: 'utf8' },
);

test('la plantilla tiene los marcadores que rellena el build', (t) => {
  t.true(TEMPLATE.includes('/*FONTFACE*/'));
  t.true(TEMPLATE.includes('/*DATA*/'));
});

test('la cabecera enlaza al calendario de aperturas (.ics)', (t) => {
  t.regex(TEMPLATE, /<header class="top">[\s\S]*<a href="aperturas\.ics"[^>]*>Calendario de Contratación<\/a>[\s\S]*<\/header>/);
});

test('la pestaña de Sentir Aranda está oculta salvo que se abra #sentiraranda', (t) => {
  t.regex(TEMPLATE, /const HIDDEN_TABS = new Set\(\["sentiraranda"\]\)/);
  // la barra solo pinta las visibles, y abrir la dirección la revela
  t.regex(TEMPLATE, /\$\("tabs"\)\.innerHTML = visibleTabs\(\)\.map\(/);
  t.regex(TEMPLATE, /if \(HIDDEN_TABS\.has\(t\)\) revealedTabs\.add\(t\);/);
  t.notRegex(TEMPLATE, /\$\("tabs"\)\.innerHTML = TABS\.map\(/);
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
  for (const file of ['data.json', 'details.json', 'index.html', 'artifact.html']) {
    t.true(existsSync(join(out, file)), file);
  }

  const data = JSON.parse(readFileSync(join(out, 'data.json'), 'utf8'));
  t.is(data.records.length, 13);
  t.deepEqual(embeddedData(readFileSync(join(out, 'index.html'), 'utf8')), data);
  t.deepEqual(embeddedData(readFileSync(join(out, 'artifact.html'), 'utf8')), data);

  // las fichas van aparte y la página las lleva incrustadas
  const details = JSON.parse(readFileSync(join(out, 'details.json'), 'utf8'));
  t.is(Object.keys(details.items).length, 13);
  t.deepEqual(embeddedDetails(readFileSync(join(out, 'index.html'), 'utf8')), details);
});

test('renderPage incrusta las fichas y escapa "<" en ellas', (t) => {
  const details = { docPrefix: 'x', orgs: [], items: { 'l-1': { subcontract: 'a </script><img onerror=1> b' } } };
  const html = renderPage(TEMPLATE, { generated: 'x', records: [] }, '', {}, details);
  t.false(html.includes('/*DETAILS*/'));
  t.false(html.includes('</script><img'));
  t.deepEqual(embeddedDetails(html), details);
});

test('los logotipos de NextGenerationEU se incrustan y no queda ningún marcador', (t) => {
  const uris = assetUris();
  t.deepEqual(Object.keys(uris).sort(), ['__LOGO_EU__', '__LOGO_NGEU__', '__LOGO_PRTR__']);
  for (const uri of Object.values(uris)) t.regex(uri, /^data:image\/(svg\+xml|webp);base64,[A-Za-z0-9+/=]+$/);

  const html = renderPage(TEMPLATE, { generated: 'x', records: [] }, '', uris);
  t.notRegex(html, /__LOGO_[A-Z]+__/);
  t.is((html.match(/src="data:image\//g) || []).length, 3);
  // el contenido de los SVG no debe poder ejecutar nada
  for (const uri of [uris.__LOGO_EU__, uris.__LOGO_PRTR__]) {
    const svg = Buffer.from(uri.split(',')[1], 'base64').toString('utf8');
    t.notRegex(svg, /<script|onload=|javascript:/i);
  }
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

test('las etiquetas de resultado se colorean por resultado (verde, azul, amarillo, diagonal, rojo)', (t) => {
  const rule = (sel) => TEMPLATE.match(new RegExp(`\\.tag\\.${sel}[^{]*\\{([^}]*)\\}`))?.[1] ?? '';
  t.regex(rule('out-adjudicado'), /--o-ok-bg/);
  t.regex(rule('out-none'), /--o-info-bg/); // sin resultado todavía: azul (no verde)
  t.notRegex(rule('out-none'), /--o-ok-bg/);
  t.regex(rule('out-desierto'), /--o-warn-bg/);
  t.regex(rule('out-renuncia'), /--o-bad-bg/);
  t.regex(rule('out-desistimiento'), /--o-bad-bg/);
  // parcialmente adjudicado: amarillo / naranja con corte duro a 135deg
  t.regex(rule('out-mixto'), /linear-gradient\(135deg,var\(--o-warn-bg\) 50%,var\(--o-mid-bg\) 50%\)/);
  t.notRegex(TEMPLATE, /\.tag\.out-otro/); // 'otro' conserva el chip neutro
  // variables definidas en claro y en las dos variantes oscuras
  t.is(TEMPLATE.match(/--o-ok-bg:#/g).length, 3);
  t.is(TEMPLATE.match(/--o-mid-bg:#/g).length, 3);
  for (const v of ['--o-info-bg', '--o-info-bd', '--k-maj-bg', '--k-maj-bd', '--k-min-bg', '--k-min-bd']) t.is(TEMPLATE.match(new RegExp(`${v}:#`, 'g')).length, 3, v);
});

test('la clase del contrato es "Cont. mayor"/"Cont. menor" con color propio', (t) => {
  t.regex(TEMPLATE, /const KIND = \{licitacion:"Cont\. mayor",menor:"Cont\. menor"\}/);
  const rule = (sel) => TEMPLATE.match(new RegExp(`\\.tag\\.${sel}[^{]*\\{([^}]*)\\}`))?.[1] ?? '';
  t.regex(rule('kind-licitacion'), /--k-maj-bg/);
  t.regex(rule('kind-menor'), /--k-min-bg/);
  t.regex(TEMPLATE, /const kindTag = \(k\) => `<span class="tag kind-\$\{k\}">/);
  t.regex(TEMPLATE, /const badges = \[kindTag\(r\.kind\)/); // detalle
  t.regex(TEMPLATE, /\$\{kindTag\(r\.kind\)\}/); // listado
});

test('las etiquetas de estado se colorean por código de la Plataforma', (t) => {
  const rule = (code) => TEMPLATE.match(new RegExp(`[^\\n]*\\.tag\\.st-${code}[^{]*\\{([^}]*)\\}`))?.[0] ?? '';
  t.regex(rule('ADJ'), /--o-warn-bg/); // amarillo
  t.regex(rule('EV'), /--o-mid-bg/); // naranja
  t.regex(rule('RES'), /--o-ok-bg/); // verde
  t.regex(rule('PUB'), /--o-info-bg/); // azul
  t.regex(rule('ANUL'), /--o-bad-bg/); // rojo
  t.regex(TEMPLATE, /label:"Estado"[^\n]*statusTag\(r\.status\)/);
  t.regex(TEMPLATE, /r\.outcome \? outTag\(r\.outcome, OUTCOME\[r\.outcome\]\) : r\.status \? statusTag\(r\.status\)/);
});

test('la columna Resultado y las insignias del detalle usan outTag', (t) => {
  t.regex(TEMPLATE, /const outTag = \(o, text\) => `<span class="tag out-\$\{o \|\| "none"\}">/);
  t.regex(TEMPLATE, /label:"Resultado"[^\n]*outTag\(r\.outcome, r\.outcome \? OUTCOME\[r\.outcome\] \|\| r\.outcome : "Sin resultado todavía"\)/);
  t.regex(TEMPLATE, /const badges = [^\n]*outTag\(r\.outcome, OUTCOME\[r\.outcome\]\)/);
});

// La asignación de corporación vive en la plantilla (entre marcadores): se evalúa tal cual
const periodsApi = () => {
  const code = TEMPLATE.match(/\/\/ <periodos>\n([\s\S]*?)\/\/ <\/periodos>/)[1];
  return new Function(`${code}; return { PERIODS, periodOf };`)();
};

test('la página distingue cuatro mandatos, de 11-15 a 23-27, con sus fechas de constitución', (t) => {
  const { PERIODS } = periodsApi();
  t.deepEqual(PERIODS.map((p) => p.label), ['Mandato 11-15', 'Mandato 15-19', 'Mandato 19-23', 'Mandato 23-27']);
  t.deepEqual(PERIODS.map((p) => p.start), ['2011-06-11', '2015-06-14', '2019-06-15', '2023-06-17']);
});

test('periodOf asigna cada fecha al mandato en curso (fin = día antes del inicio del siguiente)', (t) => {
  const { periodOf } = periodsApi();
  const casos = [
    ['2010-01-01', 0], ['2011-06-10', 0], ['2011-06-11', 0], ['2015-06-13', 0],
    ['2015-06-14', 1], ['2019-06-14', 1],
    ['2019-06-15', 2], ['2023-06-16', 2],
    ['2023-06-17', 3], ['2026-10-19', 3],
  ];
  for (const [fecha, esperado] of casos) t.is(periodOf(fecha), esperado, fecha);
});

test('el selector, la leyenda y los gráficos salen de PERIODS.length, sin [0, 1] fijos', (t) => {
  t.notRegex(TEMPLATE, /\[0, 1\]/);
  t.notRegex(TEMPLATE, /byP\[1\]/);
  t.regex(TEMPLATE, /const emptyP = \(\) => PERIODS\.map\(/);
  t.regex(TEMPLATE, /PERIODS\.map\(\(p, i\) => \[i, p\.label\]\)/);
});

test('los tres primeros mandatos comparten el azul y el actual conserva el naranja', (t) => {
  // tema claro, oscuro automático y oscuro forzado
  const temas = [...TEMPLATE.matchAll(/--p0:(#\w+);--p1:(#\w+);--p2:(#\w+);--p3:(#\w+);/g)];
  t.is(temas.length, 3);
  const pares = temas.map((m) => m.slice(1));
  t.deepEqual(pares[0], ['#1565c0', '#1565c0', '#1565c0', '#dd8500']);
  t.deepEqual(pares[1], ['#5aa9f5', '#5aa9f5', '#5aa9f5', '#ffb02e']);
  t.deepEqual(pares[2], pares[1]);
});

test('fuera de la pestaña oculta no se nombran partidos', (t) => {
  const oculta = TEMPLATE.match(/<!-- =+ SENTIR ARANDA VS[\s\S]*?(?=<!-- =+ )/)[0];
  const visible = TEMPLATE.replace(oculta, '');
  t.regex(oculta, /Partido Popular/);
  // el script sí contiene el cálculo de la pestaña oculta: se comprueba solo el HTML
  const html = visible.slice(0, visible.indexOf('<script'));
  t.notRegex(html, /Partido Popular|Sentir Aranda|\bPP\b/);
});

test('la etiqueta NextGenerationEU es azul, con la bandera de la UE incrustada (no emoji) y el texto', (t) => {
  t.regex(TEMPLATE, /const ngTag = \(\) => `<span class="tag ng"><img src="\$\{NG_FLAG\}" alt=""[^>]*>NextGenerationEU<\/span>`/);
  t.regex(TEMPLATE, /\.tag\.out-none,\.tag\.st-PUB,\.tag\.ng\{background:var\(--o-info-bg\)/);
  t.false(TEMPLATE.includes('<span class="tag">NextGenerationEU</span>'));
  t.false(TEMPLATE.includes('plain(r.nextgenProgram'));
  const html = renderPage(TEMPLATE, { generated: 'x', records: [] }, '', assetUris());
  t.regex(html, /const NG_FLAG = "data:image\/svg\+xml;base64,/);
});

test('"Buscar y filtrar" carga colapsado: botón con aria-expanded="false", aria-controls y chevron', (t) => {
  t.regex(TEMPLATE, /<button type="button" id="filters-toggle" class="ftoggle" aria-expanded="false" aria-controls="filters-body"><svg class="chev"[^>]*aria-hidden="true"[\s\S]*?<span>Buscar y filtrar<\/span>/);
  t.regex(TEMPLATE, /<div id="filters-body" hidden>/);
  t.regex(TEMPLATE, /\.ftoggle\[aria-expanded="true"\] \.chev\{transform:rotate\(90deg\)\}/);
  t.regex(TEMPLATE, /prefers-reduced-motion:reduce\)\{\.ftoggle \.chev\{transition:none\}/);
  // los filtros activos se indican en el botón y las pestañas informativas siguen ocultando todo el panel
  t.true(TEMPLATE.includes('id="filters-count"'));
  t.true(TEMPLATE.includes('$("filters").hidden = state.tab === "sentiraranda"'));
});
