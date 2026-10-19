// Construye la página de transparencia: lee dump/ y genera data.json, details.json, index.html (autocontenido),
// artifact.html y los calendarios .ics.
//   node transparencia/build.js [--dump <carpeta>] [--out <carpeta>]
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { CALENDARS, buildIcs, upcomingMesas } from '../lib/ics.js';
import { buildRecords } from './extract.js';

const MESAS_MARGIN_MS = 7 * 24 * 3600 * 1000;

const HERE = dirname(fileURLToPath(import.meta.url));

const FONT_FACES = [
  ['outfit-latin-ext.woff2', 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF'],
  ['outfit-latin.woff2', 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'],
];

// Fuente Outfit incrustada (autoalojada): la página no hace ninguna petición externa.
export const fontCss = (fontsDir = join(HERE, 'fonts')) => FONT_FACES.map(([file, range]) => {
  const base64 = readFileSync(join(fontsDir, file)).toString('base64');
  return `@font-face{font-family:"Outfit";font-style:normal;font-weight:400 700;font-display:swap;src:url(data:font/woff2;base64,${base64}) format("woff2");unicode-range:${range}}`;
}).join('\n');

// Logotipos de la pestaña NextGenerationEU: marcador de la plantilla -> fichero de transparencia/assets/
const ASSETS = {
  __LOGO_EU__: ['bandera-ue.svg', 'image/svg+xml'],
  __LOGO_NGEU__: ['financiado-ue-nextgenerationeu.webp', 'image/webp'],
  __LOGO_PRTR__: ['prtr.svg', 'image/svg+xml'],
};

// Imágenes incrustadas como data: URI (la página no carga nada externo).
export const assetUris = (assetsDir = join(HERE, 'assets')) => Object.fromEntries(Object.entries(ASSETS).map(
  ([marker, [file, mime]]) => [marker, `data:${mime};base64,${readFileSync(join(assetsDir, file)).toString('base64')}`],
));

// Plantilla + datos + fuente + imágenes -> HTML autocontenido.
export const renderPage = (template, data, fonts, assets = {}, details = {}) => {
  // "<" escapado para que los datos no puedan cerrar el <script> por accidente
  const escape = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
  let html = template.replace('/*FONTFACE*/', () => fonts)
    .replace('/*DATA*/', () => escape(data))
    // fichas de contrato: la página las lee solo al abrir una
    .replace('/*DETAILS*/', () => escape(details));
  for (const [marker, uri] of Object.entries(assets)) html = html.replaceAll(marker, () => uri);
  return html;
};

// Versión para publicar como artefacto: el visor añade su propio doctype/html/head/body,
// así que solo van title + style + contenido.
export const toArtifact = (html) => {
  const title = html.match(/<title>[\s\S]*?<\/title>/)[0];
  const style = html.match(/<style>[\s\S]*?<\/style>/)[0];
  const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
  return `${title}\n${style}\n${body}\n`;
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : fallback;
};

const main = () => {
  const dumpDir = arg('dump', join(HERE, '..', 'dump'));
  const outDir = arg('out', HERE);
  const { files, generated, records, details } = buildRecords(dumpDir);
  // Aperturas de ofertas (las escribe index.js en dump/aperturas.json)
  let aperturas = {};
  try {
    aperturas = JSON.parse(readFileSync(join(dumpDir, 'aperturas.json'), 'utf8'));
  } catch { /* sin aperturas todavía */ }
  // Mesas de contratación para la franja de la página: desde 7 días antes de la fecha de los datos (determinista con el
  // mismo input); el navegador filtra las que siguen siendo futuras comparando con su reloj.
  const mesas = upcomingMesas(aperturas, Date.parse(generated) - MESAS_MARGIN_MS);
  const data = { generated, records, mesas };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'data.json'), JSON.stringify(data));
  writeFileSync(join(outDir, 'details.json'), JSON.stringify(details));
  const html = renderPage(readFileSync(join(HERE, 'template.html'), 'utf8'), data, fontCss(), assetUris(), details);
  writeFileSync(join(outDir, 'index.html'), html);
  writeFileSync(join(outDir, 'artifact.html'), toArtifact(html));

  // Calendarios: el completo (aperturas.ics) y los temáticos (mesas, plazos, adjudicaciones, vencimientos)
  const now = Date.now();
  for (const { file, ...calendar } of CALENDARS) {
    writeFileSync(join(outDir, file), buildIcs(aperturas, { now, tenders: records, ...calendar }));
  }

  console.log({
    files, contracts: records.length, withWinner: records.filter((r) => r.winners.length).length, generated,
  });
  console.log(`data.json, details.json, index.html, artifact.html y ${CALENDARS.map((c) => c.file).join(', ')} escritos en ${outDir}`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
