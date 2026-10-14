// Texto de las aperturas de ofertas para el correo.

// "Apertura sobre oferta económica" -> "Oferta económica"
export const shortType = (type) => {
  const short = `${type ?? ''}`.replace(/^apertura\s+(?:del?\s+)?(?:sobre\s+)?/i, '').trim();
  return short ? `${short[0].toUpperCase()}${short.slice(1)}` : 'Apertura';
};

const dmy = (date) => date.split('-').reverse().join('/');

const describe = (event) => [
  `${dmy(event.date)}${event.time ? ` ${event.time}` : ''}`,
  event.place,
  event.public === null ? null : `acto ${event.public ? 'público' : 'no público'}`,
].filter(Boolean).join(' · ');

const key = (event) => `${event.kind ?? ''}|${event.sobre ?? ''}`;

// `info` = { events, previous } o null. Una línea por apertura; si la fecha ha cambiado, indica la anterior.
export const openingsLines = (info) => {
  const events = info?.events ?? [];
  if (events.length === 0) return [];
  const before = new Map((info.previous ?? []).map((e) => [key(e), e]));
  return events.map((event) => {
    const old = before.get(key(event));
    const moved = old && (old.date !== event.date || old.time !== event.time)
      ? ` (antes: ${dmy(old.date)}${old.time ? ` ${old.time}` : ''})` : '';
    return `  ${event.type}: ${describe(event)}${moved}`;
  });
};
