import { constants } from 'fs';
import { access, mkdir, writeFile } from 'fs/promises';
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

// Recorre un feed Atom desde la página más reciente hacia atrás (enlaces `rel="next"`) y guarda en
// `<dumpDir>/<sfx>/` los anuncios que cumplan `isWanted` y no existan ya. Se detiene al encontrar `maxSeen`
// ficheros ya descargados: a partir de ahí todo lo anterior ya está guardado.
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
  onNew = async () => {},
  log = () => {},
}) => {
  const stats = { pages: 0, existing: 0, written: 0 };
  let next = url;

  while (next) {
    stats.pages += 1;
    log(`Descargando ${sfx} (página ${stats.pages}, ya existentes = ${stats.existing}): ${next}`);
    const { feed } = parseXml(await fetchText(next));

    for (const entry of asArray(feed?.entry)) {
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

    next = asArray(feed?.link).find((link) => link['@_rel'] === 'next')?.['@_href'];
  }

  return stats;
};
