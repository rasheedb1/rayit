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
| `tiktok-studio-en-us.csv` | La misma exportación de TikTok con la cuenta en inglés de Estados Unidos: fechas **mes/día** («09/05/2026» es el 5 de septiembre) y una hora en reloj de 12 h («8:15 PM»). El orden lo demuestra el propio archivo («09/14/2026»). |
| `ambiguo.csv` | Fechas numéricas que sirven en los dos órdenes (ningún número pasa de 12): el asistente pregunta, con el orden del workspace como propuesta. |

## El orden día/mes

Una fecha numérica no dice sola si es día/mes o mes/día, y Meta y
TikTok la escriben en el orden del idioma de la cuenta. Por eso el
orden se decide **para el archivo entero**, no celda a celda
(`analizarFechas` en `_lib/csv.ts`): una fecha con el primer número
mayor que 12 demuestra día/mes; una con el segundo mayor que 12,
mes/día; y si ninguna lo demuestra, el paso 2 pregunta con el orden del
locale del workspace ya elegido y una fecha del archivo leída en ese
orden.
