// El trabajo nocturno: descargar anuncios nuevos, consultar sus aperturas y avisar por email.
// index.js solo lo invoca; las dependencias externas (red, SES, entorno) se inyectan para poder probarlo sin red.
import { XMLParser } from 'fast-xml-parser';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

import { readAperturas, syncAperturas, writeAperturas } from './aperturas.js';
import { isFromAyuntamiento } from './ayuntamiento.js';
import { previousVersion } from './changes.js';
import { crawl, newestTimestamp } from './crawler.js';
import { fetchText as httpFetchText } from './http.js';
import { loadMailConfig, sendDigest } from './notify.js';

export const FEEDS = [
  { sfx: 'licitaciones', url: 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom' },
  { sfx: 'menores', url: 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_1143/contratosMenoresPerfilesContratantes.atom' },
  // { sfx: 'agregacion', url: 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_1044/PlataformasAgregadasSinMenores.atom' },
];

const parser = new XMLParser({ ignoreAttributes: false });

// Margen sobre el punto de control: los anuncios pueden llegar al feed con retraso
export const SAFETY_MARGIN_MS = 24 * 3600 * 1000;

// Punto de control: hasta qué fecha del feed se llegó en la última ejecución completa. Se guarda en dump/ para que
// el commit nocturno lo conserve. Así cada noche solo se recorre lo publicado desde entonces, haya o no novedades
// del Ayuntamiento (el feed es de toda España y sin esto habría que recorrerlo hasta el último contrato conocido).
const readState = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return {};
  }
};

// Devuelve { created, aperturasChecked, sent }.
export const runJob = async ({
  env = process.env,
  dumpDir,
  feeds = FEEDS,
  fetchText = (u) => httpFetchText(u, { log: console.log }),
  createClient,
  log = console.log,
  warn = console.error,
}) => {
  // La configuración del aviso por email se valida antes de descargar nada: si es incorrecta, el job falla.
  // (Ver lib/notify.js para las variables de entorno. Nunca se imprimen credenciales ni destinatarios.)
  const mail = loadMailConfig(env);

  const created = [];
  const stateFile = join(dumpDir, '.state.json');
  const state = await readState(stateFile);
  const nextState = { ...state };
  // Los feeds son independientes: se descargan a la vez (cada petición tarda minutos con el servidor lento).
  await Promise.all(feeds.map(async ({ sfx, url }) => {
    // Solo se guardan los anuncios cuyo contratante es el Ayuntamiento de Aranda de Duero
    // (Alcaldía, Junta de Gobierno o Pleno): el mismo criterio que usa transparencia/extract.js.
    // sin punto de control (primera vez), se usa la versión más reciente guardada
    const since = state[sfx] ?? await newestTimestamp(join(dumpDir, sfx));
    const stats = await crawl({
      url,
      sfx,
      dumpDir,
      stopBefore: since === null ? null : since - SAFETY_MARGIN_MS,
      fetchText,
      parseXml: (xml) => parser.parse(xml),
      isWanted: isFromAyuntamiento,
      onNew: async (entry) => { created.push({ entry, sfx }); },
      log,
    });
    if (stats.newestSeen !== null) nextState[sfx] = Math.max(stats.newestSeen, state[sfx] ?? 0);
  }));
  // solo si todos los feeds se recorrieron sin error
  await writeFile(stateFile, `${JSON.stringify(nextState, null, 2)}\n`);
  log(`Finished. New files written: ${created.length}`);

  // Aperturas de ofertas (ficha web). Es secundario: si la web falla, no se pierde el aviso de anuncios nuevos;
  // las fichas pendientes se reintentan en la siguiente ejecución.
  const aperturas = await readAperturas(dumpDir);
  let openingChanges = new Map();
  let aperturasChecked = 0;
  try {
    const sync = await syncAperturas({
      dumpDir,
      store: aperturas,
      fetchText,
      onUpdate: () => writeAperturas(dumpDir, aperturas),
      log,
    });
    openingChanges = sync.changes;
    aperturasChecked = sync.checked;
    await writeAperturas(dumpDir, aperturas);
    log(`Aperturas: ${sync.checked} licitación(es) consultada(s).`);
  } catch (error) {
    warn('No se pudieron actualizar las aperturas:', error.message);
  }

  let sent = 0;
  if (mail.enabled && created.length > 0) {
    // Las credenciales las lee el SDK directamente de AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
    const client = createClient(mail.region);
    // Versión anterior de cada anuncio (ya con todo descargado), para indicar qué ha cambiado
    const previous = new Map();
    for (const { entry, sfx } of created) previous.set(entry, await previousVersion(dumpDir, sfx, entry));
    sent = await sendDigest({
      config: mail,
      entries: created.map((c) => c.entry),
      client,
      previousOf: (e) => previous.get(e),
      openingsOf: (e) => {
        const id = `${e.id}`.split('/').pop();
        return aperturas[id] ? { events: aperturas[id].events, previous: openingChanges.get(id)?.previous ?? null } : null;
      },
    });
    log(`Aviso por email enviado: ${sent} mensaje(s) a ${mail.recipients.length} destinatario(s) en CCO.`);
  } else if (mail.enabled) {
    log('Sin anuncios nuevos: no se envía aviso.');
  }

  return { created: created.length, aperturasChecked, sent };
};
