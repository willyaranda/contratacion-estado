import test from 'ava';
import { readFileSync } from 'fs';
import { join } from 'path';

import { analyticsScript } from '../lib/analytics.js';
import { renderDatosPage } from '../lib/datos.js';
import { assetUris, fontCss, renderPage } from '../transparencia/build.js';
import {
  AYTO_URL, CONSENT_KEY, DENIED_TTL_DAYS, GA_ID, PRIVACY_URL,
} from '../transparencia/site.js';
import { ROOT } from './helpers.js';

const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');
const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-10-19T12:00:00Z');
const GTM = 'googletagmanager.com';

const main = renderPage(read('transparencia', 'template.html'), { generated: '2026-10-19T10:00:00Z', records: [], mesas: [] }, fontCss(), assetUris(), {});
const datos = renderDatosPage(read('transparencia', 'datos.html'), {
  sizes: {}, generated: '2026-10-19T10:00:00Z', coverage: '2018-01-01/2026-10-01', nContratos: 1, nAdjudicatarios: 1, fonts: fontCss(), assets: assetUris(),
});

// Evalúa el script real con un window/document/navegador falsos.
const run = ({
  store = {}, dnt, noStorage = false, cookie = '',
} = {}) => {
  const el = (name) => ({
    name, hidden: true, focused: false, handlers: {},
    addEventListener(ev, fn) { this.handlers[ev] = fn; },
    focus() { this.focused = true; },
    click() { this.handlers.click(); },
  });
  const accept = el('accept');
  const reject = el('reject');
  const banner = { ...el('banner'), querySelector: (sel) => (sel.includes('accept') ? accept : reject) };
  const prefs = el('prefs');
  const appended = [];
  const document = {
    cookie,
    head: { appendChild: (s) => appended.push(s) },
    createElement: () => ({}),
    querySelector: (sel) => (sel === '[data-analytics-consent]' ? banner : null),
    querySelectorAll: () => [prefs],
  };
  const localStorage = noStorage ? {
    getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); }, removeItem() { throw new Error('bloqueado'); },
  } : {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  const window = { localStorage, navigator: { doNotTrack: dnt }, location: { hostname: 'x.github.io' } };
  new Function('window', 'document', analyticsScript())(window, document);
  return {
    window, document, appended, store, banner, accept, reject, prefs,
  };
};

test('consentState: tabla de casos', (t) => {
  const { consentState } = run().window.contratacionAnalytics;
  const j = (v, t0) => JSON.stringify({ v, t: t0 });
  const cases = [
    [null, ''],
    ['', ''],
    [j('granted', NOW - 400 * DAY), 'granted'],
    [j('granted', NOW), 'granted'],
    [j('denied', NOW - 1000), 'denied'],
    [j('denied', NOW - 4 * DAY + 1), 'denied'],
    [j('denied', NOW - 4 * DAY), ''],
    [j('denied', NOW - 5 * DAY), ''],
    ['{roto', ''],
    ['granted', ''],
    ['denied', ''],
    ['null', ''],
    ['3', ''],
    [JSON.stringify({ v: 'granted' }), ''],
    [JSON.stringify({ v: 'granted', t: 'ayer' }), ''],
    [j('denied', NOW + 1000), ''],
    [j('granted', NOW + 1000), ''],
    [j('quizá', NOW), ''],
  ];
  for (const [raw, expected] of cases) t.is(consentState(raw, NOW), expected, String(raw));
  t.is(DENIED_TTL_DAYS, 4);
});

test('sin decisión: aviso visible, nada de Google; «Aceptar» guarda granted y carga GA', (t) => {
  const r = run();
  t.false(r.banner.hidden);
  t.is(r.appended.length, 0);
  r.accept.click();
  t.true(r.banner.hidden);
  t.deepEqual(JSON.parse(r.store[CONSENT_KEY]).v, 'granted');
  t.is(r.appended.length, 1);
  t.is(r.appended[0].src, `https://${'www.' + GTM}/gtag/js?id=${GA_ID}`);
  t.is(r.window[`ga-disable-${GA_ID}`], false);
});

test('«Rechazar» guarda denied con fecha, oculta el aviso y no carga nada', (t) => {
  const r = run();
  r.reject.click();
  const saved = JSON.parse(r.store[CONSENT_KEY]);
  t.is(saved.v, 'denied');
  t.true(Math.abs(saved.t - Date.now()) < 5000);
  t.true(r.banner.hidden);
  t.is(r.appended.length, 0);
});

test('denied vigente (3 días): sin aviso; caducado (5 días): vuelve a preguntar', (t) => {
  const store = (v, ago) => ({ [CONSENT_KEY]: JSON.stringify({ v, t: Date.now() - ago * DAY }) });
  const fresh = run({ store: store('denied', 3) });
  t.true(fresh.banner.hidden);
  t.is(fresh.appended.length, 0);
  t.false(run({ store: store('denied', 5) }).banner.hidden);
});

test('granted antiguo (30 días): sin aviso y GA se carga', (t) => {
  const r = run({ store: { [CONSENT_KEY]: JSON.stringify({ v: 'granted', t: Date.now() - 30 * DAY }) } });
  t.true(r.banner.hidden);
  t.is(r.appended.length, 1);
});

test('Do Not Track: ni aviso ni GA ni enlace de preferencias, aunque haya granted', (t) => {
  const r = run({ dnt: '1', store: { [CONSENT_KEY]: JSON.stringify({ v: 'granted', t: Date.now() }) } });
  t.true(r.banner.hidden);
  t.is(r.appended.length, 0);
  t.true(r.prefs.hidden);
});

test('sin localStorage: aviso visible, GA solo tras «Aceptar» y sin excepciones', (t) => {
  const r = run({ noStorage: true });
  t.false(r.banner.hidden);
  t.is(r.appended.length, 0);
  r.accept.click();
  t.is(r.appended.length, 1);
});

test('«Preferencias de analítica»: borra la decisión, desactiva GA y vuelve a preguntar', (t) => {
  const r = run({ store: { [CONSENT_KEY]: JSON.stringify({ v: 'granted', t: Date.now() }) }, cookie: '_ga=1; _ga_ABC=2; otra=3' });
  t.true(r.banner.hidden);
  r.prefs.click();
  t.false(CONSENT_KEY in r.store);
  t.is(r.window[`ga-disable-${GA_ID}`], true);
  t.false(r.banner.hidden);
  t.true(r.banner.querySelector('accept').focused);
  r.reject.click();
  t.is(r.window[`ga-disable-${GA_ID}`], true);
});

test('el ID, la clave y la política salen de site.js', (t) => {
  t.is(GA_ID, 'G-BXMC22W46S');
  t.is(CONSENT_KEY, 'contratacionAranda:analytics-consent');
  t.is(PRIVACY_URL, `${AYTO_URL}/politica-privacidad/`);
  t.is(PRIVACY_URL, 'https://www.arandadeduero.es/politica-privacidad/');
  for (const [name, html] of [['principal', main], ['datos', datos]]) {
    t.true(html.includes(`const GA_ID = '${GA_ID}'`), name);
    t.true(html.includes(`const CONSENT_KEY = '${CONSENT_KEY}'`), name);
    t.regex(html, /Number\('345600000'\)/, name);
    t.notRegex(html, /__GA_ID__|__CONSENT_KEY__|__DENIED_TTL_MS__|__PRIVACY_URL__|__DENY_DAYS__|__ANALYTICS_SCRIPT__|ANALYTICS_CSS|<!--ANALYTICS-->/, name);
  }
  for (const file of ['template.html', 'datos.html', 'analytics.js', 'analytics.html']) {
    t.false(read('transparencia', file).includes(GA_ID), `${file} no repite el ID`);
  }
});

test('el host de Google solo aparece dentro de loadGa, en ambas páginas', (t) => {
  for (const [name, html] of [['principal', main], ['datos', datos]]) {
    t.is(html.split(GTM).length - 1, 1, name);
    const fn = html.match(/const loadGa = \(\) => \{[\s\S]*?\n {2}\};/)[0];
    t.is(fn.split(GTM).length - 1, 1, name);
    t.notRegex(html, /google-analytics\.com|doubleclick|googleapis|gstatic|preconnect|dns-prefetch|prefetch/, name);
    t.notRegex(html, /<script[^>]+src=/, name);
    const head = html.slice(0, html.indexOf('</head>')).replace(/<style>[\s\S]*<\/style>/, '');
    t.false(head.includes('google'), name);
  }
});

test('el aviso: región accesible, dos botones iguales «Aceptar»/«Rechazar», política exacta y marcadores en ambas páginas', (t) => {
  for (const [name, html] of [['principal', main], ['datos', datos]]) {
    t.regex(html, /<div class="analytics-consent" data-analytics-consent role="region" aria-label="[^"]+" hidden>/, name);
    t.regex(html, /<button type="button" class="analytics-btn" data-analytics-accept>Aceptar<\/button>\s*<button type="button" class="analytics-btn" data-analytics-reject>Rechazar<\/button>/, name);
    t.true(html.includes(`<a href="${PRIVACY_URL}" rel="noopener">Más información en la política de privacidad</a>`), name);
    t.true(html.includes(`<a href="${PRIVACY_URL}" rel="noopener">Política de privacidad</a>`), name);
    t.regex(html, /<button type="button" class="linklike" data-analytics-prefs>Preferencias de analítica<\/button>/, name);
    t.regex(html, /se volverá a preguntar pasados 4 días/, name);
    t.regex(html, /\.analytics-btn\{[^}]*background:var\(--accent\)/, name);
    t.notRegex(html, /\.analytics-(accept|reject)\b/, name);
    t.true(html.includes('<style>'), name);
  }
});
