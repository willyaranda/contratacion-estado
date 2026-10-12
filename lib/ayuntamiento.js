// Lógica pura sobre los anuncios del feed de contratación: de quién es y cómo se llama su fichero.
// La usan el script de descarga (index.js) y la página de transparencia (transparencia/extract.js).

// Órgano de contratación del Ayuntamiento de Aranda de Duero (Alcaldía, Junta de Gobierno o Pleno).
export const AYUNTAMIENTO = /Ayuntamiento de Aranda de Duero/i;

// ni null ni undefined
export const isPresent = (x) => x !== null && x !== undefined;

export const asArray = (x) => (isPresent(x) ? [].concat(x) : []);

// El valor puede venir como texto o como objeto con atributos ({ '#text': ... }).
export const text = (x) => (x && typeof x === 'object' ? x['#text'] : x);

// Nombre del contratante de un anuncio, o '' si no consta.
export const contractingPartyName = (entry) => {
  const party = asArray(entry?.['cac-place-ext:ContractFolderStatus']?.
    ['cac-place-ext:LocatedContractingParty']?.
    ['cac:Party'])[0];
  const name = text(asArray(party?.['cac:PartyName'])[0]?.['cbc:Name']);
  return isPresent(name) ? `${name}` : '';
};

export const isFromAyuntamiento = (entry) => AYUNTAMIENTO.test(contractingPartyName(entry));

// `<id>-<timestamp>.json`: el id es el último tramo de la URL del anuncio y el timestamp su fecha de actualización
// en milisegundos. Una nueva versión del mismo anuncio genera un fichero distinto.
export const entryFileName = (entry) => {
  const id = `${entry.id}`.split('/').pop();
  const ts = Date.parse(entry.updated);
  if (!id || Number.isNaN(ts)) {
    throw new Error(`Anuncio sin id o fecha de actualización válidos: ${JSON.stringify({ id: entry.id, updated: entry.updated })}`);
  }
  return `${id}-${ts}.json`;
};
