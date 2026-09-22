# Exportaciones de ejemplo

Cabeceras de las tres exportaciones que el creador puede subir a
`/resumen/importar`, más una que no reconocemos.

**Ninguna de las tres plataformas publica el encabezado exacto de su
exportación**, y las tres lo cambian según el informe elegido, el idioma
de la cuenta y —en YouTube— qué columnas estaban visibles al exportar.
Comprobado el 22 de septiembre de 2026 contra la documentación pública
de Meta, TikTok y Google: no hay una lista oficial contra la que
programar.

Así que estos archivos **no son un contrato**: son casos de prueba del
detector y del parser, escritos con los nombres de columna que
describen la documentación de terceros y los exportadores conocidos. El
código no depende de acertarlos: `_lib/formatos.ts` reconoce alias en
español y en inglés, y lo que no reconoce lo mapea la persona a mano en
el paso 2. Por eso hay un cuarto archivo, `desconocido.csv`: el camino
del mapeo manual también se prueba.

Cuando alguien traiga una exportación real, su cabecera entra aquí como
fixture nuevo y sus nombres de columna entran en `ALIAS`.

| Archivo | Qué prueba |
|---|---|
| `instagram-insights.csv` | Meta Business Suite → Estadísticas → Contenido. Detección, alias en inglés, `Accounts reached`, un carrusel. |
| `tiktok-studio.csv` | TikTok Studio → Analíticas → Contenido. Id sacado del enlace, miles con coma, sin columna de alcance. |
| `youtube-studio.csv` | YouTube Studio → Modo avanzado (`Table data.csv`). `Content` como id, fecha sin hora, decimales con punto. |
| `desconocido.csv` | Cabecera en español que no casa con ninguna firma: se detecta la red como nula y el mapeo automático es parcial. |
| `sucio.csv` | Filas con problemas: fecha ilegible, número con letras, duplicada, sin id, fecha futura. |
