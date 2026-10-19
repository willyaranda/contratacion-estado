// URLs absolutas del sitio, en un único sitio. Al transferir el repositorio a la organización oficial hay que
// actualizar SITE_URL y REPO_URL aquí (y el README, que es Markdown y no puede importar esto; lo vigila un test).
export const SITE_URL = 'https://willyaranda.github.io/contratacion-estado/';
export const REPO_URL = 'https://github.com/willyaranda/contratacion-estado';
export const AYTO_URL = 'https://www.arandadeduero.es';

// Analítica (Google Analytics 4) con consentimiento: nada de Google se carga hasta que la persona pulsa «Aceptar».
// GA_ID es el medidor compartido con las webs de fiestas y bienestar animal. Aceptar se recuerda para siempre;
// rechazar caduca a los DENIED_TTL_DAYS días (entonces se vuelve a preguntar).
export const GA_ID = 'G-BXMC22W46S';
export const CONSENT_KEY = 'contratacionAranda:analytics-consent';
export const DENIED_TTL_DAYS = 4;
export const PRIVACY_URL = `${AYTO_URL}/politica-privacidad/`;
