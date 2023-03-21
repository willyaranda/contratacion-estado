import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

import bent from 'bent';

import { XMLParser } from 'fast-xml-parser';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { constants, access, writeFile } from 'fs/promises';

// eslint-disable-next-line no-underscore-dangle
const __filename = fileURLToPath(import.meta.url);

// eslint-disable-next-line no-underscore-dangle
const __dirname = dirname(__filename);

const licitacionesURI = 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom';
const menoresURI = 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_1143/contratosMenoresPerfilesContratantes.atom';
const agregacionURI = 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_1044/PlataformasAgregadasSinMenores.atom';

const MAXIMUM_SEEN_TO_STOP = 1;

const TO_ADDRESSES = [
  'YOUR_MAIL@here.com',
];

let ses;

const suffix = (url) => {
  if (url.includes('contratosMenoresPerfilesContratantes')) {
    return 'menores';
  }

  if (url.includes('licitacionesPerfilesContratanteCompleto3')) {
    return 'licitaciones';
  }

  if (url.includes('PlataformasAgregadasSinMenores')) {
    return 'agregacion';
  }

  return 'other';
};

const buyerProfileURIID = [
  'd9hKqzSze9gQK2TEfXGy',
];

const postalCode = [
  9400,
];

const cityName = [
  'Aranda de Duero',
];

const summaryWords = [
  'aranda de duero',
];

const titleWords = [
  'aranda de duero',
];

const options = {
  ignoreAttributes: false,
};

const parser = new XMLParser(options);

const filesSeen = {
  licitaciones: 0,
  menores: 0,
  agregacion: 0,
};
const licitacionesCounter = {
  licitaciones: 0,
  menores: 0,
  agregacion: 0,
};

const initializeSES = async () => new SESClient({ region: 'eu-west-1' });

const getXml = async (url) => {
  const sfx = suffix(url);
  console.log(url, sfx);
  filesSeen[sfx] += 1;
  console.log(`Downloading ${sfx} XML (filesSeen = ${filesSeen[sfx]}, exists = ${licitacionesCounter[sfx]}) from: `, url);
  const get = bent(url, 'GET', 'string');
  const data = await get();
  const jsonObj = parser.parse(data);

  for (const entry of jsonObj.feed.entry) {
    let iincludes = false;
    let iinteresting = false;
    const str = JSON.stringify(entry);
    if (str.includes('Aranda de Duero')) {
      iincludes = true;
    }

    if (isInteresting(entry)) {
      iinteresting = true;
    }

    if (iincludes && iinteresting) {
      console.log(JSON.stringify({
        summary: entry.summary['#text'],
        title: entry.title,
        link: entry.link['@_href'],
      }, null, 2));
      await (dump(entry, sfx));
    } else if (iincludes !== iinteresting) {
      // console.log('WAAAAAAAAT');
      // console.log(JSON.stringify(entry));
      await (dump(entry, sfx));
    }
  }

  if (licitacionesCounter[sfx] >= MAXIMUM_SEEN_TO_STOP) {
    console.log(`Found ${licitacionesCounter[sfx]} files already downloaded for ${sfx}. DONE!`);
    return;
  }

  jsonObj.feed.link.forEach((link) => {
    if (link['@_rel'] === 'next') {
      return getXml(link['@_href']);
    }
  });
};

const sendEmail = async (lic) => {
  console.log(`--- Sending email for ${lic.id}`);
  const sec = new SendEmailCommand({
    Destination: {
      ToAddresses: TO_ADDRESSES,
    },
    Message: {
      Body: {
        Text: {
          Charset: 'UTF-8',
          Data: JSON.stringify(lic, null, 2),
        },
      },
      Subject: {
        Charset: 'UTF-8',
        Data: `[Licitaciones] ${lic.summary['#text']}`,
      },
    },
    Source: 'info@sentiraranda.es',
  });
  return ses.send(sec);
};

const dump = async (entry, sfx) => {
  const id = entry.id.split('/').pop();
  const ts = Date.parse(entry.updated);
  const fileName = join(__dirname, 'dump', sfx, `${id}-${ts}.json`);
  // check first if the file exists
  try {
    await access(fileName, constants.F_OK);
    console.log(`File ${fileName} already exists`);
    licitacionesCounter[sfx] += 1;
  } catch (error) {
    console.log(`--- Writing file ${fileName}`);
    await writeFile(fileName, JSON.stringify(entry, null, 2));
    await sendEmail(entry);
  }
};

const isInteresting = (entry) => {
  let rv = [];

  try {
    rv = [
      isBuyerProfileInteresting(entry),
      isPostalCodeInteresting(entry),
      isCityNameInteresting(entry),
      isSummaryInteresting(entry),
      isTitleInteresting(entry),
    ];
  } catch (error) {
    console.log(error);
    console.log(JSON.stringify(entry));
    process.exit(1);
  }

  return rv.includes(true);
};

const isBuyerProfileInteresting = (entry) => buyerProfileURIID.some((id) => `${entry['cac-place-ext:ContractFolderStatus']?.
  ['cac-place-ext:LocatedContractingParty']?.
  ['cbc:BuyerProfileURIID']}`.includes(id));

const isPostalCodeInteresting = (entry) => postalCode.some((code) => entry['cac-place-ext:ContractFolderStatus']?.
  ['cac-place-ext:LocatedContractingParty']?.
  ['cac:Party']?.
  ['cac:PostalAddress']?.
  ['cbc:PostalZone'].includes?.(code));

const isCityNameInteresting = (entry) => cityName.some((city) => `${entry['cac-place-ext:ContractFolderStatus']?.
  ['cac-place-ext:LocatedContractingParty']?.
  ['cac:Party']?.
  ['cac:PostalAddress']?.
  ['cbc:CityName']}`.toLowerCase().includes(city.toLowerCase()));

const isSummaryInteresting = (entry) => summaryWords.some((word) => entry.summary['#text'].toLowerCase().includes(word.toLowerCase()));

const isTitleInteresting = (entry) => titleWords.some((word) => `${entry.title}`.toLowerCase().includes(word.toLowerCase()));

// Run main async function
(async () => {
  ses = await initializeSES();
  await getXml(licitacionesURI);
  await getXml(menoresURI);
  // await getXml(agregacionURI);
})();
