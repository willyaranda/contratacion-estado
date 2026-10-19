# contratacion-estado

Descarga los anuncios de contratación del Ayuntamiento de Aranda de Duero (Plataforma de Contratación del Sector
Público), los guarda en `dump/` y publica una página de transparencia en GitHub Pages.

## Comandos

- `npm run fetch`: descarga los anuncios nuevos del Ayuntamiento a `dump/` (avisa por email si `SEND_EMAILS=1`).
- `npm run build:site`: genera `transparencia/index.html` y `artifact.html` desde `dump/` y `template.html`.
- `dump/aperturas.json`: fechas de apertura de ofertas de todas las licitaciones (las escribe `npm run fetch`
  leyendo la ficha web: el feed no las trae). De él sale `docs/aperturas.ics` (calendario), que `build:site` genera en
  `transparencia/aperturas.ics` y el nocturno copia a `docs/`.
- `npm run lint` y `npm test` (ava + c8): deben pasar antes de commitear.

## Convenciones

- Se trabaja y se hace push directo a `main`, sin ramas de feature. Hacer `git fetch` antes de empujar y
  `git rebase origin/main` si hay algo nuevo (el workflow nocturno también sube commits). Nunca `--force`.
- Los commits terminan con el trailer `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Tras cambiar `transparencia/template.html` o `extract.js`, reconstruir y **commitear siempre `docs/index.html`**
  (`npm run build:site` y copiar `transparencia/index.html` a `docs/index.html`).
- Nunca imprimir ni escribir credenciales. Las credenciales de AWS son secrets de GitHub (`AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`); los destinatarios son la variable de repositorio `NOTIFY_TO` (no es un secreto) y van
  siempre en CCO.
- Los contratos se asignan a la corporación que los sacó: licitaciones por fecha de publicación del anuncio y
  contratos menores por fecha de adjudicación.

## Pipeline

- `.github/workflows/nightly.yml` (02:17, 05:43, 14:17 y 15:17 UTC; GitHub no garantiza los disparos programados,
  por eso hay varios, y los de mediodía recogen lo publicado por la mañana):
  descarga, build, commit de `dump/` y `docs/`, y despliegue de Pages. La descarga guarda un punto de control en
  `dump/.state.json` (hasta dónde llegó en el feed de toda España) para recorrer solo lo nuevo; el servidor de la
  Plataforma es lento (minutos por página) y no hay que quitar el límite de tiempo por petición ni el punto de control.
- `.github/workflows/pages.yml`: publica `docs/` en cada push a `main` que lo cambie, o cuando lo invoca el nocturno.
- `.github/workflows/test.yml`: lint y tests en cada push y pull request.

## Qué NO se actualiza solo (recordárselo al usuario)

La página de GitHub Pages **sí** se actualiza sola (cada noche y en cada push que cambie `docs/`).
**No** se actualizan solos:

1. **Las cifras y análisis dados en una conversación** (comparativas entre mandatos, totales, rankings): son una
   foto de la fecha en que se calcularon.
2. **Los textos fijos de la página**: guía de indicadores, umbrales legales, fechas de constitución de las
   corporaciones. Solo cambian si se editan en `template.html`.

(El artefacto de claude.ai que existía se borró a petición del usuario; no hay otra copia publicada.)

**Regla:** al dar cifras o análisis, recuérdale al usuario en una línea que son una foto de la fecha de los datos y
que puede pedirte recalcularlos con los últimos datos.

Cuando lo pida: `git pull --rebase origin main` (trae los datos de la noche), `npm run build:site`, copiar a
`docs/index.html` y volver a calcular el análisis.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for this repo (uses `gh` CLI). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout (one `CONTEXT.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.
