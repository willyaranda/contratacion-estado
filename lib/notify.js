// Aviso por email (Amazon SES) cuando hay anuncios nuevos.
//
// Se configura solo con variables de entorno (en GitHub: secrets del repositorio, nunca ficheros versionados):
//   SEND_EMAILS=1               activa el aviso (si no está, no se envía nada)
//   NOTIFY_TO                   destinatarios separados por comas; se envían siempre en CCO
//   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   credenciales de AWS (las lee el SDK directamente del entorno)
//   AWS_REGION                  opcional, por defecto eu-west-1
//   MAIL_FROM                   opcional, remitente verificado en SES
//
// Ninguno de los mensajes de error ni de log de este módulo incluye valores de credenciales ni direcciones de
// correo: en un repositorio público los logs de Actions lo son también.
import { SendEmailCommand } from '@aws-sdk/client-ses';

import { contractingPartyName } from './ayuntamiento.js';

export const DEFAULT_FROM = 'info@sentiraranda.es';
export const DEFAULT_REGION = 'eu-west-1';
// SES admite como máximo 50 destinatarios por mensaje
export const MAX_RECIPIENTS_PER_MESSAGE = 50;
// Tope de anuncios listados en el cuerpo del correo (el resto se resume en una línea)
export const MAX_ENTRIES_IN_BODY = 100;

const EMAIL = /^[^\s@,;<>"()[\]]+@[^\s@,;<>"()[\]]+\.[^\s@,;<>"()[\]]+$/;

// "a@b.com, c@d.com" -> ['a@b.com', 'c@d.com']. Lanza un error si la lista no es correcta.
export const parseRecipients = (value) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('NOTIFY_TO está vacía o no definida: indica los destinatarios separados por comas.');
  }

  const items = value.split(',').map((item) => item.trim());
  const position = (predicate) => items.flatMap((item, i) => (predicate(item) ? [i + 1] : []));

  const empty = position((item) => item === '');
  if (empty.length > 0) {
    throw new Error(`NOTIFY_TO tiene elementos vacíos en las posiciones ${empty.join(', ')} (¿coma de más?).`);
  }

  const invalid = position((item) => !EMAIL.test(item));
  if (invalid.length > 0) {
    throw new Error(`NOTIFY_TO tiene direcciones no válidas en las posiciones ${invalid.join(', ')}; deben ir separadas por comas.`);
  }

  // sin repetidos (sin distinguir mayúsculas), conservando el orden y la primera aparición de cada dirección
  const seen = new Set();
  return items.filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// Lee la configuración del entorno. Si el aviso está activado y algo falta o es incorrecto, lanza un error:
// el job debe fallar, no seguir sin enviar.
export const loadMailConfig = (env) => {
  if (env.SEND_EMAILS !== '1') {
    return { enabled: false };
  }

  const recipients = parseRecipients(env.NOTIFY_TO);

  const missing = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Faltan credenciales de AWS en el entorno: ${missing.join(', ')}.`);
  }

  const from = env.MAIL_FROM || DEFAULT_FROM;
  if (!EMAIL.test(from)) {
    throw new Error('MAIL_FROM no es una dirección de correo válida.');
  }

  return {
    enabled: true,
    recipients,
    from,
    region: env.AWS_REGION || DEFAULT_REGION,
  };
};

const chunk = (list, size) => {
  const parts = [];
  for (let i = 0; i < list.length; i += size) parts.push(list.slice(i, i + size));
  return parts;
};

// Asunto y cuerpo (texto plano) del resumen de anuncios nuevos.
export const buildDigest = (entries) => {
  const n = entries.length;
  const subject = `[Licitaciones] ${n} ${n === 1 ? 'anuncio nuevo' : 'anuncios nuevos'} del Ayuntamiento de Aranda de Duero`;

  const shown = entries.slice(0, MAX_ENTRIES_IN_BODY).map((entry) => [
    `- ${entry.title ?? '(sin título)'}`,
    `  ${contractingPartyName(entry) || 'Órgano no indicado'}`,
    entry.summary?.['#text'] ? `  ${entry.summary['#text']}` : null,
    entry.link?.['@_href'] ? `  ${entry.link['@_href']}` : null,
  ].filter(Boolean).join('\n'));

  const lines = [`${subject}.`, '', ...shown];
  if (n > shown.length) {
    lines.push('', `… y ${n - shown.length} más (están en el repositorio, carpeta dump/).`);
  }
  return { subject, body: lines.join('\n') };
};

// Envía el resumen. Los destinatarios van SIEMPRE en CCO (BccAddresses): nadie ve a los demás.
// `client` es un cliente de SES (o un doble en los tests). Devuelve el número de mensajes enviados.
export const sendDigest = async ({ config, entries, client }) => {
  if (!config.enabled || entries.length === 0) {
    return 0;
  }

  const { subject, body } = buildDigest(entries);
  const messages = chunk(config.recipients, MAX_RECIPIENTS_PER_MESSAGE);
  for (const bcc of messages) {
    await client.send(new SendEmailCommand({
      Destination: { BccAddresses: bcc },
      Message: {
        Subject: { Charset: 'UTF-8', Data: subject },
        Body: { Text: { Charset: 'UTF-8', Data: body } },
      },
      Source: config.from,
    }));
  }
  return messages.length;
};
