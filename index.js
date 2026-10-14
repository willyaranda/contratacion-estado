import { SESClient } from '@aws-sdk/client-ses';
import { XMLParser } from 'fast-xml-parser';
import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { isFromAyuntamiento } from './lib/ayuntamiento.js';
import { readAperturas, syncAperturas, writeAperturas } from './lib/aperturas.js';
import { previousVersion } from './lib/changes.js';
import { crawl, newestTimestamp } from './lib/crawler.js';
import { fetchText } from './lib/http.js';
import { loadMailConfig, sendDigest } from './lib/notify.js';

const DUMP_DIR = join(dirname(fileURLToPath(import.meta.url)), 'dump');

const FEEDS = [
  { sfx: 'licitaciones', url: 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom' },
  { sfx: 'menores', url: 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_1143/contratosMenoresPerfilesContratantes.atom' },
  // { sfx: 'agregacion', url: 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_1044/PlataformasAgregadasSinMenores.atom' },
];

const parser = new XMLParser({ ignoreAttributes: false });

// Margen sobre el punto de control: los anuncios pueden llegar al feed con retraso
const SAFETY_MARGIN_MS = 24 * 3600 * 1000;
// Punto de control: hasta qué fecha del feed se llegó en la última ejecución completa. Se guarda en dump/ para que
// el commit nocturno lo conserve. Así cada noche solo se recorre lo publicado desde entonces, haya o no novedades
// del Ayuntamiento (el feed es de toda España y sin esto habría que recorrerlo hasta el último contrato conocido).
const STATE_FILE = join(DUMP_DIR, '.state.json');
const readState = async () => {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
};

try {
  // La configuración del aviso por email se valida antes de descargar nada: si es incorrecta, el job falla.
  // (Ver lib/notify.js para las variables de entorno. Nunca se imprimen credenciales ni destinatarios.)
  const mail = loadMailConfig(process.env);

  const created = [];
  const state = await readState();
  const nextState = { ...state };
  // Los feeds son independientes: se descargan a la vez (cada petición tarda minutos con el servidor lento).
  await Promise.all(FEEDS.map(async ({ sfx, url }) => {
    // Solo se guardan los anuncios cuyo contratante es el Ayuntamiento de Aranda de Duero
    // (Alcaldía, Junta de Gobierno o Pleno): el mismo criterio que usa transparencia/extract.js.
    // sin punto de control (primera vez), se usa la versión más reciente guardada
    const since = state[sfx] ?? await newestTimestamp(join(DUMP_DIR, sfx));
    const stats = await crawl({
      url,
      sfx,
      dumpDir: DUMP_DIR,
      stopBefore: since === null ? null : since - SAFETY_MARGIN_MS,
      fetchText: (u) => fetchText(u, { log: console.log }),
      parseXml: (xml) => parser.parse(xml),
      isWanted: isFromAyuntamiento,
      onNew: async (entry) => { created.push({ entry, sfx }); },
      log: console.log,
    });
    if (stats.newestSeen !== null) nextState[sfx] = Math.max(stats.newestSeen, state[sfx] ?? 0);
  }));
  // solo si todos los feeds se recorrieron sin error
  await writeFile(STATE_FILE, `${JSON.stringify(nextState, null, 2)}\n`);
  console.log(`Finished. New files written: ${created.length}`);

  // Aperturas de ofertas de las licitaciones en curso (ficha web). Es secundario: si la web falla, no se pierde el
  // aviso de anuncios nuevos; las fichas pendientes se reintentan en la siguiente ejecución.
  const aperturas = await readAperturas(DUMP_DIR);
  let openingChanges = new Map();
  try {
    const sync = await syncAperturas({
      dumpDir: DUMP_DIR,
      store: aperturas,
      fetchText: (u) => fetchText(u, { log: console.log }),
      onUpdate: () => writeAperturas(DUMP_DIR, aperturas),
      log: console.log,
    });
    openingChanges = sync.changes;
    await writeAperturas(DUMP_DIR, aperturas);
    console.log(`Aperturas: ${sync.checked} licitación(es) consultada(s).`);
  } catch (error) {
    console.error('No se pudieron actualizar las aperturas:', error.message);
  }

  if (mail.enabled && created.length > 0) {
    // Las credenciales las lee el SDK directamente de AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
    const client = new SESClient({ region: mail.region });
    // Versión anterior de cada anuncio (ya con todo descargado), para indicar qué ha cambiado
    const previous = new Map();
    for (const { entry, sfx } of created) previous.set(entry, await previousVersion(DUMP_DIR, sfx, entry));
    const sent = await sendDigest({
      config: mail, entries: created.map((c) => c.entry), client, previousOf: (e) => previous.get(e),
      openingsOf: (e) => {
        const id = `${e.id}`.split('/').pop();
        return aperturas[id] ? { events: aperturas[id].events, previous: openingChanges.get(id)?.previous ?? null } : null;
      },
    });
    console.log(`Aviso por email enviado: ${sent} mensaje(s) a ${mail.recipients.length} destinatario(s) en CCO.`);
  } else if (mail.enabled) {
    console.log('Sin anuncios nuevos: no se envía aviso.');
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
