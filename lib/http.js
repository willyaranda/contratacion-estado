// Descarga de texto con reintentos. `fetchImpl` y `sleep` son inyectables para poder testearlo sin red ni esperas.

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export const fetchText = async (url, {
  fetchImpl = fetch,
  attempts = 3,
  baseDelayMs = 5000,
  sleep = defaultSleep,
  log = () => {},
} = {}) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText ?? ''}`.trim());
      }
      return await response.text();
    } catch (error) {
      if (attempt >= attempts) {
        throw new Error(`No se pudo descargar ${url} tras ${attempts} intentos: ${error.message}`, { cause: error });
      }
      log(`Intento ${attempt} fallido para ${url} (${error.message}); reintentando...`);
      await sleep(attempt * baseDelayMs);
    }
  }
};
