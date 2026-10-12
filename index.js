import { SESClient } from '@aws-sdk/client-ses';
import { XMLParser } from 'fast-xml-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { isFromAyuntamiento } from './lib/ayuntamiento.js';
import { crawl } from './lib/crawler.js';
import { fetchText } from './lib/http.js';
import { loadMailConfig, sendDigest } from './lib/notify.js';

const DUMP_DIR = join(dirname(fileURLToPath(import.meta.url)), 'dump');

const FEEDS = [
  { sfx: 'licitaciones', url: 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom' },
  { sfx: 'menores', url: 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_1143/contratosMenoresPerfilesContratantes.atom' },
  // { sfx: 'agregacion', url: 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_1044/PlataformasAgregadasSinMenores.atom' },
];

const parser = new XMLParser({ ignoreAttributes: false });

try {
  // La configuración del aviso por email se valida antes de descargar nada: si es incorrecta, el job falla.
  // (Ver lib/notify.js para las variables de entorno. Nunca se imprimen credenciales ni destinatarios.)
  const mail = loadMailConfig(process.env);

  const created = [];
  for (const { sfx, url } of FEEDS) {
    // Solo se guardan los anuncios cuyo contratante es el Ayuntamiento de Aranda de Duero
    // (Alcaldía, Junta de Gobierno o Pleno): el mismo criterio que usa transparencia/extract.js.
    await crawl({
      url,
      sfx,
      dumpDir: DUMP_DIR,
      fetchText: (u) => fetchText(u, { log: console.log }),
      parseXml: (xml) => parser.parse(xml),
      isWanted: isFromAyuntamiento,
      onNew: async (entry) => { created.push(entry); },
      log: console.log,
    });
  }
  console.log(`Finished. New files written: ${created.length}`);

  if (mail.enabled && created.length > 0) {
    // Las credenciales las lee el SDK directamente de AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
    const client = new SESClient({ region: mail.region });
    const sent = await sendDigest({ config: mail, entries: created, client });
    console.log(`Aviso por email enviado: ${sent} mensaje(s) a ${mail.recipients.length} destinatario(s) en CCO.`);
  } else if (mail.enabled) {
    console.log('Sin anuncios nuevos: no se envía aviso.');
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
