# Imágenes publicadas

Ficheros estáticos de `docs/images/` (GitHub Pages los publica con el resto de `docs/`; el workflow nocturno solo
reescribe `index.html` y los `.ics`, no toca esta carpeta). Logotipos y escudo son marca e imagen oficiales del
Ayuntamiento de Aranda de Duero (Imagen Institucional): uso institucional.

| Fichero | Uso |
|---|---|
| `og-contratacion.png` (1200×630) | Miniatura al compartir (Open Graph y Twitter/X `summary_large_image`) |
| `og-contratacion-1x1.png` (1080×1080) | Versión cuadrada para quien la necesite (no está enlazada en las metas) |
| `favicon.ico` (16/32/48), `favicon-32.png` | Icono de pestaña |
| `apple-touch-icon.png` (180×180) | Icono de iOS al añadir a la pantalla de inicio |
| `icon-192.png`, `icon-512.png` | Iconos del `site.webmanifest` (Android / PWA) |

## Cómo se generaron

- Miniaturas: página HTML temporal con la fuente Outfit (`transparencia/fonts`) y el logotipo horizontal oficial
  (`04c-logotipo-horizontal-v1-azul-negativo`, JPG de alta resolución) sobre su azul corporativo `#30b5e5`; captura a
  1200×630 y 1080×1080 con Playwright (factor de escala 1) y `magick -strip`. Márgenes de texto ≥ 75 px.
- Iconos: `magick` desde `08-escudo-color.jpg` (recortado, cuadrado, fondo blanco, escudo al 86 %).

## Instagram

Instagram no tiene metaetiquetas propias: al compartir el enlace en mensajes o historias usa `og:image` (Open
Graph), es decir `og-contratacion.png`. Por eso no hay metas específicas de Instagram.
