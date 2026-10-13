// Descarga de texto con reintentos y límite de tiempo por petición (sin él, una página lenta o colgada bloquea la
// ejecución hasta que el cliente se rinde, cinco minutos por intento).
// `fetchImpl` y `sleep` son inyectables para poder testearlo sin red ni esperas.

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export const fetchText = async (url, {
  fetchImpl = fetch,
  attempts = 3,
  timeoutMs = 120000,
  baseDelayMs = 5000,
  sleep = defaultSleep,
  log = () => {},
} = {}) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // la señal cubre la petición y la lectura del cuerpo
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
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
