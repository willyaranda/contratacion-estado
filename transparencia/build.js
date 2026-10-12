// Construye la página de transparencia: lee dump/, genera data.json, index.html (autocontenido) y artifact.html.
//   node transparencia/build.js [--dump <carpeta>] [--out <carpeta>]
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { buildRecords } from './extract.js';

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

// Plantilla + datos + fuente -> HTML autocontenido.
export const renderPage = (template, data, fonts) => {
  // "<" escapado para que los datos no puedan cerrar el <script> por accidente
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return template.replace('/*FONTFACE*/', () => fonts).replace('/*DATA*/', () => json);
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
  const { files, generated, records } = buildRecords(dumpDir);
  const data = { generated, records };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'data.json'), JSON.stringify(data));
  const html = renderPage(readFileSync(join(HERE, 'template.html'), 'utf8'), data, fontCss());
  writeFileSync(join(outDir, 'index.html'), html);
  writeFileSync(join(outDir, 'artifact.html'), toArtifact(html));

  console.log({
    files, contracts: records.length, withWinner: records.filter((r) => r.winners.length).length, generated,
  });
  console.log(`index.html y artifact.html escritos en ${outDir}`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
