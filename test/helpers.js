import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const ROOT = join(HERE, '..');
// Dump real del repositorio: los tests de invariantes lo recorren entero.
export const REAL_DUMP = join(ROOT, 'dump');
// Copia reducida de anuncios reales (ver test/fixtures/dump/): permite afirmar valores concretos.
export const FIXTURES_DUMP = join(HERE, 'fixtures', 'dump');

export const loadFixture = (dir, name) => JSON.parse(readFileSync(join(FIXTURES_DUMP, dir, `${name}.json`), 'utf8'));

export const tmpDir = (prefix = 'contratacion-') => mkdtempSync(join(tmpdir(), prefix));

// Anuncio mínimo con el contratante indicado, para probar el filtro sin depender de ficheros.
export const entryFor = (partyName, extra = {}) => ({
  id: 'https://contrataciondelestado.es/sindicacion/licitacionesPerfilContratante/999',
  updated: '2026-01-01T10:00:00.000+01:00',
  title: 'Anuncio de prueba',
  summary: { '#text': 'Id licitación: T/1', '@_type': 'text' },
  link: { '@_href': 'https://example.test/anuncio' },
  'cac-place-ext:ContractFolderStatus': {
    'cbc:ContractFolderID': 'T/1',
    'cac-place-ext:LocatedContractingParty': {
      'cac:Party': { 'cac:PartyName': { 'cbc:Name': partyName } },
    },
  },
  ...extra,
});
