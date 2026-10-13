import { constants } from 'fs';
import {
  access, mkdir, readdir, writeFile,
} from 'fs/promises';
import { dirname, join } from 'path';

import { asArray, entryFileName } from './ayuntamiento.js';

const exists = async (file) => {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

// Marca de tiempo (ms) de la versión más reciente guardada en una carpeta, o null si está vacía o no existe.
// Sale del nombre `<id>-<ts>.json`.
export const newestTimestamp = async (dir) => {
  try {
    const stamps = (await readdir(dir)).map((f) => /^\d+-(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number);
    return stamps.length ? Math.max(...stamps) : null;
  } catch {
    return null;
  }
};

// Recorre un feed Atom desde la página más reciente hacia atrás (enlaces `rel="next"`) y guarda en
// `<dumpDir>/<sfx>/` los anuncios que cumplan `isWanted` y no existan ya. Se detiene al encontrar `maxSeen`
// ficheros ya descargados: a partir de ahí todo lo anterior ya está guardado.
// Devuelve `newestSeen`: la fecha (ms) del anuncio más reciente del feed, sea del organismo que sea. Sirve de punto
// de control para la siguiente ejecución.
// `stopBefore` (ms) acota además el recorrido: el feed va de más reciente a más antiguo, así que cuando todos los
// anuncios de una página son anteriores a esa marca no hay nada nuevo que buscar (aunque el Ayuntamiento no haya
// publicado nada en esos días y no aparezca ningún fichero ya conocido).
//
//   fetchText(url) -> Promise<string>   descarga una página del feed
//   parseXml(xml)  -> objeto            devuelve { feed: { entry, link } }
//   onNew(entry)   -> Promise<void>     se invoca por cada fichero nuevo (p. ej. para avisar por email)
export const crawl = async ({
  url,
  sfx,
  dumpDir,
  fetchText,
  parseXml,
  isWanted,
  maxSeen = 1,
  stopBefore = null,
  onNew = async () => {},
  log = () => {},
}) => {
  const stats = {
    pages: 0, existing: 0, written: 0, newestSeen: null,
  };
  let next = url;

  while (next) {
    stats.pages += 1;
    log(`Descargando ${sfx} (página ${stats.pages}, ya existentes = ${stats.existing}): ${next}`);
    const { feed } = parseXml(await fetchText(next));

    const entries = asArray(feed?.entry);
    for (const entry of entries) {
      const seen = Date.parse(entry.updated);
      if (!Number.isNaN(seen) && (stats.newestSeen === null || seen > stats.newestSeen)) stats.newestSeen = seen;
      if (isWanted(entry)) {
        const file = join(dumpDir, sfx, entryFileName(entry));
        if (await exists(file)) {
          stats.existing += 1;
          log(`Ya existe ${file}`);
        } else {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, JSON.stringify(entry, null, 2));
          stats.written += 1;
          log(`Escrito ${file}`);
          await onNew(entry);
        }
      }
    }

    if (stats.existing >= maxSeen) {
      log(`Encontrados ${stats.existing} ficheros ya descargados para ${sfx}. Hecho.`);
      break;
    }

    if (stopBefore !== null && entries.length > 0 && entries.every((e) => Date.parse(e.updated) < stopBefore)) {
      log(`Toda la página es anterior a la última descarga de ${sfx}. Hecho.`);
      break;
    }

    next = asArray(feed?.link).find((link) => link['@_rel'] === 'next')?.['@_href'];
  }

  return stats;
};
