// Envía un correo de prueba por SES con la misma configuración que el aviso real (para comprobar remitente,
// región y credenciales). Lee TEST_TO (destinatarios) y las variables de notify.js; no imprime direcciones ni
// credenciales: los logs de Actions son públicos.
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

import { loadMailConfig } from '../lib/notify.js';

try {
  const config = loadMailConfig({ ...process.env, SEND_EMAILS: '1', NOTIFY_TO: process.env.TEST_TO });
  const client = new SESClient({ region: config.region });
  const result = await client.send(new SendEmailCommand({
    Destination: { BccAddresses: config.recipients },
    Message: {
      Subject: { Charset: 'UTF-8', Data: '[Licitaciones] Prueba de envío' },
      Body: { Charset: 'UTF-8', Text: { Charset: 'UTF-8', Data: 'Correo de prueba del aviso de contratación del Ayuntamiento de Aranda de Duero. Si lo recibes, el envío funciona.' } },
    },
    Source: config.from,
  }));
  console.log(`Enviado a ${config.recipients.length} destinatario(s) desde el remitente configurado. MessageId: ${result.MessageId}`);
} catch (error) {
  // solo el tipo y el mensaje del error de SES (no incluyen credenciales)
  console.error(`Fallo al enviar: ${error.name}: ${error.message}`);
  process.exitCode = 1;
}
