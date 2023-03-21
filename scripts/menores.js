import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// eslint-disable-next-line no-underscore-dangle
const __filename = fileURLToPath(import.meta.url);

// eslint-disable-next-line no-underscore-dangle
const __dirname = dirname(__filename);

const readAll = async () => {
  const files = await readdir(join(__dirname, '..', 'dump', 'menores'));
  // open each files and save the content into a map
  return Promise.all(files.map(async (file) => {
    const data = await readFile(join(__dirname, '..', 'dump', 'menores', file), 'utf8');
    return JSON.parse(data);
  }));
};

const awardedPartyMap = {};

const showDaysDiff = (tender) => {
  const updated = new Date(tender.updated);
  const tenderDate = new Date(tender['cac-place-ext:ContractFolderStatus']['cac:TenderResult']['cbc:AwardDate']);
  const id = tender['cac-place-ext:ContractFolderStatus']['cbc:ContractFolderID'];
  let money = -1;
  try {
    money = tender['cac-place-ext:ContractFolderStatus']['cac:TenderResult']['cac:AwardedTenderedProject']['cac:LegalMonetaryTotal']['cbc:PayableAmount']['#text'];
  } catch (error) {
    console.log(`No money for tender id ${id}`);
  }
  let awardedParty = '';
  try {
    awardedParty = tender['cac-place-ext:ContractFolderStatus']['cac:TenderResult']['cac:WinningParty']['cac:PartyIdentification']['cbc:ID']['#text'];
  } catch (error) {
    console.log(`No awarded party for tender id ${id}`);
  }
  // return the days difference between tenderDate and updated
  const diff = Math.round((updated - tenderDate) / (1000 * 3600 * 24));
  if (diff > 90) {
    console.log(`Tender ${id} to ${awardedParty}, cost ${money} updated on ${updated.toLocaleDateString('es-ES')} and tender date is ${tenderDate.toLocaleDateString('es-ES')}. Diff is ${diff} days`);
  }

  if (awardedPartyMap[awardedParty] === undefined) {
    awardedPartyMap[awardedParty] = [];
  }
  awardedPartyMap[awardedParty].push({ id, money });

  // return (updated - tenderDate) / (1000 * 3600 * 24);
};

(async () => {
  const tenders = await readAll();
  const filtered = tenders.filter((tender) => tender.summary['#text'].includes('Ayuntamiento de Aranda de Duero'));
  filtered.forEach(showDaysDiff);
  console.log(awardedPartyMap);
})();
