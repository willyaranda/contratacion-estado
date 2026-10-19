// Analítica con consentimiento: ensambla el script, los estilos y el aviso compartidos por la página principal y /datos
// (transparencia/analytics.{js,css,html}) con los valores de transparencia/site.js. Cada plantilla trae dos marcadores:
// /*ANALYTICS_CSS*/ (dentro de <style>) y <!--ANALYTICS--> (antes de </body>).
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  CONSENT_KEY, DENIED_TTL_DAYS, GA_ID, PRIVACY_URL,
} from '../transparencia/site.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'transparencia');
const read = (name) => readFileSync(join(DIR, name), 'utf8');

const fill = (text, values) => Object.entries(values).reduce((s, [k, v]) => s.replaceAll(k, () => String(v)), text);

export const analyticsScript = () => fill(read('analytics.js'), {
  __GA_ID__: GA_ID,
  __CONSENT_KEY__: CONSENT_KEY,
  __DENIED_TTL_MS__: DENIED_TTL_DAYS * 24 * 3600 * 1000,
}).trim();

export const analyticsReplacements = () => ({
  '/*ANALYTICS_CSS*/': read('analytics.css').trim(),
  '<!--ANALYTICS-->': fill(read('analytics.html').trim(), {
    __DENY_DAYS__: DENIED_TTL_DAYS,
    __PRIVACY_URL__: PRIVACY_URL,
    __ANALYTICS_SCRIPT__: analyticsScript(),
  }),
});

export const applyAnalytics = (html) => Object.entries(analyticsReplacements())
  .reduce((s, [marker, value]) => s.replaceAll(marker, () => value), html);
