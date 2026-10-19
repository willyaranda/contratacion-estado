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
  t.regex(TEMPLATE, /const kindTag = \(k\) => `<span class="tag kind-\$\{safeCls\(k\)\}">/);
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
  t.regex(TEMPLATE, /const outTag = \(o, text\) => `<span class="tag out-\$\{safeCls\(o\) \|\| "none"\}">/);
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

test('los valores que van en nombres de clase pasan por safeCls (el estado viene del feed externo)', (t) => {
  t.regex(TEMPLATE, /const safeCls = \(v\) => String\(v \?\? ""\)\.replace\(\/\[\^a-zA-Z0-9-\]\/g, ""\)/);
  t.regex(TEMPLATE, /class="tag st-\$\{safeCls\(s\)\}"/);
  t.regex(TEMPLATE, /class="tag kind-\$\{safeCls\(k\)\}"/);
  t.regex(TEMPLATE, /class="tag out-\$\{safeCls\(o\) \|\| "none"\}"/);
  // la función filtra de verdad
  const safeCls = new Function(`${TEMPLATE.match(/const safeCls = [^\n]+/)[0]}; return safeCls;`)();
  t.is(safeCls('PUB'), 'PUB');
  t.is(safeCls('x" onmouseover="alert(1)'), 'xonmouseoveralert1');
  t.is(safeCls(null), '');
});

test('Resumen: resultado y tramo de importe en una fila al 50 %, mayor importe a todo el ancho', (t) => {
  const resumen = TEMPLATE.match(/<div data-tab="resumen">([\s\S]*?)<!-- =+ EVOLUCI/)[1];
  const pair = resumen.match(/<section class="grid-pair" id="resumen-outcome-range">([\s\S]*?)<\/section>/)[1];
  t.true(pair.includes('Por resultado del procedimiento'));
  t.true(pair.includes('Por tramo de importe adjudicado'));
  t.false(pair.includes('Contratos de mayor importe'));
  // mayor importe: panel propio, fuera de las rejillas, después de la fila
  t.regex(resumen, /<section class="panel" id="resumen-top">\s*<h2>Contratos de mayor importe<\/h2>\s*<div id="c-top"><\/div>/);
  t.true(resumen.indexOf('id="resumen-top"') > resumen.indexOf('id="resumen-outcome-range"'));
  const grid2 = resumen.match(/<section class="grid2">([\s\S]*?)<\/section>/)[1];
  t.false(grid2.includes('Contratos de mayor importe'));
  t.false(grid2.includes('Por resultado del procedimiento'));
  // CSS: dos columnas iguales y una sola en móvil
  t.regex(TEMPLATE, /\.grid-pair\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  t.regex(TEMPLATE, /@media \(max-width:700px\)\{\.grid-pair\{grid-template-columns:minmax\(0,1fr\)\}\}/);
});

test('NextGenerationEU: el listado de contratos precede al bloque "Qué son estos fondos"', (t) => {
  const ng = TEMPLATE.match(/<div data-tab="nextgen" hidden>([\s\S]*?)<!-- =+ ADJUDICATARIOS/)[1];
  const lista = ng.indexOf('id="t-ng"');
  const que = ng.indexOf('<h2>Qué son estos fondos</h2>');
  t.true(lista > 0);
  t.true(que > lista);
  // KPIs y gráficos siguen arriba
  t.true(ng.indexOf('id="ng-kpis"') < lista);
  t.true(ng.indexOf('id="ng-prog"') < lista);
  // el bloque de texto conserva su contenido
  t.true(ng.includes('class="ngtext"') && ng.includes('Cómo se han detectado'));
});

// La franja de mesas vive en la plantilla (entre marcadores): se evalúa tal cual, con datos de prueba
const NOW_MESAS = Date.parse('2026-10-19T08:00:00Z');
const MESA = {
  uid: '10-2-sobre-a@contratacion-estado', type: 'Oferta económica', title: 'Limpieza <b>"viaria"</b> & más', public: false,
  summary: 'PRIV · Oferta económica: Limpieza <b>"viaria"</b> & más', description: 'Limpieza\nExpediente: X/1\nhttps://example.org/f?a=1&b=2',
  location: 'Salón de Plenos · PZ MAYOR, 1', link: 'https://example.org/f?a=1&b=2', start: Date.parse('2026-10-21T09:30:00Z'), end: Date.parse('2026-10-21T10:00:00Z'),
  ics: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
};
const mesasApi = (mesas) => {
  const code = TEMPLATE.match(/\/\/ <mesas>\n([\s\S]*?)\/\/ <\/mesas>/)[1];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const doc = { addEventListener() {}, querySelectorAll: () => [] };
  return new Function('DATA', 'esc', 'document', `${code}; return { renderMesas, mesaGoogleUrl, mesaOutlookUrl, mesaWhen };`)({ mesas }, esc, doc);
};
const fakeBox = () => ({ innerHTML: '', getAttribute: () => 'h-mesas' });

test('renderMesas se usa en Resumen (antes de #filters) y en Licitaciones abiertas (entre kpis4 y la tabla)', (t) => {
  t.regex(TEMPLATE, /<section class="panel mesas" id="mesas-resumen" data-tab="resumen"[^>]*><\/section>\s*<section class="panel" id="filters"/);
  t.regex(TEMPLATE, /<section class="kpis" id="kpis4"><\/section>\s*<section class="panel mesas" id="mesas-abiertas"[^>]*><\/section>\s*<section class="panel"[^>]*>[\s\S]*?t-open/);
  t.regex(TEMPLATE, /function renderResumen\(\) \{\n {2}renderMesas\(\$\("mesas-resumen"\)\);/);
  t.regex(TEMPLATE, /renderMesas\(\$\("mesas-abiertas"\)\);/);
  t.is((TEMPLATE.match(/function renderMesas/g) ?? []).length, 1);
});

test('renderMesas: solo mesas futuras, con las cuatro opciones de calendario y todo escapado', (t) => {
  const past = { ...MESA, uid: 'p@x', start: NOW_MESAS - 1000, title: 'PASADA' };
  const box = fakeBox();
  mesasApi([past, MESA]).renderMesas(box, NOW_MESAS);
  const html = box.innerHTML;
  t.notRegex(html, /PASADA/);
  t.regex(html, /Próximas mesas de contratación/);
  t.regex(html, /Oferta económica/);
  t.regex(html, /no público/);
  t.regex(html, /en 2 días/);
  t.regex(html, /11:30/); // hora de Madrid (CEST)
  // sin HTML sin escapar del título
  t.notRegex(html, /<b>/);
  t.regex(html, /Limpieza &lt;b&gt;&quot;viaria&quot;&lt;\/b&gt; &amp; más/);
  t.regex(html, /href="https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
  t.regex(html, /href="https:\/\/outlook\.office\.com\/calendar\/0\/deeplink\/compose\?path=%2Fcalendar%2Faction%2Fcompose&amp;rru=addevent/);
  t.is((html.match(/data:text\/calendar/g) ?? []).length, 2); // Apple e ICS
  t.regex(html, /download="mesa-10-2-sobre-a\.ics"/);
  t.regex(html, />📅 ICS</);
  t.regex(html, /Apple Calendar/);
  t.is((html.match(/target="_blank" rel="noopener noreferrer"/g) ?? []).length, 3); // ficha, Google y Outlook
  t.regex(html, /aria-label="Añadir al calendario: /);
});

test('renderMesas: sin mesas futuras, una línea discreta; con más de cuatro, "Ver todas"', (t) => {
  const none = fakeBox();
  mesasApi([{ ...MESA, start: NOW_MESAS - 1 }]).renderMesas(none, NOW_MESAS);
  t.regex(none.innerHTML, /No hay mesas de contratación pendientes/);
  t.notRegex(none.innerHTML, /mesacal/);
  const many = fakeBox();
  mesasApi(Array.from({ length: 6 }, (_, i) => ({ ...MESA, uid: `m${i}@x`, start: MESA.start + i }))).renderMesas(many, NOW_MESAS);
  t.regex(many.innerHTML, /Ver todas \(6\)/);
  t.is((many.innerHTML.match(/<li>/g) ?? []).length, 6);
});

test('enlaces de Google y Outlook: fecha UTC y título codificados', (t) => {
  const { mesaGoogleUrl, mesaOutlookUrl, mesaWhen } = mesasApi([]);
  const g = mesaGoogleUrl(MESA);
  t.true(g.includes('&dates=20261021T093000Z/20261021T100000Z'));
  t.true(g.includes(`&text=${encodeURIComponent(MESA.summary)}`));
  t.true(g.includes(`&location=${encodeURIComponent(MESA.location)}`));
  t.notRegex(g, /[<>" ]/);
  const o = mesaOutlookUrl(MESA);
  t.true(o.includes('&startdt=2026-10-21T09%3A30%3A00Z&enddt=2026-10-21T10%3A00%3A00Z'));
  t.true(o.includes(`&subject=${encodeURIComponent(MESA.summary)}`));
  t.true(o.includes(`&body=${encodeURIComponent(MESA.description)}`));
  t.deepEqual([mesaWhen(MESA.start, NOW_MESAS).label, mesaWhen(MESA.start, NOW_MESAS).rel], ['mié 21/10 · 11:30', 'en 2 días']);
  t.is(mesaWhen(NOW_MESAS + 3600e3, NOW_MESAS).rel, 'hoy');
  t.is(mesaWhen(NOW_MESAS + 86400e3, NOW_MESAS).rel, 'mañana');
});

test('las etiquetas de mandato usan el azul (11-15, 15-19, 19-23) y el naranja (23-27) de los gráficos', (t) => {
  for (const v of ['--m-blue-bg', '--m-blue-bd', '--m-orange-bg', '--m-orange-bd']) t.is(TEMPLATE.match(new RegExp(`${v}:#`, 'g')).length, 3, v);
  const bd = [...TEMPLATE.matchAll(/--m-blue-bd:(#\w+);--m-orange-bg:#\w+;--m-orange-bd:(#\w+);/g)].map((m) => m.slice(1));
  t.deepEqual(bd, [['#1565c0', '#dd8500'], ['#5aa9f5', '#ffb02e'], ['#5aa9f5', '#ffb02e']]); // = --p0 / --p3 de cada tema
  t.regex(TEMPLATE, /\.tag\.per-p0,\.tag\.per-p1,\.tag\.per-p2\{background:var\(--m-blue-bg\);border:1px solid var\(--m-blue-bd\);color:var\(--ink\)\}/);
  t.regex(TEMPLATE, /\.tag\.per-p3\{background:var\(--m-orange-bg\);border:1px solid var\(--m-orange-bd\);color:var\(--ink\)\}/);
  t.regex(TEMPLATE, /const periodTag = \(p\) => `<span class="tag per-p\$\{safeCls\(p\)\}"><i class="p\$\{safeCls\(p\)\}"/);
  t.regex(TEMPLATE, /label:"Corporación"[^\n]*html: \(r\) => periodTag\(r\.period\)/);
  t.regex(TEMPLATE, /const badges = \[[^\n]*periodTag\(r\.period\)/);
  t.regex(TEMPLATE, /Sacado por: \$\{periodTag\(r\.period\)\}/);
  t.false(TEMPLATE.includes('plain(PERIODS[r.period].label)'));
});

test('build.js escribe el calendario completo y los cuatro temáticos', (t) => {
  const out = tmpDir();
  const r = buildInto(out);
  t.is(r.status, 0, r.stderr);
  const names = {
    'aperturas.ics': 'Contratación Ayuntamiento Aranda de Duero',
    'mesas.ics': 'Contratación Aranda de Duero · Mesas de contratación',
    'plazos.ics': 'Contratación Aranda de Duero · Plazos de licitaciones',
    'adjudicaciones.ics': 'Contratación Aranda de Duero · Adjudicaciones',
    'vencimientos.ics': 'Contratación Aranda de Duero · Vencimientos de contratos',
  };
  for (const [file, name] of Object.entries(names)) {
    t.true(existsSync(join(out, file)), file);
    const ics = readFileSync(join(out, file), 'utf8');
    t.true(ics.startsWith('BEGIN:VCALENDAR\r\n'), file);
    t.true(ics.includes(`X-WR-CALNAME:${name}`), file);
  }
});
