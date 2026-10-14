// Qué ha cambiado un anuncio respecto a su versión anterior (la misma `<id>-<ts>.json` con el timestamp anterior más
// próximo): estado (p. ej. PUB -> EV) y documentos añadidos o retirados. Lo usa el aviso por email.
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';

import { asArray, text } from './ayuntamiento.js';

const FOLDER = 'cac-place-ext:ContractFolderStatus';

export const statusOf = (entry) => text(entry?.[FOLDER]?.['cbc-place-ext:ContractFolderStatusCode']) ?? null;

// Todos los documentos del anuncio (pliegos, documentos generales, los de cada aviso publicado...): se recorre
// el árbol buscando referencias externas. Clave: URL del documento. Valor: su nombre.
export const documentsOf = (entry) => {
  const docs = new Map();
  const walk = (node, label) => {
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, label));
    } else if (node && typeof node === 'object') {
      const here = text(node['cbc:ID']) ?? label;
      const external = node['cac:ExternalReference'];
      for (const ref of asArray(external)) {
        const uri = text(ref['cbc:URI']);
        if (uri) docs.set(`${uri}`, `${text(ref['cbc:FileName']) ?? here ?? uri}`);
      }
      Object.values(node).forEach((child) => walk(child, here));
    }
  };
  walk(entry?.[FOLDER], null);
  return docs;
};

// previous = null si es la primera versión que conocemos del anuncio.
export const describeChange = (entry, previous) => {
  if (!previous) return { isNew: true, status: { from: null, to: statusOf(entry) }, added: [], removed: [] };
  const now = documentsOf(entry);
  const before = documentsOf(previous);
  const names = (from, not) => [...from].filter(([uri]) => !not.has(uri)).map(([, name]) => name);
  return {
    isNew: false,
    status: { from: statusOf(previous), to: statusOf(entry) },
    added: names(now, before),
    removed: names(before, now),
  };
};

// Versión inmediatamente anterior del mismo anuncio guardada en `<dumpDir>/<sfx>/`, o null.
export const previousVersion = async (dumpDir, sfx, entry) => {
  const id = `${entry.id}`.split('/').pop();
  const ts = Date.parse(entry.updated);
  let files;
  try {
    files = await readdir(join(dumpDir, sfx));
  } catch {
    return null;
  }
  const best = files
    .map((f) => ({ f, m: /^(\d+)-(\d+)\.json$/.exec(f) }))
    .filter(({ m }) => m && m[1] === id && Number(m[2]) < ts)
    .sort((a, b) => Number(b.m[2]) - Number(a.m[2]))[0];
  return best ? JSON.parse(await readFile(join(dumpDir, sfx, best.f), 'utf8')) : null;
};
