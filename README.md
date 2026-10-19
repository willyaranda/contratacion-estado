# Contratación del Ayuntamiento de Aranda de Duero

Descarga los anuncios de contratación del Ayuntamiento de Aranda de Duero publicados en la
[Plataforma de Contratación del Sector Público](https://contrataciondelestado.es), los guarda como JSON en
[`dump/`](dump/) y publica una página de transparencia con los datos.

- **Página de transparencia:** <https://willyaranda.github.io/contratacion-estado/>
- **Calendario de Contratación (.ics):** <https://willyaranda.github.io/contratacion-estado/aperturas.ics>

## Qué incluye

- Licitaciones y contratos menores del Ayuntamiento, con adjudicatarios, importes, ofertas y plazos.
- Indicadores y comparativas por corporación (mandato), con la guía de cada indicador.
- Licitaciones con plazo de presentación abierto.
- Un calendario que se puede suscribir desde cualquier cliente (Google Calendar, Apple, Outlook) con:
  `PUB` (publicación), `ULT. DÍA` (fin del plazo de ofertas), `ADJ` y `ADJ. MENOR` (adjudicaciones),
  `AVISO FIN` (fin previsto del contrato, con alarma el día antes) y las aperturas de ofertas.

## Cómo funciona

1. `npm run fetch` recorre el feed de la Plataforma y descarga a `dump/` los anuncios nuevos. Guarda un punto de
   control en `dump/.state.json` para recorrer solo lo nuevo, porque el servidor es lento. Si `SEND_EMAILS=1`, avisa
   por email (Amazon SES) de los anuncios nuevos.
2. `npm run build:site` genera `transparencia/index.html` (página autocontenida) y `aperturas.ics` a partir de `dump/`
   y de `transparencia/template.html`.
3. El workflow [`nightly.yml`](.github/workflows/nightly.yml) lo hace cada noche y a mediodía, sube los datos y
   despliega la página en GitHub Pages desde `docs/`.

## Desarrollo

Requiere Node.js 26 o superior.

```sh
npm install
npm run fetch        # descarga los anuncios nuevos a dump/
npm run build:site   # reconstruye la página y el calendario
npm run lint
npm test
```

Tras cambiar `transparencia/template.html` o `transparencia/extract.js`, copia `transparencia/index.html` a
`docs/index.html` y súbelo: es lo que publica GitHub Pages.

Configuración del envío de correos (opcional): `SEND_EMAILS=1`, `NOTIFY_TO` (destinatarios, van siempre en CCO),
`MAIL_FROM`, `AWS_REGION` y las credenciales de AWS. Nunca se escriben en el repositorio.

## Datos

Los datos proceden de fuentes públicas de la Plataforma de Contratación del Sector Público. La página es informativa:
confirma siempre el estado de cada procedimiento en el anuncio original.

## Licencia

ISC.
