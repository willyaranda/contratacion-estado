import test from 'ava';

import { fetchText } from '../lib/http.js';

const ok = (body) => ({ ok: true, status: 200, text: async () => body });
const fail = (status, statusText = '') => ({ ok: false, status, statusText, text: async () => '' });

// fetch falso que va devolviendo (o lanzando) las respuestas indicadas, en orden
const sequence = (...steps) => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetchImpl, calls };
};

test('devuelve el texto de la respuesta', async (t) => {
  const { fetchImpl, calls } = sequence(ok('<feed/>'));
  t.is(await fetchText('https://example.test/feed.atom', { fetchImpl }), '<feed/>');
  t.deepEqual(calls, ['https://example.test/feed.atom']);
});

test('reintenta con espera creciente y acaba funcionando', async (t) => {
  const { fetchImpl, calls } = sequence(fail(503, 'Service Unavailable'), new Error('socket hang up'), ok('ya'));
  const waits = [];
  const logs = [];
  const result = await fetchText('https://example.test/a', {
    fetchImpl,
    baseDelayMs: 1000,
    sleep: async (ms) => { waits.push(ms); },
    log: (m) => logs.push(m),
  });
  t.is(result, 'ya');
  t.is(calls.length, 3);
  t.deepEqual(waits, [1000, 2000]);
  t.is(logs.length, 2);
  t.regex(logs[0], /HTTP 503 Service Unavailable/);
  t.regex(logs[1], /socket hang up/);
});

test('falla tras agotar los intentos conservando la causa', async (t) => {
  const { fetchImpl, calls } = sequence(fail(500, 'Internal Server Error'));
  const error = await t.throwsAsync(fetchText('https://example.test/b', {
    fetchImpl, attempts: 2, sleep: async () => {},
  }), { message: /tras 2 intentos: HTTP 500/ });
  t.is(calls.length, 2);
  t.regex(error.cause.message, /HTTP 500/);
});

test('un error de red también se reintenta y se informa', async (t) => {
  const { fetchImpl, calls } = sequence(new Error('ECONNRESET'));
  await t.throwsAsync(fetchText('https://example.test/c', {
    fetchImpl, attempts: 3, sleep: async () => {},
  }), { message: /ECONNRESET/ });
  t.is(calls.length, 3);
});

test('cada petición lleva un límite de tiempo y una petición colgada acaba por fallar', async (t) => {
  const signals = [];
  // fetch que no responde nunca, salvo que se aborte la señal
  const hanging = (url, { signal }) => new Promise((resolve, reject) => {
    signals.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason));
  });
  // AbortSignal.timeout no mantiene vivo el proceso (en producción lo hace el socket real): se simula aquí
  const keepAlive = setInterval(() => {}, 10);
  const error = await t.throwsAsync(fetchText('https://example.test/lento', {
    fetchImpl: hanging, attempts: 2, timeoutMs: 30, sleep: async () => {},
  }), { message: /tras 2 intentos/ }).finally(() => clearInterval(keepAlive));
  t.is(signals.length, 2);
  t.true(signals.every((s) => s.aborted));
  t.regex(error.cause.message, /timeout|aborted|abort/i);
});

test('usa una espera real por defecto', async (t) => {
  const { fetchImpl } = sequence(fail(502), ok('bien'));
  t.is(await fetchText('https://example.test/d', { fetchImpl, attempts: 2, baseDelayMs: 1 }), 'bien');
});
