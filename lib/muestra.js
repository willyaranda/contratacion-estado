// Entradas de muestra para el correo de avisos: los últimos anuncios reales de `dump/` (estados distintos si los hay),
// con las aperturas reales de `dump/aperturas.json`. Sirve para ver cómo queda el correo sin esperar a un aviso real:
// lo usan scripts/test-email.js (envío de la muestra) y los tests.
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import { isFromAyuntamiento } from './ayuntamiento.js';
import { previousVersion, statusOf } from './changes.js';

const FEEDS = ['licitaciones', 'menores'];

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// Último fichero de cada anuncio (por timestamp) de `<dumpDir>/<sfx>/`.
const latestEntries = (dumpDir, sfx) => {
  const dir = join(dumpDir, sfx);
  if (!existsSync(dir)) return [];
  const best = new Map();
  for (const file of readdirSync(dir)) {
    const m = /^(\d+)-(\d+)\.json$/.exec(file);
    if (m && (!best.has(m[1]) || Number(m[2]) > best.get(m[1]).ts)) best.set(m[1], { file, ts: Number(m[2]) });
  }
  return [...best.values()].sort((a, b) => b.ts - a.ts).slice(0, 200)
    .map(({ file }) => ({ sfx, entry: readJson(join(dir, file)) }))
    .filter(({ entry }) => isFromAyuntamiento(entry));
};

// Elige `count` anuncios recientes procurando estados distintos (primero uno de cada estado, luego los más recientes).
const pick = (candidates, count) => {
  const chosen = [];
  const seen = new Set();
  for (const c of candidates) {
    if (chosen.length < count && !seen.has(statusOf(c.entry))) {
      chosen.push(c);
      seen.add(statusOf(c.entry));
    }
  }
  for (const c of candidates) {
    if (chosen.length < count && !chosen.includes(c)) chosen.push(c);
  }
  return chosen;
};

// Devuelve { entries, previousOf, openingsOf } con la forma que espera sendDigest/buildDigest. El primer anuncio se
// presenta como «nueva publicación» y, si ningún otro tiene versión anterior real, el segundo simula un cambio de
// estado (para que la muestra enseñe la flecha); el resto usa su versión anterior real, si existe.
export const sampleDigestInputs = async (dumpDir, { count = 8 } = {}) => {
  const candidates = FEEDS.flatMap((sfx) => latestEntries(dumpDir, sfx))
    .sort((a, b) => Date.parse(b.entry.updated) - Date.parse(a.entry.updated));
  const chosen = pick(candidates, count);
  const entries = chosen.map((c) => c.entry);

  const previous = new Map();
  for (const { sfx, entry } of chosen) previous.set(entry, await previousVersion(dumpDir, sfx, entry));
  if (entries.length > 0) previous.set(entries[0], null);
  if (entries.length > 1 && !previous.get(entries[1])) {
    const simulated = structuredClone(entries[1]);
    const folder = simulated['cac-place-ext:ContractFolderStatus'];
    folder['cbc-place-ext:ContractFolderStatusCode'] = { '#text': statusOf(entries[1]) === 'EV' ? 'PUB' : 'EV' };
    previous.set(entries[1], simulated);
  }

  const aperturasFile = join(dumpDir, 'aperturas.json');
  const aperturas = existsSync(aperturasFile) ? readJson(aperturasFile) : {};
  return {
    entries,
    previousOf: (entry) => previous.get(entry) ?? null,
    openingsOf: (entry) => {
      const found = aperturas[`${entry.id}`.split('/').pop()];
      return found ? { events: found.events ?? [], previous: null } : null;
    },
  };
};
