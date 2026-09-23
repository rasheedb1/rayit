# Ingresos de plataformas (FIN-7)

Un archivo por formato de los que lee
`app/(app)/finanzas/ingresos/_lib/csv.ts`, más los casos malos.

**Estos archivos no son un contrato**, por la misma razón que los de
`../` (importación de métricas, RES-2): ninguna plataforma publica el
encabezado exacto de su exportación.

Comprobado el 23 de septiembre de 2026 contra la documentación oficial:

- **AdSense** documenta en la
  [Management API](https://developers.google.com/adsense/management/metrics-dimensions)
  que `DATE` es `YYYY-MM-DD`, `MONTH` es `YYYY-MM` y que la métrica de
  ingresos es `ESTIMATED_EARNINGS`; y que **la moneda va en las cabeceras
  de la respuesta, no en una columna**. De la descarga del panel
  ([Exportar o descargar un informe](https://support.google.com/adsense/answer/9830628))
  solo publica que hay CSV, XLSX y Hojas de cálculo: los nombres de
  columna salen en el idioma de la cuenta y dependen del informe.
- **TikTok Creator Rewards** no documenta **ninguna** exportación: el
  [soporte](https://support.tiktok.com/en/business-and-creator/creator-rewards-program/how-rewards-work)
  solo describe un balance mensual en pantalla y una factura por
  transacción. Lo que hay aquí es la forma de ese balance mensual.

Por eso el lector no exige una firma exacta: reconoce alias en español
y en inglés, y lo que no reconoce cae al **formato genérico**, que sí
documentamos nosotros y está abajo. Cuando alguien traiga una
exportación real, su cabecera entra aquí como fixture y sus nombres de
columna entran en `ALIAS`.

| Archivo | Qué prueba |
|---|---|
| `adsense-mensual.csv` | AdSense con `MONTH`: encabezados en inglés, moneda entre paréntesis (`Estimated earnings (COP)`), miles con punto y decimales con coma. Prueba además que `Page RPM (COP)` **no** se confunde con la columna del dinero. |
| `adsense-diario.csv` | AdSense con `DATE`: cinco filas diarias de dos meses distintos que se suman dentro de su mes, y una fila `Total` que se descarta sin contar como error. |
| `tiktok-creator-rewards.csv` | Creator Rewards: separador punto y coma, meses en español («septiembre de 2026») y columna `Moneda` explícita. |
| `ingresos-generico.csv` | El formato que sí controlamos: `plataforma,inicio,fin,monto,moneda`. Cada fila trae su red y su periodo exacto, y **no** se agrupa. |
| `moneda-distinta.csv` | Tres redes, tres monedas. Las que no son la del espacio salen con el aviso `monedaDistinta` y no se escriben: convertir necesita una tasa con fecha, que no está en el esquema. |
| `sucio.csv` | Una fila por cada cosa que puede ir mal: periodo ilegible, monto ilegible, monto negativo, sin periodo, sin monto y un mes que suma cero. La única buena entra. |
| `desconocido.csv` | Cabecera que no casa con nada: el formato sale `null` y no se escribe una sola fila. |

## El formato genérico

Es el que se le pide a quien trae un archivo que no reconocemos:

```csv
plataforma,inicio,fin,monto,moneda
instagram,2026-08-01,2026-08-31,260000.00,COP
```

- `plataforma`: `tiktok`, `instagram`, `facebook` o `youtube`. También
  se aceptan los nombres que escribe la gente («Tik Tok», «IG»,
  «AdSense» → `youtube`).
- `inicio` y `fin`: `YYYY-MM-DD`. Son columnas `date` de Postgres, sin
  zona horaria; con `fin` explícito el periodo se guarda tal cual y no
  se sube al mes.
- `monto`: con punto o con coma decimal, con o sin separador de miles.
- `moneda`: ISO-4217. Si no es la del espacio, la fila no se carga.

## Lo que no está documentado con certeza

- El idioma de los encabezados de AdSense es el de la cuenta, y los
  alias solo cubren español e inglés. Otro idioma cae al «no
  reconocimos ninguna columna».
- Que Creator Rewards se exporte alguna vez en CSV es una suposición:
  hoy no se puede. `tiktok-creator-rewards.csv` está escrito con la
  forma del balance mensual que sí se ve en pantalla.
- Un periodo escrito con dos números de dos cifras («09/10/2026») se
  rechaza a propósito: no dice si es día/mes o mes/día y aquí no hay
  una columna entera de fechas con la que decidirlo, como sí hace
  `analizarFechas` en Resumen.
