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
| `instagram-insights.csv` | Meta Business Suite → Estadísticas → Contenido. Detección, alias en inglés, `Accounts reached`, un carrusel, y `Date` como día del informe (propone la fecha de la exportación). |
| `instagram-insights-meta.csv` | La misma exportación con las fechas **como las escribe Meta**: `Publish time` en mes/día («09/03/2026 15:04») en cualquier idioma de la cuenta, `Reach` en vez de `Accounts reached` y `Date` también en mes/día. Ninguna fecha pasa de 12, así que el archivo no demuestra su orden: manda el del formato (`ordenFechas: "md"` en `FORMATOS`), no el del workspace. Es el que usa `integracion.test.ts` para el «terminado cuando» de RES-2. |
| `tiktok-studio.csv` | TikTok Studio → Analíticas → Contenido. Id sacado del enlace, miles con coma, sin columna de alcance. |
| `youtube-studio.csv` | YouTube Studio → Modo avanzado (`Table data.csv`) **en su forma real**: una fila `Total` bajo los encabezados (se descarta sin ser error), `Video publish time` con el mes en texto («Sep 5, 2026»), `Duration` en segundos, `Content` como id y decimales con punto. |
| `desconocido.csv` | Cabecera en español que no casa con ninguna firma: se detecta la red como nula (la persona tiene que elegirla) y el mapeo automático es parcial. Las etiquetas habituales de Meta y TikTok en español —«Texto», «Personas alcanzadas»— se mapean solas; el id («Referencia interna») y la fecha («Día de salida», un nombre inventado a propósito) quedan para el mapeo manual. |
| `sucio.csv` | Filas con problemas: fecha ilegible, número con letras, duplicada, sin id, fecha futura. |
| `tiktok-studio-en-us.csv` | La misma exportación de TikTok con la cuenta en inglés de Estados Unidos: fechas **mes/día** («09/05/2026» es el 5 de septiembre) y una hora en reloj de 12 h («8:15 PM»). El orden lo demuestra el propio archivo («09/14/2026»). |
| `ambiguo.csv` | Fechas numéricas que sirven en los dos órdenes (ningún número pasa de 12): el asistente pregunta, con el orden del workspace como propuesta. |

## Lo que no está documentado con certeza

- El orden mes/día de Meta en `Publish time` es lo que se sabe de
  exportaciones reales y de terceros; Meta no lo publica. Si una
  exportación demuestra otro orden (un número mayor que 12), manda el
  archivo, y si no, el paso 2 deja cambiarlo.
- YouTube Studio escribe el mes en el idioma de la cuenta. El parser
  entiende inglés y español (con la tabla de meses de Intl); otro
  idioma saldría como «fecha ilegible» y hoy la única salida sería
  volver a exportar en uno de esos dos.
- TikTok Studio no tiene una exportación estable por video: los dos
  fixtures de TikTok son la forma que describen los exportadores
  conocidos, y el mapeo manual cubre lo demás.

## El orden día/mes

Una fecha numérica no dice sola si es día/mes o mes/día, y Meta y
TikTok la escriben en el orden del idioma de la cuenta. Por eso el
orden se decide **para el archivo entero**, no celda a celda
(`analizarFechas` en `_lib/csv.ts`): una fecha con el primer número
mayor que 12 demuestra día/mes; una con el segundo mayor que 12,
mes/día; y si ninguna lo demuestra, el paso 2 pregunta con un orden ya
elegido —el del formato reconocido si lo tiene (Meta: mes/día), si no
el del locale del workspace— y una fecha del archivo leída en ese
orden. El paso 3 avisa si en el otro orden las fechas se juntarían en
unos días en vez de repartirse en meses.
