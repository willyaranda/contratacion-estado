// Google Analytics 4 con consentimiento (RGPD). Un único origen para la página principal y /datos: build.js sustituye
// los marcadores __GA_ID__, __CONSENT_KEY__ y __DENIED_TTL_MS__ (valores de transparencia/site.js) e incrusta el script.
// No se carga ni se envía nada a Google hasta que la persona pulsa «Aceptar».
(() => {
  const GA_ID = '__GA_ID__';
  const CONSENT_KEY = '__CONSENT_KEY__';
  const DENIED_TTL_MS = Number('__DENIED_TTL_MS__');
  const GRANTED = 'granted';
  const DENIED = 'denied';
  let gaLoaded = false;

  // Decisión vigente a partir del valor guardado: 'granted' | 'denied' | '' (hay que preguntar).
  // «Aceptar» no caduca; «Rechazar» vale DENIED_TTL_MS. Valores corruptos o con fecha futura -> se pregunta.
  const consentState = (raw, nowMs) => {
    let saved;
    try { saved = JSON.parse(raw); } catch { return ''; }
    if (!saved || typeof saved !== 'object') return '';
    const { v, t } = saved;
    if (typeof t !== 'number' || !Number.isFinite(t) || t > nowMs) return '';
    if (v === GRANTED) return GRANTED;
    if (v === DENIED) return nowMs - t < DENIED_TTL_MS ? DENIED : '';
    return '';
  };

  const doNotTrack = () => window.navigator?.doNotTrack === '1' || window.doNotTrack === '1';

  const readConsent = () => {
    try { return consentState(window.localStorage.getItem(CONSENT_KEY), Date.now()); } catch { return ''; }
  };
  const saveConsent = (v) => {
    // sin localStorage (privado o bloqueado) no se recuerda: se vuelve a preguntar y GA nunca carga sin «Aceptar»
    try { window.localStorage.setItem(CONSENT_KEY, JSON.stringify({ v, t: Date.now() })); } catch { /* sin almacenamiento */ }
  };
  const clearConsent = () => {
    try { window.localStorage.removeItem(CONSENT_KEY); } catch { /* sin almacenamiento */ }
  };

  const loadGa = () => {
    window[`ga-disable-${GA_ID}`] = false;
    if (gaLoaded) return;
    gaLoaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_ID);
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
    document.head.appendChild(s);
  };

  // Borra las cookies de GA (_ga, _ga_XXXX) al retirar el consentimiento, en el host y en sus dominios superiores.
  const clearGaCookies = () => {
    const names = String(document.cookie || '').split(';').map((c) => c.split('=')[0].trim()).filter((n) => n.startsWith('_ga'));
    const parts = String(window.location?.hostname || '').split('.');
    const domains = [''];
    for (let i = 0; i < parts.length - 1; i += 1) domains.push(`; domain=.${parts.slice(i).join('.')}`);
    for (const n of names) for (const d of domains) document.cookie = `${n}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${d}`;
  };

  const init = () => {
    const banner = document.querySelector('[data-analytics-consent]');
    const prefs = [...document.querySelectorAll('[data-analytics-prefs]')];
    if (doNotTrack()) {
      // Do Not Track: ni aviso ni GA ni enlace de preferencias (no hay nada que decidir)
      for (const p of prefs) p.hidden = true;
      return;
    }
    const show = (visible) => { if (banner) banner.hidden = !visible; };
    const state = readConsent();
    if (state === GRANTED) loadGa();
    show(state === '');
    if (banner) {
      banner.querySelector('[data-analytics-accept]')?.addEventListener('click', () => {
        saveConsent(GRANTED);
        loadGa();
        show(false);
      });
      banner.querySelector('[data-analytics-reject]')?.addEventListener('click', () => {
        saveConsent(DENIED);
        window[`ga-disable-${GA_ID}`] = true;
        show(false);
      });
    }
    for (const p of prefs) {
      p.addEventListener('click', () => {
        // retirar el consentimiento: borra la decisión, detiene el seguimiento y vuelve a preguntar
        clearConsent();
        window[`ga-disable-${GA_ID}`] = true;
        clearGaCookies();
        show(true);
        banner?.querySelector('[data-analytics-accept]')?.focus();
      });
    }
  };

  window.contratacionAnalytics = { consentState, loadGa };
  init();
})();
